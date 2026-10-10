/**
 * 常驻终端会话注册表（TerminalOpen/Send/Read/Close/List 共用）
 *
 * 为什么是模块级单例（照 jobs.ts 的先例）：一个会话 = 一个活着的子进程 + 管道，
 * 是**进程内的 OS 资源**，不属于任何服务；注入一层只会多一个可能漏传的参数。
 * 隔离靠 threadId：只能看见/操作自己线程开的会话。缓冲/剥 ANSI 在 terminal-buffer.ts。
 *
 * 状态为什么保得住（验收真跑过的三条）：
 *  1) shell 只起一次（<shell> -i），命令写进**同一个进程**的 stdin ⇒ cd / export 天然保留；
 *  2) 提示符塞唯一哨兵 __DOVE_READY_<id>__，shell 每回到提示符就打一次；
 *  3) send 后等哨兵 → prompt；等不到 → timeout；进程先没了 → exit（给**原因**，不是布尔）。
 *
 * PTY：优先 /usr/bin/script -q /dev/null <shell> -i（macOS 自带）。
 * ⚠️ 实测（macOS + Node）：Node 的 stdio 管道是 socketpair，macOS 的 script 会对它调 tcgetattr
 *    并因 ENOTSUP 秒退（"tcgetattr/ioctl: Operation not supported on socket"）⇒ 先真起 PTY，
 *    1.5s 等不到哨兵就杀掉重开纯管道；实际模式写进 note，不假装有 PTY。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { basename } from "node:path";
import { errMsg, sleep } from "./util.ts";
import {
  MAX_BUFFER_CHARS, MAX_BUFFER_LINES, commitLines, countHits, newBuffer, resetBuffer, viewLines,
} from "./terminal-buffer.ts";
import type { LineBuffer } from "./terminal-buffer.ts";

export { MAX_BUFFER_CHARS, MAX_BUFFER_LINES, MAX_LINE_CHARS } from "./terminal-buffer.ts";
export const DEFAULT_WAIT_MS = 10_000;
export const MAX_WAIT_MS = 60_000;
export const IDLE_CLOSE_MS = 30 * 60 * 1000; // 空闲回收
export const KILL_GRACE_MS = 3000;           // SIGTERM → SIGKILL 宽限
export const DEFAULT_READ_LINES = 100;
const SIGKILL_WAIT_MS = 2000, SWEEP_MS = 60_000, SETTLE_MS = 300;
const PTY_PROBE_MS = 1500;                   // script 失败是秒退，不用等久
const PIPE_PROBE_MS = 8000;                  // 慢启动的 .zshrc 也够（只在 open 付一次）
const SCRIPT_BIN = "/usr/bin/script";

export type WaitReason = "prompt" | "timeout" | "exit";
export type SessionStatus = "ready" | "busy" | "exited";
interface Waiter { hitsAtStart: number; fire: (r: WaitReason) => void }

export interface TerminalSession {
  id: string; name: string; threadId: string; shell: string; cwd: string;
  pid: number; pty: boolean; child: ChildProcess; sentinel: string;
  running: boolean; exitCode: number | null; signal: string | null;
  buf: LineBuffer; hits: number; scanTail: string; ready: boolean; lastDataAt: number;
  busy: boolean; busyHits: number;                    // 在飞命令：一次只允许一个 send
  lastCommand?: string; lastActiveAt: number;
  waiters: Set<Waiter>; readyWaiters: Set<(ok: boolean) => void>;
}
export interface SessionSummary {
  session_id: string; name: string; pid: number; cwd: string; running: boolean;
  idle_ms: number; status: SessionStatus; pty: boolean; last_command?: string;
}
interface BaseOut { ok: boolean; error?: string; session_id?: string; note?: string }
export interface OpenResult { ok: boolean; session?: TerminalSession; note?: string; error?: string }
export interface SendOutcome extends BaseOut {
  output?: string; wait_reason?: WaitReason; session_status?: SessionStatus;
  truncated?: boolean; exit_code?: number | null;
}
export interface ReadOutcome extends BaseOut {
  text?: string; total_lines?: number; truncated?: boolean; dropped_lines?: number; returned?: number;
}
export interface CloseOutcome extends BaseOut { closed?: boolean }

const sessions = new Map<string, TerminalSession>();
let seq = 0;
let sweeper: NodeJS.Timeout | null = null;
let sweeperMs = 0;

const linesOf = (s: TerminalSession): string[] => viewLines(s.buf, s.sentinel);
const statusOf = (s: TerminalSession): SessionStatus => (!s.running ? "exited" : s.busy ? "busy" : "ready");
const lastText = (s: TerminalSession): string => linesOf(s).filter((l) => l.trim()).slice(-3).join(" / ").slice(0, 300);

// ── 进程 ───────────────────────────────────────────────
function pickShell(): string {
  for (const c of [process.env.DOVE_TERMINAL_SHELL, process.env.SHELL, "/bin/bash", "/bin/sh"]) {
    if (c && fs.existsSync(c)) return c;
  }
  return "/bin/sh";
}

/** 提示符初始化。zsh 要额外关 PROMPT_SP/PROMPT_CR 与 precmd 钩子，否则每次提示符前多一行 "%  "。 */
function initLine(shell: string, sentinel: string): string {
  const name = basename(shell);
  if (name === "zsh") return "PROMPT='" + sentinel + " '; RPROMPT=''; RPS1=''; unsetopt PROMPT_SP 2>/dev/null; precmd_functions=()";
  if (name === "bash") return "PS1='" + sentinel + " '; PROMPT_COMMAND=''";
  return "PS1='" + sentinel + " '; PROMPT='" + sentinel + " '";
}

