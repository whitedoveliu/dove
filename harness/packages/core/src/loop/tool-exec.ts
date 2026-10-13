/**
 * 工具执行管线（T3.3）：可见性拦截 → 调用修复 → 审批 → 执行（超时 + try/catch）→ 输出预算 → 回执。
 * 纪律：任何工具内部抛错都不许冒泡到主循环（一律变结构化结果交还模型）；结果按**调用顺序**回填。
 */
import { resolve, normalize, sep } from "node:path";
import type { Tool, ToolContext, ToolAccesses, ApprovalRequest, ApprovalResponse } from "../tools/types.ts";
import { applyBudget } from "../tools/budget.ts";
import { repairToolCall } from "../tools/repair-call.ts";
import { classifyLocally, buildApprovalRequest } from "../tools/approval.ts";
import { rememberSessionRule, sessionRuleDecision, type ApprovalResponseRemembered, type RuleStorePort } from "../tools/rule-pattern.ts";
import type { ToolCallPayload } from "../providers/types.ts";
import { TOOL_TIMEOUT_MS, approvalTimeoutMs, humanDuration, SCHEDULER_DEFAULT_SERIAL } from "../constants.ts";

export interface ExecOutcome {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  ok: boolean;
  output?: unknown;
  errorText?: string;
  spillPath?: string;
  denied?: boolean;
  durationMs: number;
  /** 审批事件（如果有） */
  approval?: { request: ApprovalRequest; response: ApprovalResponse };
}

export type ApprovalResolver = (req: ApprovalRequest, toolCallId: string) => Promise<ApprovalResponse>;
export type ClassifierFn = (cmd: string) => Promise<ApprovalRequest | null>;

export interface ExecDeps {
  tools: Map<string, Tool>;
  ctxBase: Omit<ToolContext, "toolCallId" | "requestApproval">;
  resolveApproval: ApprovalResolver;
  /** LLM 审批分类器（可选；缺失时保守要权限） */
  classifier?: ClassifierFn;
  timeoutMs?: number;
  onApprovalNeeded?: (toolCallId: string, req: ApprovalRequest) => void;
  /** 权限模式：full 时不审批任何操作（见 tools/approval.ts 的 PermissionMode） */
  permissionMode?: import("../tools/approval.ts").PermissionMode;
  /** 线程存储（可选）—— 会话级「同意并记住」的落点；没传时规则匹配/写入整体退化（不报错）。
   *  接线不用改 wire.ts：buildExecDeps 的 execOverrides 透传 ExecDeps 顶层字段。 */
  store?: RuleStorePort;
  /**
   * 「看得见但不可执行」（exposure=visible 的线程裁剪）：返回给模型看的拦截理由 → 直接拦下。
   * 文案必须明说「不是工具不存在」（见 agent/tool-policy.ts 的 executionBlockedReason）——
   * 工具还在 wire 上，模型能读到它，含糊的说法只会让它去 ToolSearch 里反复找。
   */
  blockedFromExecution?: (name: string) => string | undefined;
}

/** 把 provider 给的原始调用修复成可用调用；修不了返回 null */
export function prepareCall(
  call: ToolCallPayload,
  tools: Map<string, Tool>,
): { tool: Tool; name: string; args: Record<string, unknown>; repaired: boolean } | { error: string } {
  const rawArgs = (() => {
    try { return JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; }
    catch { return null; }
  })();
  const fixed = repairToolCall(call.function.name, rawArgs ?? call.function.arguments, [...tools.values()]);
  if (!fixed) {
    return { error: `未知工具 "${call.function.name}"，且无法模糊匹配到已有工具。可用工具：${[...tools.keys()].slice(0, 20).join(", ")}` };
  }
  const tool = tools.get(fixed.name);
  if (!tool) return { error: `工具 ${fixed.name} 不存在` };
  return { tool, name: fixed.name, args: fixed.args ?? {}, repaired: fixed.name !== call.function.name };
}

