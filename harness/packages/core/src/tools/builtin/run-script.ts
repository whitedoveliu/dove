/**
 * RunScript —— PTC（Programmatic Tool Calling，Alma §3.4）
 *
 * 模型不逐个调工具，而是写一段 TS/JS 在**本地 Node 子进程**里跑，脚本内用
 * doveTool(name, args) 按名字调用其它工具 —— 形态照抄 Alma §3.4.2 的 preamble。
 *
 * 解决的真实痛点：一次深度研究回合跑了 76 步 / 14 分钟 / 5.7M input tokens，
 * 其中同一段 python 脚本重复跑了 4 次。循环、过滤、试算这类活应该写在脚本里，
 * 而不是让模型用「再把同样的工具调一遍」当思考。
 *
 * ⚠️ 安全口径（**能力边界，不是安全沙箱**）：
 *   · 脚本就是本地代码执行，和 Bash 同一信任级别 —— 所以本工具 approval="always"，
 *     每次都要用户点头；Home / 只读线程的工具表里**根本没有它**（见 tool-policy.ts）。
 *   · 脚本内每次 doveTool 都**回到内核**执行（POST /api/tools/invoke），走**同一条审批链**：
 *     需要审批的工具照常弹窗，绝不因为「是脚本发的」而放行。
 *   · 故意**不注入** Alma preamble 里的 sh()（无白名单的 execSync）—— 那是绕过审批的洞。
 *     脚本里要执行命令必须走 doveTool("Bash", …)，逐条回内核。
 *   · 环境变量白名单，且**显式剔掉 DOVE_API_KEY**；但 HOME 是放行的 —— 别当隔离用。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, S } from "../types.ts";
import type { Tool, ToolContext } from "../types.ts";
import { guarded, str, optStr, optNum, clampNum } from "./util.ts";
import {
  PTC_DEFAULT_TIMEOUT_MS, PTC_MAX_TIMEOUT_MS, PTC_PARENT_TIMEOUT_MS,
  PTC_INVOKE_TIMEOUT_MS, PTC_STREAM_HARD_CAP,
} from "../../constants.ts";

/** 脚本内发起的调用在审批弹窗里的前缀：用户要能一眼看出「这条是脚本发的」 */
export const PTC_APPROVAL_PREFIX = "【RunScript 脚本内发起】";

/** 脚本内一次调用的结果（形状对齐 loop 的 ExecOutcome —— tools 层不能 import loop） */
export interface PtcCallOutcome { ok: boolean; output?: unknown; errorText?: string }

/** 由 agent 层注入：真正把调用打回工具执行管线（审批 + 预算 + 事件都在那边） */
export type PtcInvokeFn = (name: string, args: Record<string, unknown>, callId: string) => Promise<PtcCallOutcome>;

interface PtcBinding { tools: Map<string, Tool>; invoke: PtcInvokeFn }
interface PtcCall { tool: string; ok: boolean; ms: number; error?: string; chars: number; pending?: boolean }
interface PtcSession { id: string; token: string; binding: PtcBinding; startedAt: number; calls: PtcCall[] }

/**
 * 按线程绑定「本轮的 execDeps + 按策略裁过的工具表」。
 *
 * 为什么用线程 id 而不是对象身份：RunScript 的 ctx 是本轮 ctxBase 的浅拷贝，子代理还会
 * 再拷一层（subagent-host 的 #childDeps），对象身份对不上，而线程 id 在两层里都不变。
 * 为什么要限长：cron / heartbeat 每跑一次就新建线程，不限长就是随线程数无限涨。
 */
const BINDINGS = new Map<string, PtcBinding>();
const BINDING_CAP = 64;

export function bindPtcRuntime(threadId: string, binding: PtcBinding): void {
  BINDINGS.delete(threadId);
  BINDINGS.set(threadId, binding);
  while (BINDINGS.size > BINDING_CAP) BINDINGS.delete(BINDINGS.keys().next().value as string);
}

/** 活着的脚本会话：session+token 是脚本回调内核的唯一凭据（见 server/routes-tools.ts） */
const SESSIONS = new Map<string, PtcSession>();