function spawnShell(shell: string, cwd: string, sentinel: string, pty: boolean): ChildProcess {
  const env = { ...process.env, PS1: sentinel + " ", TERM: process.env.TERM || "xterm-256color", DOVE_TERMINAL: "1" };
  const opts = { cwd, env, stdio: ["pipe", "pipe", "pipe"] as const, detached: true };
  if (!pty) return spawn(shell, ["-i"], opts);
  // macOS: script -q /dev/null <cmd...>；Linux(util-linux): script -q -c "<cmd>" /dev/null
  const args = process.platform === "linux" ? ["-q", "-c", shell + " -i", "/dev/null"] : ["-q", "/dev/null", shell, "-i"];
  return spawn(SCRIPT_BIN, args, opts);
}

function createSession(o: { id: string; name: string; threadId: string; shell: string; cwd: string; sentinel: string; pty: boolean }): TerminalSession {
  const child = spawnShell(o.shell, o.cwd, o.sentinel, o.pty);
  const s: TerminalSession = {
    id: o.id, name: o.name, threadId: o.threadId, shell: o.shell, cwd: o.cwd, pid: child.pid ?? 0,
    pty: o.pty, child, sentinel: o.sentinel, running: true, exitCode: null, signal: null,
    buf: newBuffer(), hits: 0, scanTail: "", ready: false, lastDataAt: Date.now(), busy: false, busyHits: 0,
    lastActiveAt: Date.now(), waiters: new Set(), readyWaiters: new Set(),
  };
  child.stdout?.on("data", (d: Buffer) => ingest(s, d));
  child.stderr?.on("data", (d: Buffer) => ingest(s, d));
  child.on("error", (e) => { ingest(s, Buffer.from("\n[启动失败] " + e.message + "\n")); finish(s, null, null); });
  child.on("close", (code, signal) => finish(s, code, signal));
  try {
    if (o.pty) child.stdin?.write("stty -echo 2>/dev/null\n");   // PTY 会回显输入，关掉（管道无回显）
    child.stdin?.write(initLine(o.shell, o.sentinel) + "\n");
  } catch { /* 进程可能已经没了，按 exit 处理 */ }
  return s;
}

function ingest(s: TerminalSession, chunk: Buffer): void {
  const text = chunk.toString("utf8");
  s.lastDataAt = Date.now();
  // ① 哨兵计数：拼上尾巴再数，否则被 chunk 切成两半的哨兵会漏
  const scan = s.scanTail + text;
  const found = countHits(scan, s.sentinel);
  s.scanTail = scan.slice(Math.max(0, scan.length - (s.sentinel.length - 1)));
  if (found > 0) {
    s.hits += found;
    if (!s.ready) { s.ready = true; for (const w of [...s.readyWaiters]) w(true); s.readyWaiters.clear(); }
    if (s.busy && s.hits > s.busyHits) s.busy = false;    // 等待超时后迟到的哨兵：自动解除在飞
    for (const w of [...s.waiters]) if (s.hits > w.hitsAtStart) w.fire("prompt");
  }
  commitLines(s.buf, text, s.sentinel);   // ② 提交整行
}