// ── 审批策略链 ─────────────────────────────────────────
/** 一条策略给出的结论；undefined = 交给下一条 */
type Decision = "allow" | "deny" | "ask";
interface Outcome {
  decision: Decision;
  /** ask 时用；不给则按「允许执行 <工具>？」构造 */
  request?: ApprovalRequest;
  /** deny 时给用户看的理由 */
  denyReason?: string;
  /** 命中的规则串（会话规则才有），只用于诊断 */
  rule?: string;
}
interface StrategyCtx { tool: Tool; args: Record<string, unknown>; toolCallId: string; deps: ExecDeps }
interface Strategy {
  /** 策略名会进 tool:approval_decision 事件 —— 线上排查「这条为什么没问」全靠它 */
  name: string;
  run: (c: StrategyCtx) => Outcome | undefined | Promise<Outcome | undefined>;
}

/** 工具自带的兜底请求（always 档、以及分类器缺席时的保守请求） */
function toolRequest(tool: Tool, args: Record<string, unknown>): ApprovalRequest {
  return { title: `允许执行 ${tool.name}？`, message: JSON.stringify(args).slice(0, 600), riskLevel: "medium" };
}
/** 从参数里取命令串（Bash 用 command，个别工具用 cmd） */
function commandOf(args: Record<string, unknown>): string {
  return typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
}

/** 有序策略表：**第一条给出结论的生效**（返回 undefined 交给下一条）。顺序即语义，别随手重排：
 *  full-access → auto 分类器 → 会话规则 → always 问 → 本地启发式 → 无需审批档 → 兜底问。 */
let strategiesCache: Strategy[] | undefined;
function approvalStrategies(): Strategy[] {
  return (strategiesCache ??= [
    { name: "full-access-allow", run: (c) => (c.deps.permissionMode === "danger-full-access" ? { decision: "allow" } : undefined) },
    {
      name: "auto-mode-classifier",
      // auto（实验）：无沙箱，但**每次**调用都让分类器审一遍 —— 不看本地启发式。
      // ⚠️ fail-safe 而不是 fail-open：没有分类器 / 分类器抛错时**要审批**。这里踩过 —— 分类器
      //    只声明没实现，而当时的写法是「没有分类器就放行」：auto 表面说「每次审一遍」、实际**全放行**。
      run: async (c) => {
        if (c.deps.permissionMode !== "auto") return undefined;
        const cmd = commandOf(c.args);
        if (!cmd) return { decision: "allow" };      // 没有命令串（写类工具）→ auto 也管不着，放行
        let req: ApprovalRequest | null = null;
        if (c.deps.classifier) {
          try { req = await c.deps.classifier(cmd); }
          catch { req = buildApprovalRequest(cmd, "medium"); }   // 分类器炸了 → 保守要权限
        } else req = buildApprovalRequest(cmd, "medium");         // 没接分类器 → 保守要权限
        if (!req) return { decision: "allow" };      // 分类器明确说没问题 → 放行
        return { decision: "ask", request: req };
      },
    },
    {
      name: "session-rule",    // 命中用户明确记住的规则（按「后记的优先」倒序匹配）
      run: (c) => {
        if (!c.deps.store) return undefined;
        const hit = sessionRuleDecision(c.deps.store, c.deps.ctxBase.threadId, c.tool.name, c.args, c.tool, c.deps.ctxBase.workdir);
        return hit ? { decision: hit.decision, rule: hit.rule, denyReason: "会话规则" } : undefined;
      },
    },
    {
      name: "tool-always-ask",
      // 工具声明了 always → 每次都问。⚠️ 必须走 onApprovalNeeded 通知：通知不发出去，界面/日志
      // 就不知道有人在等，只能干等到 DOVE_APPROVAL_TIMEOUT_MS（5 分钟）自动拒绝 —— 用户从没看见弹窗。
      run: (c) => (c.tool.approval === "always" ? { decision: "ask", request: toolRequest(c.tool, c.args) } : undefined),
    },
    {
      name: "local-heuristic",
      // 只对**带命令**的工具做本地规则；没有命令串就交棒给下一条
      // （这是 Write/Edit 的必经之路：它们标了 heuristic 却只接受 file_path/content，没有 command）。
      run: async (c) => {
        if (c.tool.approval !== "heuristic") return undefined;
        const cmd = commandOf(c.args);
        if (!cmd) return undefined;
        const local = classifyLocally(cmd, c.deps.ctxBase.workdir);
        if (local === "safe" || local === "low") return { decision: "allow" };
        let req: ApprovalRequest | null = local === "medium" ? buildApprovalRequest(cmd, "medium") : null;
        if (!req && c.deps.classifier) { try { req = await c.deps.classifier(cmd); } catch { req = null; } }
        if (!req) req = buildApprovalRequest(cmd, "medium");   // 兜底：一律要权限
        return { decision: "ask", request: req };
      },
    },
    {
      name: "tool-never-allow",
      // never 档：工具自己声明「不用审批」→ 放行。
      // ⚠️ 第二半（heuristic 却没有 command）**是刻意保留**的既有行为，别改成「问一句」：Write/Edit
      //    的档位就是 heuristic、参数里从来没有 command，写侧安全靠 resolveInsideWorkspace 把路径锁在
      //    工作区内（见 builtin/util.ts 的踩坑史），不靠审批。这里必须放行，否则每个 Write/Edit 都弹窗。
      run: (c) => {
        if (c.tool.approval === "never") return { decision: "allow" };
        // 只对**声明了参数模式**的工具放行（Write/Edit 的参数语义由它自己写清）；没声明 approvalRule
        // 的启发式工具可能把命令塞在任意字段里 —— 那些一律不放行，避免变成「猜不到就放」。
        if (c.tool.approval === "heuristic" && c.tool.approvalRule && !commandOf(c.args)) return { decision: "allow" };
        return undefined;
      },
    },
    { name: "fallback-ask", run: (c) => ({ decision: "ask", request: toolRequest(c.tool, c.args) }) },
  ]);
}