/** 开一次脚本会话。**必须在 spawn 之前**开、脚本退出立刻关：关掉后任何请求都被拒
 *（否则脚本残留的后台定时器还能拿着有效凭据操作内核） */
function openSession(threadId: string): { session: PtcSession; error?: string } {
  const binding = BINDINGS.get(threadId);
  if (!binding) {
    return {
      session: undefined as never,
      error: "PTC_UNAVAILABLE：RunScript 没有拿到本轮的运行时（脚本要靠内核执行工具）。" +
        "只可能在 attachRunServices 没跑到的调用路径上出现；正常回合里不该看到这条。",
    };
  }
  const session: PtcSession = {
    id: "ptc_" + randomUUID().replace(/-/g, "").slice(0, 16),
    token: randomUUID().replace(/-/g, ""),
    binding, startedAt: Date.now(), calls: [],
  };
  SESSIONS.set(session.id, session);
  return { session };
}

/** 定长比较：token 是凭据，别用 === 把长度/前缀泄给时序 */
function tokenOk(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** GET /api/tools/list 的底座：返回本次会话能调到的工具（不做 layer 归类，那个在 registry） */
export function ptcSessionTools(sessionId: string, token: string):
  { ok: true; tools: Tool[] } | { ok: false; error: string; auth?: true } {
  const s = sessionId ? SESSIONS.get(sessionId) : undefined;
  if (!s || !token || !tokenOk(s.token, token)) return { ok: false, auth: true, error: "PTC_SESSION_INVALID：session/token 不匹配（脚本会话已关闭，或凭据不对）" };
  // ⚠️ RunScript 自己**不上这张表**：下面 ptcSessionInvoke 拒绝脚本里再开脚本（嵌套子进程
  //    的超时/审批会串成一团）。表里留着它 = 模型照着 listTools() 写 doveTool('RunScript')
  //    再在运行时撞墙 —— 工具表要如实描述能力，不能既要拒绝又不要广告。
  return { ok: true, tools: [...s.binding.tools.values()].filter((t) => t.name !== "RunScript") };
}

/**
 * POST /api/tools/invoke 的底座：把脚本里的一次 doveTool 送回工具执行管线。
 *
 * 这里**只做会话校验与记账**，真正的执行是 agent 层注入的 invoke（走 executeOne：
 * 审批、输出预算、事件上报一个都不少）。为什么不在这里直接执行：tools 层不能 import loop。
 */
export async function ptcSessionInvoke(
  sessionId: string, token: string, name: string, args: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; auth?: true }> {
  const s = sessionId ? SESSIONS.get(sessionId) : undefined;
  // auth 标记是**给路由用的**：凭据不对 ≠ 工具执行失败。前者是 403（别说这工具存不存在），
  // 后者回 200 + {error} 让脚本统一 throw。混在一起会让「无凭据探测」看起来像「调用成功」。
  if (!s || !token || !tokenOk(s.token, token)) return { ok: false, auth: true, error: "PTC_SESSION_INVALID：session/token 不匹配（脚本会话已关闭，或凭据不对）" };
  if (!name || typeof name !== "string") return { ok: false, error: "缺少工具名 name" };
  // 不开递归：脚本里再开脚本 = 嵌套子进程，超时/审批都会串成一团
  if (name === "RunScript") return { ok: false, error: "脚本里不能再调 RunScript（不支持嵌套脚本）；要分步就写多个脚本调用。" };
  if (!s.binding.tools.has(name)) {
    return { ok: false, error: "工具 " + name + " 不在本线程的工具表里（可能被线程策略裁掉、或名字拼错）。用 listTools() 看可用清单。" };
  }
  // ⚠️ 先入账再等。脚本可能**等不到结果就自己退出**（它自己那条 doveTool 的 HTTP 等待上限
  //    比内核执行短），而 HTTP 断开**不会取消**内核里那次执行。要是只在拿到结果后记账，
  //    toolCalls 会显示「这次脚本什么都没调过」—— 模型据此以为副作用没发生，实际可能已经生效。
  const call: PtcCall = { tool: name, ok: false, ms: 0, chars: 0, pending: true };
  s.calls.push(call);
  const started = Date.now();
  const outcome = await s.binding.invoke(name, (args && typeof args === "object" && !Array.isArray(args))
    ? (args as Record<string, unknown>) : {}, "ptc_" + randomUUID().slice(0, 8));
  call.pending = false;
  call.ms = Date.now() - started;
  call.ok = outcome.ok;
  if (!outcome.ok) call.error = String(outcome.errorText ?? "工具执行失败").slice(0, 300);
  call.chars = JSON.stringify(outcome.ok ? (outcome.output ?? null) : (outcome.errorText ?? "")).length;
  return outcome.ok ? { ok: true, result: outcome.output } : { ok: false, error: call.error! };
}

// ── 注入到脚本头部的 preamble（形状照抄 Alma §3.4.2，almaTool → doveTool） ──
function ptcPreamble(baseUrl: string): string {
  // 注意：下面是**脚本代码**不是 TS 模板，别在这里用反引号或 ${}
  return `// ===== Dove PTC preamble（RunScript 自动注入，别删）=====
// 能力边界，不是安全沙箱：脚本 = 本地代码执行，和 Bash 同一个信任级别。
import { execSync as __doveShell } from 'node:child_process';
const __DOVE_API = process.env.DOVE_PTC_API_URL || '${baseUrl}';
const __DOVE_SESSION = process.env.DOVE_PTC_SESSION || '';
const __DOVE_TOKEN = process.env.DOVE_PTC_TOKEN || '';
const __DOVE_BIN = process.env.DOVE_BIN || 'dove';
const __DOVE_INVOKE_TIMEOUT_MS = Number(process.env.DOVE_PTC_INVOKE_TIMEOUT_MS || ${PTC_INVOKE_TIMEOUT_MS});
/** 按名字调一个 dove 工具。它会回到内核执行：审批、输出预算、事件都在那边走一遍。 */
async function doveTool(name, args = {}) {
  let resp;
  try {
    resp = await fetch(__DOVE_API + '/api/tools/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args, session: __DOVE_SESSION, token: __DOVE_TOKEN }),
      signal: AbortSignal.timeout(__DOVE_INVOKE_TIMEOUT_MS),
    });
  } catch (e) {
    const name_ = (e && e.name) || '';
    if (name_ === 'TimeoutError' || name_ === 'AbortError') {
      throw new Error('doveTool(' + name + ') 等内核超时（' + __DOVE_INVOKE_TIMEOUT_MS + 'ms）。需要审批的工具在等人点「允许」时会一直阻塞：请让用户处理审批，或调大 RunScript 的 timeout_ms 再试。'
        + '注意「脚本不再等」不等于「内核里那次调用被取消」—— HTTP 断开不会取消它，有副作用的工具可能已经生效或还在跑，别当成没发生过。');
    }
    throw new Error('doveTool(' + name + ') 够不到内核 ' + __DOVE_API + '：' + String((e && e.message) || e));
  }
  let data = null;
  try { data = await resp.json(); } catch (e) { /* 非 JSON 响应下面统一报错 */ }
  if (!resp.ok || !data || data.error) {
    throw new Error('doveTool(' + name + ') failed: ' + ((data && data.error) || ('HTTP ' + resp.status)));
  }
  return data.result;
}
/** 枚举本次会话能调的工具，返回 [{ name, description, inputSchema, layer }]。 */
async function listTools() {
  const url = __DOVE_API + '/api/tools/list?session=' + encodeURIComponent(__DOVE_SESSION) + '&token=' + encodeURIComponent(__DOVE_TOKEN);
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok || (data && data.error)) throw new Error('listTools() failed: ' + ((data && data.error) || ('HTTP ' + resp.status)));
  return Array.isArray(data) ? data : (data && data.tools) || [];
}
/** 跑一条 dove CLI 子命令，例如 dove('version --json')。CLI 不可用时**明确抛错**，不静默跑空。 */
function dove(subcmd) {
  try {
    return __doveShell(__DOVE_BIN + ' ' + subcmd, {
      encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024,
      // 交互式子命令（chat / approve）会一直等输入：给个上限，超时明确报错，
      // 而不是把脚本挂死到被 timeout_ms 杀掉（那样脚本连一句解释都留不下）
      timeout: __DOVE_INVOKE_TIMEOUT_MS,
    });
  } catch (e) {
    const msg = String((e && e.message) || e) + String((e && e.stderr) || '');
    if ((e && e.code === 'ENOENT') || (e && e.status === 127) || /not found|No such file/i.test(msg)) {
      throw new Error('dove CLI 不可用：找不到命令 "' + __DOVE_BIN + '"。脚本里请改用 doveTool(name, args) 调内核工具。');
    }
    if (e && e.code === 'ETIMEDOUT') {
      throw new Error('dove CLI 子命令超时（' + __DOVE_INVOKE_TIMEOUT_MS + 'ms）：' + subcmd + '。交互式子命令（chat / approve）不要在这里跑。');
    }
    throw e;
  }
}
globalThis.doveTool = doveTool;
globalThis.listTools = listTools;
globalThis.dove = dove;
// 注意：这里**故意没有 sh()**。Alma 的 preamble 有个无白名单的 execSync 包装 ——
// 那是绕过审批直接执行任意命令的洞。dove 要求脚本里的命令走 doveTool('Bash', {...})，逐条回内核审批。
// ===== end preamble =====
`;
}

/** 本进程监听的端口（DOVE_PTC_API_URL 覆盖的是完整地址，端口仍从这里来） */
function kernelPort(): string {
  return process.env.DOVE_PORT ?? "8790";
}

/** 内核 API 的地址：内置的是 127.0.0.1 + 本进程监听的端口（DOVE_PTC_API_URL 可覆盖） */
function apiBaseUrl(): string {
  return process.env.DOVE_PTC_API_URL ?? "http://127.0.0.1:" + kernelPort();
}

/** shell 里的单参数引用（路径可能带空格；用单引号并把内部单引号转义成 '\'' ） */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * `dove` CLI 的调用前缀（脚本里的 dove(subcmd) 用它）。
 * 优先级：DOVE_BIN（显式覆盖）> 仓库自带的 harness/bin/dove.mjs > PATH 里的 `dove`。
 *
 * 为什么默认指向仓库自带那个：CLI 就在同一棵代码树里，而**全局 dove 不一定装过** —— 只认
 * PATH 的话，没 npm link 的机器上脚本里的 dove(...) 永远是「找不到命令」，能力等于没有；
 * 而 PATH 里那个同名 `dove` 也可能是**别的程序**，静默 exec 陌生命令比报错更糟。
 */
function cliPrefix(): string {
  if (process.env.DOVE_BIN) return process.env.DOVE_BIN;
  try {
    const bin = fileURLToPath(new URL("../../../../../bin/dove.mjs", import.meta.url));
    if (existsSync(bin)) return shellQuote(process.execPath) + " " + shellQuote(bin);
  } catch { /* 解析不出来就退 PATH */ }
  return "dove";
}

/** 环境白名单：Alma 同款（PATH/HOME/USER/SHELL/LANG/TERM）+ DOVE_*，凭据除外 */
const ENV_ALLOW = ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM"];
const ENV_DENY = new Set(["DOVE_API_KEY", "DOVE_TAVILY_API_KEY"]);

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("DOVE_") && !ENV_DENY.has(k) && v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

interface ChildRun {
  stdout: string; stderr: string; exitCode: number | null; signal: string | null;
  timedOut: boolean; overflow: boolean; durationMs: number; spawnError?: string;
}

function runNodeChild(scriptPath: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<ChildRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    // process.execPath = 当前跑内核的那个 node（Node 24 起原生剥类型，.ts 直接跑）
    const child = spawn(process.execPath, [scriptPath], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", overflow = false, timedOut = false, settled = false;
    const kill = (sig: NodeJS.Signals): void => { try { child.kill(sig); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 3000);
    }, timeoutMs);
    const onAbort = (): void => kill("SIGTERM");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const push = (which: "stdout" | "stderr", chunk: Buffer): void => {
      if ((which === "stdout" ? stdout : stderr).length >= PTC_STREAM_HARD_CAP) { overflow = true; return; }
      const next = (which === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (next.length > PTC_STREAM_HARD_CAP) overflow = true;
      const clipped = next.length > PTC_STREAM_HARD_CAP ? next.slice(0, PTC_STREAM_HARD_CAP) : next;
      if (which === "stdout") stdout = clipped; else stderr = clipped;
    };
    child.stdout?.on("data", (d: Buffer) => push("stdout", d));
    child.stderr?.on("data", (d: Buffer) => push("stderr", d));

    const done = (code: number | null, sig: string | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode: code, signal: sig, timedOut, overflow, durationMs: Date.now() - started, spawnError });
    };
    child.on("error", (e) => done(null, null, "启动失败：" + e.message));
    child.on("close", (code, sig) => done(code, sig));
  });
}