/**
 * 等输出「静下来」：**哨兵到了不等于输出都到齐了**。实测两件事（真跑出来的）：
 *  ① zsh 启动时会把提示符打两遍（哨兵连着出现两次）⇒ 第一次 send 会被那个多余的哨兵提前判定完成；
 *  ② stdout / stderr 是两条管道，同一个提示符（stderr）可能先于命令输出（stdout）被读到。
 * 所以判定完成后先等一小段「没有新数据」再收尾；有持续输出（ping 之类）就按 maxMs 封顶。
 */
async function quiesce(s: TerminalSession, quietMs: number, maxMs = 700): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (Date.now() - s.lastDataAt >= quietMs) return;
    await sleep(25);
  }
}

function finish(s: TerminalSession, code: number | null, signal: string | null): void {
  s.running = false; s.exitCode = code; s.signal = signal; s.busy = false;
  for (const w of [...s.readyWaiters]) w(false);
  s.readyWaiters.clear();
  for (const w of [...s.waiters]) w.fire("exit");
  s.waiters.clear();
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** 杀**整个进程组**（detached:true ⇒ child 是组长，-pid 覆盖它的全部子孙） */
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig); } catch { /* 组里可能已经空了 */ }
  try { process.kill(pid, sig); } catch { /* 已经没了 */ }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

/** SIGTERM → 3s → SIGKILL；返回时进程**真的**没了（否则 gone=false） */
async function destroy(s: TerminalSession): Promise<{ forced: boolean; gone: boolean }> {
  try { s.child.stdin?.end(); } catch { /* 已经关了 */ }
  if (!s.running || !s.pid) { s.running = false; return { forced: false, gone: await waitGone(s.pid, 500) }; }
  signalGroup(s.pid, "SIGTERM");
  let gone = await waitGone(s.pid, KILL_GRACE_MS);
  let forced = false;
  if (!gone) { forced = true; signalGroup(s.pid, "SIGKILL"); gone = await waitGone(s.pid, SIGKILL_WAIT_MS); }
  if (gone) finish(s, s.exitCode, s.signal);
  return { forced, gone };
}

// ── open / send / read / close / list ──────────────────
function waitReady(s: TerminalSession, ms: number): Promise<boolean> {
  if (s.ready) return Promise.resolve(true);
  if (!s.running) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok: boolean): void => { clearTimeout(timer); s.readyWaiters.delete(done); resolve(ok); };
    const timer = setTimeout(() => done(s.ready), ms);
    s.readyWaiters.add(done);
  });
}

export async function openSession(opts: { cwd: string; name?: string; threadId: string }): Promise<OpenResult> {
  const id = "term_" + Date.now().toString(36) + "_" + (++seq).toString(36);
  const sentinel = "__DOVE_READY_" + id.slice(-4) + "__";
  const shell = pickShell();
  const forced = process.env.DOVE_TERMINAL_NO_PTY === "1";
  const canPty = !forced && fs.existsSync(SCRIPT_BIN);
  const name = opts.name?.trim() || "terminal-" + seq;
  const spawnOpts = { id, name, threadId: opts.threadId, shell, cwd: opts.cwd, sentinel };
  let note = forced ? "已按 DOVE_TERMINAL_NO_PTY=1 强制纯管道模式。" : "";
  let s = createSession({ ...spawnOpts, pty: canPty });
  let ok = await waitReady(s, canPty ? PTY_PROBE_MS : PIPE_PROBE_MS);
  if (!ok && canPty) {   // PTY 秒退（macOS script 见到 socketpair stdio 就 ENOTSUP）→ 重开纯管道
    const why = s.running ? PTY_PROBE_MS + "ms 内没等到提示符" : lastText(s) || "script 直接退出";
    await destroy(s);
    note = "PTY 起不来（" + why + "），已退化纯管道模式。";
    s = createSession({ ...spawnOpts, pty: false });
    ok = await waitReady(s, PIPE_PROBE_MS);
  }
  if (!ok) {
    const why = lastText(s) || "超时";
    await destroy(s);
    return { ok: false, error: "shell 没起来（" + shell + "）：" + why };
  }
  if (s.pty) note = "PTY 模式（/usr/bin/script 分配伪终端）：交互式程序可用。";
  // 等提示符「静下来」（zsh 会打两遍），再把启动横幅 + 初始化回显丢掉：会话从干净的提示符开始，
  // hits 也归零 ⇒ 第一次 send 必须等到**新的**哨兵，不会被启动期那个多余的哨兵顶掉。
  await quiesce(s, 120);
  resetBuffer(s.buf);
  s.scanTail = ""; s.hits = 0; s.ready = true; s.lastActiveAt = Date.now();
  sessions.set(id, s);
  ensureSweeper();
  return { ok: true, session: s, note: note + (s.pty ? "" : "管道模式状态保持没问题，但全屏交互程序（vim/top）不能用。") };
}