/** 决定 → 最终回执；ask 在这里变成真正的阻塞等待 */
async function finishApproval(out: Outcome, c: StrategyCtx): Promise<{ needed: boolean; request?: ApprovalRequest; response?: ApprovalResponse }> {
  if (out.decision === "allow") return { needed: false };
  if (out.decision === "deny") {
    // 保持 agent/pending.ts 的既有措辞类别：reason="user" → 工具结果说「用户拒绝了这次操作」。
    // 区别只是这次拒绝是**记住的规则**代用户表的态，denyReason 写清是哪条规则。
    return { needed: true, response: { approved: false, reason: "user", decision: "deny", denyReason: out.denyReason } };
  }
  const req = out.request ?? toolRequest(c.tool, c.args);
  c.deps.onApprovalNeeded?.(c.toolCallId, req);
  const response = await c.deps.resolveApproval(req, c.toolCallId);
  // 「同意并记住」→ 写会话规则。**只在 remember === true 时写**：默认不问自记 = 偷偷扩大授权。
  if ((response as ApprovalResponseRemembered).remember === true && c.deps.store) {
    rememberSessionRule(c.deps.store, c.deps.ctxBase.threadId, c.tool.name, c.args, c.tool, response.approved ? "allow" : "deny");
  }
  return { needed: true, request: req, response };
}

async function decideApproval(
  tool: Tool, args: Record<string, unknown>, deps: ExecDeps, toolCallId: string,
): Promise<{ needed: boolean; request?: ApprovalRequest; response?: ApprovalResponse }> {
  const ctx: StrategyCtx = { tool, args, toolCallId, deps };
  let out: Outcome | undefined; let by = "";
  for (const s of approvalStrategies()) { out = await s.run(ctx); if (out) { by = s.name; break; } }   // 第一条给出结论的生效
  // 诊断：这条是**哪条策略**决定的。以前这里是一串 if，出问题只能靠 printf 猜。
  try {
    deps.ctxBase.emit("tool:approval_decision", { toolCallId, tool: tool.name, by, decision: out?.decision ?? "allow", rule: out?.rule });
  } catch { /* 事件发不出去不影响审批本身 */ }
  return await finishApproval(out ?? { decision: "ask" }, ctx);
}