export const RunScriptTool = defineTool({
  name: "RunScript",
  description:
    "写一段 TypeScript/JavaScript 在本地 Node 子进程里跑，脚本内用 doveTool(name, args) 按名字调用其它工具。\n" +
    "什么时候用：一次要做 5 步以上（循环 / 过滤 / 试算 / 同一段逻辑跑好几遍）时 —— 比起一步步调工具，脚本里能直接写循环和判断，中途结果也不会灌进上下文。\n" +
    "脚本里可用的全局对象：doveTool(name, args)、listTools()、dove(subcmd)（本地 CLI，没上线会明确抛错）。\n" +
    "⚠️ 每次 doveTool 调用都**回到内核**执行：需要审批的工具照常弹窗 —— 脚本里没有绕过审批的通道（故意不提供 sh()）。\n" +
    `⚠️ 这是**能力边界，不是安全沙箱**：脚本本身就是本地代码执行，和 Bash 同一个信任级别，所以本工具每次调用都要你点头。\n` +
    "脚本目录在系统临时目录（cwd = 当前工作区），只能用 Node 内置模块 —— 不能 import npm 包；读写文件 / 跑命令请走 doveTool('Read'|'Grep'|'Write'|'Bash', …)。\n" +
    "输出超长会统一裁剪并落盘，结果里给存档路径（读它才能拿全）。",
  parameters: S.obj({
    code: S.str("脚本正文（TS/JS，ESM；开头会注入 preamble）"),
    description: S.str("这段脚本干什么（一句话，给人看）"),
    language: { type: "string", enum: ["typescript", "javascript"], description: "默认 typescript（Node 原生剥类型）" },
    timeout_ms: S.num("脚本超时毫秒（默认 " + PTC_DEFAULT_TIMEOUT_MS + "，最大 " + PTC_MAX_TIMEOUT_MS + "）"),
  }, ["code", "description"]),
  outputTier: "compact",
  // 和 Bash 同一个信任级别：每次都问，别靠启发式（args 里没有 command，启发式根本判不了）
  approval: "always",
  concurrencySafe: false,
  timeoutMs: PTC_PARENT_TIMEOUT_MS,
  execute: (input: Record<string, unknown>, ctx: ToolContext) => guarded(async () => {
    const code = str(input, "code");
    const description = str(input, "description");
    const language = optStr(input, "language") ?? "typescript";
    if (language !== "typescript" && language !== "javascript") {
      return { error: "language 只能是 typescript 或 javascript（收到 " + language + "）" };
    }
    const timeoutMs = clampNum(Math.floor(optNum(input, "timeout_ms") ?? PTC_DEFAULT_TIMEOUT_MS), 1000, PTC_MAX_TIMEOUT_MS);

    const opened = openSession(ctx.threadId);
    if (opened.error) return { error: opened.error };
    const session = opened.session;
    const baseUrl = apiBaseUrl();
    const dir = mkdtempSync(join(tmpdir(), "dove-ptc-"));
    const scriptPath = join(dir, language === "typescript" ? "script.ts" : "script.mjs");
    writeFileSync(scriptPath, ptcPreamble(baseUrl) + code);
    ctx.emit("tool:run-script", { toolCallId: ctx.toolCallId, description, scriptPath, language, timeoutMs });

    let run: ChildRun;
    try {
      run = await runNodeChild(scriptPath, ctx.workdir, childEnv({
        DOVE_PTC_API_URL: baseUrl,
        DOVE_PTC_SESSION: session.id,
        DOVE_PTC_TOKEN: session.token,
        // 让脚本在**被超时杀掉之前**先自己报「等内核等超时了」：留 2 秒余量
        DOVE_PTC_INVOKE_TIMEOUT_MS: String(Math.max(5000, Math.min(PTC_INVOKE_TIMEOUT_MS, timeoutMs - 2000))),
        // 端口必须**钉死成本进程监听的那个**：CLI 自己的发现顺序是
        // 「DOVE_PORT > ~/.dove/port > 扫 8790..8799」，不传就会在冒烟/多实例场景下
        // 打到一个**别的内核**上（最坏是用户的量产实例）—— 脚本以为在跟本回合对话，其实不是。
        DOVE_PORT: kernelPort(),
        DOVE_BIN: cliPrefix(),
      }), timeoutMs, ctx.signal);
    } finally {
      // ⚠️ 无论怎么退出都要关会话：脚本残留的后台定时器不能拿着有效凭据继续操作内核
      SESSIONS.delete(session.id);
    }

    const calls = session.calls;
    const note: string[] = [];
    if (run.timedOut) {
      note.push("超过 timeout_ms=" + timeoutMs + " 已被终止（SIGTERM→SIGKILL），脚本**没跑完**，下面是它死之前的输出。" +
        "长任务请调大 timeout_ms，或用 doveTool('Bash', {command, run_in_background:true}) 交给后台。");
    }
    // 这层截断发生在 budget 之前：存档文件里是**截断后**的内容，不是全量 —— 必须说清，
    // 否则模型会把后面那条「完整内容已存档」当成「我拿到全文了」。
    if (run.overflow) note.push("stdout/stderr 超过 " + PTC_STREAM_HARD_CAP + " 字符硬上限，已在生成侧截断（存档文件里也是截断后的，不是全量）。" +
      "要保留全量就让脚本自己写文件（doveTool('Write', …)）。");
    if (run.spawnError) note.push(run.spawnError);
    // 脚本放弃等待的调用：HTTP 断开不会取消内核里那次执行，所以这些**可能已经生效**。
    // 必须在 toolCalls / note 里留痕，否则模型会以为「没等到 = 没发生」。
    const pending = calls.filter((c) => c.pending);
    if (pending.length > 0) {
      for (const c of pending) c.error = "等内核超时放弃：脚本先退出了，内核里那次调用可能仍在执行、也可能已经生效。";
      note.push("有 " + pending.length + " 次调用（" + pending.map((c) => c.tool).join("、") +
        "）在脚本退出时还没回来：内核里可能仍在跑/已经生效，别当成没发生。要等久一点就调大 timeout_ms。");
    }
    if (calls.length === 0) {
      note.push("脚本没有调用任何 doveTool。要读文件 / 跑命令 / 查记忆都必须走 doveTool(name, args) —— 脚本里没有别的通道。");
    }
    note.push("脚本是本地代码执行（和 Bash 同一信任级别）；每次 doveTool 都回到内核、走同一条审批链，toolCalls 是这次的调用记录。" +
      "savedTokens = 这些中间结果**没进对话上下文**的字符数 ÷ 4 估算，不是 provider 的真实计费。脚本文件留在 " + scriptPath + "。");

    return {
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut || undefined,
      durationMs: run.durationMs,
      description,
      scriptPath,
      toolCalls: calls,
      savedTokens: Math.round(calls.reduce((n, c) => n + c.chars, 0) / 4),
      note: note.join(" "),
    };
  }),
});