export async function sendToSession(opts: { id: string; threadId: string; text: string; waitMs: number; submit: boolean }): Promise<SendOutcome> {
  const s = sessions.get(opts.id);
  if (!s) return { ok: false, error: "没有这个会话：" + opts.id + "（可能已关闭，用 TerminalList 看还有哪些）" };
  if (s.threadId !== opts.threadId) return { ok: false, error: "会话 " + opts.id + " 不属于当前线程，拒绝操作。" };
  if (!s.running) {
    return { ok: false, session_id: s.id, session_status: "exited", error: "会话 " + s.id + " 里的 shell 已退出（exit " + s.exitCode + "），不能再发命令。" };
  }
  if (s.busy) {
    return { ok: false, session_id: s.id, session_status: "busy",
      error: "会话 " + s.id + " 里有命令还在跑（上一次等待超时），拒绝并发写入以免输出交错。" +
        "先用 TerminalRead 看它跑到哪了；确认卡死就 TerminalClose 关掉会话（杀整个进程组），或等它跑完再发。" };
  }

  const mark = s.buf.total, hitsAtStart = s.hits, submit = opts.submit;
  const text = submit && !opts.text.endsWith("\n") ? opts.text + "\n" : opts.text;
  if (submit) { s.busy = true; s.busyHits = s.hits; }
  s.lastCommand = opts.text.slice(0, 200);
  s.lastActiveAt = Date.now();
  noteCd(s, opts.text);
  try {
    s.child.stdin?.write(text);
  } catch (e) {
    s.busy = false;
    return { ok: false, session_id: s.id, error: "写入会话失败：" + errMsg(e), session_status: statusOf(s) };
  }
  const wait = submit ? opts.waitMs : Math.min(opts.waitMs, SETTLE_MS);
  const reason = await waitFor(s, hitsAtStart, wait);
  if (reason === "prompt") await quiesce(s, 60, 300);   // 提示符可能跑在输出前面（两条管道）
  s.lastActiveAt = Date.now();
  const delta = linesOf(s).slice(Math.max(0, mark - s.buf.dropped));
  const notes: string[] = [];
  if (reason === "timeout") notes.push("等 " + wait + "ms 没等到提示符：命令可能还在跑（也可能卡住）。");
  if (!submit) notes.push("submit=false：只写文本没回车，按 " + wait + "ms 短窗口返回。");
  if (reason === "exit") notes.push("shell 在命令执行期间退出，需要的话用 TerminalClose 回收会话。");
  return {
    ok: true, session_id: s.id, output: delta.join("\n"), wait_reason: reason,
    session_status: statusOf(s), truncated: s.buf.truncated || undefined,
    exit_code: s.running ? undefined : s.exitCode, note: notes.length ? notes.join(" ") : undefined,
  };
}

/** 超时后**不**清 busy：命令还在飞，清了就会让下一次 send 和它交错。 */
function waitFor(s: TerminalSession, hitsAtStart: number, ms: number): Promise<WaitReason> {
  if (!s.running) return Promise.resolve("exit");
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: WaitReason): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); s.waiters.delete(waiter); resolve(r);
    };
    const timer = setTimeout(() => done("timeout"), Math.max(0, ms));
    const waiter: Waiter = { hitsAtStart, fire: done };
    s.waiters.add(waiter);
    if (s.hits > hitsAtStart) done("prompt");   // 竞态兜底：注册前哨兵已经来了
  });
}

/** 尽力跟踪 cwd：命令以 cd 开头且目标目录真实存在就更新（跟不到就保持原值，不猜） */
function noteCd(s: TerminalSession, cmd: string): void {
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(cmd);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!raw || raw === "-") return;
  const target = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  const abs = path.isAbsolute(target) ? target : path.resolve(s.cwd, target);
  try { if (fs.statSync(abs).isDirectory()) s.cwd = path.normalize(abs); } catch { /* 目标不存在：保持原 cwd */ }
}