export async function executeOne(call: ToolCallPayload, deps: ExecDeps): Promise<ExecOutcome> {
  const started = Date.now();
  // 「看得见但不可执行」（exposure 轴）：必须在 prepareCall **之前**拦 —— 被裁的工具还在工具表里，
  // prepareCall 会把它当成一次正常调用修好，再往下就是审批 + 真执行。也**不要**置 denied：
  // 那是喂闸门③（权限续跑）的，见 gates.ts 里同一句警告（hook 拦下的调用也只留 ok:false + errorText）。
  const noExec = deps.blockedFromExecution?.(call.function.name);
  if (noExec) return { toolCallId: call.id, toolName: call.function.name, input: {}, ok: false, errorText: noExec, durationMs: 0 };
  const prepared = prepareCall(call, deps.tools);
  if ("error" in prepared) {
    return { toolCallId: call.id, toolName: call.function.name, input: {}, ok: false, errorText: prepared.error, durationMs: Date.now() - started };
  }
  const { tool, name, args } = prepared;
  // 名字修复会把别名还原成被拦的真名（shell/exec → Bash、bash → Bash）—— 修完要再问一次
  const noExecFixed = name === call.function.name ? undefined : deps.blockedFromExecution?.(name);
  if (noExecFixed) return { toolCallId: call.id, toolName: name, input: args, ok: false, errorText: noExecFixed, durationMs: 0 };
  const appr = await decideApproval(tool, args, deps, call.id);
  if (appr.needed && !appr.response?.approved) {
    const reason = appr.response?.reason;
    // 超时要**说清等了多久**：原来只有一句「审批超时」，用户回来只看到「Bash 失败」。
    const waitedMs = appr.response?.timeoutMs ?? approvalTimeoutMs();
    const text = reason === "timeout"
      ? `[权限] 等待审批超时（${humanDuration(waitedMs)}），命令已被自动拒绝。` +
        "没有人处理这次审批请求；想等久一点可以设置环境变量 DOVE_APPROVAL_TIMEOUT_MS（毫秒）。"
      : reason === "no-window"
        ? "[权限] 没有可用的审批窗口（界面没连上），命令已被自动拒绝。"
        : "[权限] 用户拒绝了这次操作。";
    if (reason === "timeout") {   // 超时不静默：单独发事件，面板/日志能显示成一条明确提示
      try {
        deps.ctxBase.emit("tool:approval_timeout", { toolCallId: call.id, tool: name, timeoutMs: waitedMs, message: text });
      } catch { /* 事件发不出去不影响结果 */ }
    }
    return {
      toolCallId: call.id, toolName: name, input: args, ok: false, errorText: text, denied: true,
      durationMs: Date.now() - started, approval: appr.request ? { request: appr.request, response: appr.response! } : undefined,
    };
  }

  // 执行（超时 + 全包 try/catch）
  const ctx: ToolContext = { ...deps.ctxBase, toolCallId: call.id, requestApproval: deps.resolveApproval };
  const timeout = tool.timeoutMs ?? deps.timeoutMs ?? TOOL_TIMEOUT_MS;
  let raw: unknown; let ok = true; let errorText: string | undefined;
  // ⚠️ 超时定时器**必须**在工具结束时清掉：原来那个裸 setTimeout 没人清，每次调用都给事件循环留一个最长
  //    10 分钟（TOOL_TIMEOUT_MS）的把手，node --test / CLI 跑完退不掉。也不能改 unref()（超时就不再兜底）。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race([
      tool.execute(args, ctx),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`工具 ${name} 超时（${timeout}ms）`)), timeout); }),
    ]);
  } catch (e) {
    ok = false;
    errorText = e instanceof Error ? e.message : String(e);
    raw = { error: errorText };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // 输出预算（这里也必须吞错：预算处理失败不能把已经跑完的工具结果整个丢掉）
  let output = raw; let spillPath: string | undefined;
  try {
    const b = await applyBudget(tool, raw, deps.ctxBase.workdir, call.id);
    output = b.result; spillPath = b.spillPath;
  } catch (e) { output = { error: "输出预算处理失败：" + (e instanceof Error ? e.message : String(e)) }; }

  return {
    toolCallId: call.id, toolName: name, input: args, ok, output, errorText, spillPath, durationMs: Date.now() - started,
    approval: appr.request && appr.response ? { request: appr.request, response: appr.response } : undefined,
  };
}

// ── 批次调度：路径冲突图 ───────────────────────────────
interface AccessPath {
  path: string;       // 绝对路径、normalize、大小写不敏感（macOS 默认）、去尾部路径分隔符
  write: boolean;     // 纯读：只有**双方都是纯读**才允许重叠
  recursive: boolean; // 目录读/递归搜：覆盖其下所有子路径
}

/** ⚠️ 没声明 accesses 的工具一律按 all 处理（MCP / 用户自定义工具走这条）：命令语义不可静态判定时**保守串行**是唯一安全解，Bash / TerminalSend 也故意不声明。 */
function parseAccesses(tool: Tool | undefined, args: Record<string, unknown>, workdir: string): AccessPath[] | "all" {
  if (!tool?.accesses) return "all";
  let decl: ToolAccesses;
  try { decl = tool.accesses(args, workdir); } catch { return "all"; }
  if (!decl || decl.kind !== "paths" || !Array.isArray(decl.paths) || decl.paths.length === 0) return "all";
  const out: AccessPath[] = [];
  for (const a of decl.paths) {
    if (!a || typeof a.path !== "string" || !a.path) continue;
    // 先解析成绝对路径再 normalize；下面的去尾分隔符保住根 "/"："/a/b/" 与 "/a/b" 是同一条
    let abs = normalize(a.path.startsWith("/") ? a.path : resolve(workdir, a.path));
    while (abs.length > 1 && abs.endsWith(sep)) abs = abs.slice(0, -1);
    out.push({
      path: abs.toLowerCase(),                       // macOS 文件系统默认大小写不敏感
      write: a.operation === "write" || a.operation === "readwrite",
      recursive: a.recursive === true,
    });
  }
  return out.length > 0 ? out : "all";
}