export function readSession(opts: { id: string; threadId: string; lines: number; offset: number }): ReadOutcome {
  const s = sessions.get(opts.id);
  if (!s) return { ok: false, error: "没有这个会话：" + opts.id + "（可能已关闭，用 TerminalList 看还有哪些）" };
  if (s.threadId !== opts.threadId) return { ok: false, error: "会话 " + opts.id + " 不属于当前线程，拒绝读取。" };
  s.lastActiveAt = Date.now();
  const all = linesOf(s);
  const offset = Math.max(0, Math.min(opts.offset, all.length));
  const end = all.length - offset;
  const start = Math.max(0, end - Math.max(1, opts.lines));
  return {
    ok: true, session_id: s.id, text: all.slice(start, end).join("\n"),
    total_lines: all.length, dropped_lines: s.buf.dropped, returned: end - start, truncated: s.buf.truncated,
    note: s.buf.truncated
      ? "缓冲有上限（" + MAX_BUFFER_LINES + " 行 / " + Math.round(MAX_BUFFER_CHARS / 1024) + " KiB），最早的 " + s.buf.dropped + " 行已被丢弃。"
      : undefined,
  };
}

export async function closeSession(id: string, threadId: string): Promise<CloseOutcome> {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: "没有这个会话：" + id + "（可能已经关闭）" };
  if (s.threadId !== threadId) return { ok: false, error: "会话 " + id + " 不属于当前线程，拒绝关闭。" };
  sessions.delete(id);
  if (sessions.size === 0) stopSweeper();   // 最后一个会话关了就别留着 timer
  const wasRunning = s.running;
  const { forced, gone } = await destroy(s);
  const notes: string[] = [];
  if (!wasRunning) notes.push("shell 本来就已经退出了。");
  if (forced) notes.push("SIGTERM 宽限 " + KILL_GRACE_MS + "ms 内没退，已 SIGKILL 强杀进程组。");
  if (!gone) notes.push("⚠️ 进程仍未消失（pid " + s.pid + "），可能需要人工处理。");
  return { ok: true, session_id: id, closed: gone, note: notes.join(" ") || "进程组已确认退出。" };
}

export function listSessions(threadId: string): SessionSummary[] {
  const now = Date.now();
  return [...sessions.values()].filter((s) => s.threadId === threadId).map((s) => ({
    session_id: s.id, name: s.name, pid: s.pid, cwd: s.cwd, running: s.running,
    idle_ms: now - s.lastActiveAt, status: statusOf(s), pty: s.pty, last_command: s.lastCommand,
  }));
}

// ── 空闲回收（timer 必须 unref，否则内核退不出去） ──────
/** 空闲阈值：DOVE_TERMINAL_IDLE_MS 可覆盖（自动化测试要真验回收，正常使用别设） */
const idleMs = (): number => {
  const v = Number(process.env.DOVE_TERMINAL_IDLE_MS);
  return Number.isFinite(v) && v > 0 ? v : IDLE_CLOSE_MS;
};

function stopSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  sweeperMs = 0;
}

/** 没有会话就不留 timer；周期跟着当前阈值走（阈值可能被 env 改过） */
function ensureSweeper(): void {
  const ms = Math.max(500, Math.min(SWEEP_MS, idleMs()));
  if (sweeper && sweeperMs === ms) return;
  stopSweeper();
  sweeper = setInterval(() => { void sweep(); }, ms);
  sweeper.unref();   // 不 unref 会把内核钉死在事件循环里
  sweeperMs = ms;
}

async function sweep(): Promise<void> {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now - s.lastActiveAt < idleMs()) continue;
    sessions.delete(s.id);
    await destroy(s);
  }
  if (sessions.size === 0) stopSweeper();
}

/** 收尾/测试用：关掉全部（或某线程的）会话，返回关了几个 */
export async function closeAllSessions(threadId?: string): Promise<number> {
  const list = [...sessions.values()].filter((s) => !threadId || s.threadId === threadId);
  for (const s of list) await closeSession(s.id, s.threadId);
  return list.length;
}
/** 真实内核状态（不看内部布尔）：进程还活着吗（测试断言用） */
export const pidAlive = (pid: number): boolean => alive(pid);
/** 进程组里还有活口吗（测试断言用：防孤儿） */
export function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}