/** p 是否落在 dir 之内（含 dir 自身） */
function within(p: string, dir: string): boolean {
  if (p === dir) return true;
  // ⚠️ 不能裸用 startsWith："/a/bc".startsWith("/a/b") 是 true，会把两个完全不同的目录判成冲突（反向也危险）。
  return p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function overlaps(a: AccessPath, b: AccessPath): boolean {
  if (a.path === b.path) return true;
  return (a.recursive && within(b.path, a.path)) || (b.recursive && within(a.path, b.path));
}

function conflicts(x: AccessPath[] | "all", y: AccessPath[] | "all"): boolean {
  if (x === "all" || y === "all") return SCHEDULER_DEFAULT_SERIAL;
  for (const a of x) for (const b of y) {
    if (!a.write && !b.write) continue;    // 双方都是纯读 → 永不冲突（重叠也不冲突）
    if (overlaps(a, b)) return true;
  }
  return false;
}

/**
 * 调度整批 —— **一个全局调度器**，不是按 accesses 签名分桶各跑各的（分桶会漏：读/写的签名本就不同，
 * 分桶后被当成互不相干并行启动，实测同路径的写和读同时开跑）。
 * ⚠️ 这里修的是老实现那个真 bug：exclusiveChain = chain.then(...) 写在 forEach 里，微任务
 *    **同步就排上了**，而并行组是 forEach 跑完才启动 —— 注释里写的「写类独占」是假的。
 */
async function scheduleAll(
  n: number, accesses: (AccessPath[] | "all")[], deps: ExecDeps, calls: ToolCallPayload[], results: (ExecOutcome | undefined)[],
): Promise<void> {
  if (n === 0) return;
  // 两张表都存「索引 + 它自己的 accesses」：⚠️ 不能只用 Set<number> 再回查 accesses[i] 去比较 ——
  //    accesses[i] 是数组，引用比较会把两个内容相同的路径集合判成「不同」（同路径的读和写会同时开跑，实测）。
  let running: { i: number; acc: AccessPath[] | "all" }[] = [];   // 运行中 + 已入队等着的
  let done: { i: number; acc: AccessPath[] | "all" }[] = [];      // 已跑完的（只为判断「全都出终态了」）
  let launch: () => void = () => { /* 由下面的 Promise 构造器赋值 */ };
  const preDone = results.filter((r) => r !== undefined).length;  // 进调度前就失败（修不好）的调用
  await new Promise<void>((settle) => {
    launch = () => {
      // 按**提交顺序**逐个准入。四条判据，缺一条就退化成「并行乱跑」或「永久锁死」：
      //   ① 已有终态 → 跳过（含修不好的调用）；② 已在 running/done → 跳过（少了它会启动第二次）；
      //   ③ 与更早入队、仍在 running 里等的任务不冲突（保证提交顺序）；④ 与运行中的不冲突。
      // ⚠️ 「已经跑完的更早任务」不算判据：它已结束，再挡着会把后面那个调用永久锁死（实测：同路径的写再也没启动过）。
      for (let i = 0; i < n; i++) {
        if (results[i] !== undefined) continue;
        if (running.some((r) => r.i === i) || done.some((r) => r.i === i)) continue;
        const acc = accesses[i]!;
        const earlier = (r: { i: number; acc: AccessPath[] | "all" }) => r.i < i && conflicts(acc, r.acc);
        if (running.some(earlier)) continue;
        if (running.some((r) => conflicts(acc, r.acc))) continue;
        running.push({ i, acc });
        void (async () => {
          try { results[i] = await executeOne(calls[i]!, deps); }
          catch (e) {
            // executeOne 理论上不抛；真抛了也不能让批次悬着（悬着 = 后面所有调用永不启动）
            results[i] = { toolCallId: calls[i]!.id, toolName: calls[i]!.function.name, input: {}, ok: false, errorText: "调度失败：" + (e instanceof Error ? e.message : String(e)), durationMs: 0 };
          } finally {
            done = [...done, { i, acc }];
            running = running.filter((r) => r.i !== i);
            // ⚠️ 重扫必须**无条件**发生（不能写成「只在还有任务在跑时重扫」）：一个任务结束时
            //    可能正好把某个被挡住的调用解锁，而那一刻 running 恰好空了 —— 只在那时重扫，
            //    解锁的那个就永远没人再问一次（实测：同路径的写再也没跑起来）。
            if (running.length === 0 && done.length + preDone >= n) settle(); else launch();
          }
        })();
      }
      // ⚠️ 收尾检查：这一趟**什么都没启动**时必须在这里判定批次结束 —— 所有调用都在 prepare 阶段出了
      //    终态（preDone === n）时，循环里每个 i 都被第一行跳过，一个任务都不会启动，而 settle 只挂在
      //    「启动过的任务」的 finally 里 → 永不 settle（实测：只读线程里被裁掉的 RunScript 让整轮挂死）。
      if (running.length === 0 && done.length + preDone >= n) settle();
    };
    launch();
  });
}

/** 路径冲突调度：结果按传入顺序返回（= 模型给出的调用顺序），执行按冲突图准入 */
export async function executeBatch(calls: ToolCallPayload[], deps: ExecDeps): Promise<ExecOutcome[]> {
  const results = new Array<ExecOutcome | undefined>(calls.length);
  const accesses: (AccessPath[] | "all")[] = [];
  for (let i = 0; i < calls.length; i++) {
    // 被策略拦下的调用不占调度位（它不会执行，也就没有 accesses 可谈）
    const noExec = deps.blockedFromExecution?.(calls[i]!.function.name);
    if (noExec) { results[i] = { toolCallId: calls[i]!.id, toolName: calls[i]!.function.name, input: {}, ok: false, errorText: noExec, durationMs: 0 }; accesses.push("all"); continue; }
    const prep = prepareCall(calls[i]!, deps.tools);
    if ("error" in prep) {
      // 修不好的调用直接出终态，不占调度位（旧实现里它进了串行链，白等一圈）
      results[i] = { toolCallId: calls[i]!.id, toolName: calls[i]!.function.name, input: {}, ok: false, errorText: prep.error, durationMs: 0 };
      accesses.push("all");
      continue;
    }
    accesses.push(parseAccesses(prep.tool, prep.args, deps.ctxBase.workdir));
  }
  await scheduleAll(calls.length, accesses, deps, calls, results);
  for (let i = 0; i < results.length; i++) {
    results[i] ??= { toolCallId: calls[i]!.id, toolName: calls[i]!.function.name, input: {}, ok: false, errorText: "内部调度错误：该调用没有被执行", durationMs: 0 };
  }
  return results as ExecOutcome[];
}
