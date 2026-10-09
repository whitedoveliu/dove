/**
 * 极简 JSON-RPC 2.0 over stdio（MCP 传输层，T3.12）
 *
 * 帧格式：MCP 用**按行分隔的 JSON**（newline-delimited JSON），一条消息一行。
 * 纪律：
 *  - 子进程退出 / 启动失败 / close() → 所有挂起请求一律 reject，绝不把调用方永久挂住
 *  - stderr 是 MCP server 唯一的报错通道 → 逐行转发到 logger，退出时把尾部贴进原因
 *  - 服务端反向发来的请求（sampling / roots 等）本 host 不实现 → 回 JSON-RPC error，别让对面干等
 *  - 零依赖：只用 node:child_process
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { errMsg } from "../tools/builtin/util.ts";

export type LogLevel = "info" | "warn" | "error";
/** 日志出口（与 activity 的 logger 同形） */
export type RpcLogger = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

/** JSON-RPC 标准错误码（只列用得到的） */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

const DEFAULT_TIMEOUT_MS = 30_000;
/** 单行上限：MCP 帧不该有这么大，超了说明对面在乱写 */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_CHARS = 400;
const KILL_GRACE_MS = 1_500;
const ERRISH = /(error|exception|traceback|panic|fatal|failed|错误)/i;

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface StdioTransportOptions {
  logger?: RpcLogger;
  /** 单条请求默认超时（毫秒） */
  timeoutMs?: number;
  /** 子进程**意外**退出时回调（客户端主动 close 不触发） */
  onClose?: (reason: string) => void;
}

/** JSON-RPC 错误（服务端返回的 error 字段） */
export class RpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** 进程退出兜底：同步杀掉所有还活着的 MCP 子进程（不留孤儿） */
const live = new Set<StdioTransport>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const t of [...live]) { try { t.kill(); } catch { /* 退出路径不抛 */ } }
  });
}

export class StdioTransport {
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<string, Pending>();
  #nextId = 1;
  #buf = "";
  #closed = true;
  #started = false;
  #reason = "transport 未启动";
  #stderr: string[] = [];
  #logger: RpcLogger | undefined;
  #timeoutMs: number;
  #onClose: ((reason: string) => void) | undefined;
  #notifyHandlers = new Set<(method: string, params: unknown) => void>();

  constructor(opts: StdioTransportOptions = {}) {
    this.#logger = opts.logger;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onClose = opts.onClose;
  }

  get alive(): boolean { return !this.#closed && this.#child !== null; }
  get pid(): number | undefined { return this.#child?.pid; }
  get closeReason(): string { return this.#reason; }
  /** 子进程 stderr 的尾部（报错时贴给用户看） */
  get stderrTail(): string { return this.#stderr.join("\n"); }

  /** 订阅服务端通知（notifications/tools/list_changed 等）；返回退订函数 */
  onNotification(cb: (method: string, params: unknown) => void): () => void {
    this.#notifyHandlers.add(cb);
    return () => { this.#notifyHandlers.delete(cb); };
  }

  /** 启动子进程；命令不存在 / 不可执行 → reject（带人话原因） */
  async start(cmd: string, args: string[] = [], env: Record<string, string> = {}, cwd?: string): Promise<void> {
    if (this.#child) throw new Error("transport 已经启动过了");
    installExitHook();
    this.#closed = false;
    this.#started = false;
    this.#reason = "";

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    } catch (e) {
      this.#die("启动失败：" + cmd + " → " + errMsg(e), false);
      throw new Error("启动失败：" + cmd + " → " + errMsg(e));
    }
    this.#child = child;
    live.add(this);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { this.#onStdout(chunk); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.#onStderr(chunk); });
    child.stdin.on("error", () => { /* EPIPE：交给 exit 事件统一收尾 */ });
    child.once("exit", (code, signal) => {
      live.delete(this);
      this.#child = null;
      const tail = this.#stderr.slice(-5).join(" / ").slice(0, STDERR_TAIL_CHARS);
      const why = "MCP server 已退出（code=" + (code === null ? "-" : String(code)) + " signal=" + (signal ?? "-") + "）";
      this.#die(tail ? why + "：" + tail : why, true);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.off("error", onError);
          // 成功启动后的 error（EPIPE 等）不再走 spawn 路径；挂一个空监听，免得变成未处理异常
          child.on("error", () => { /* 交给 exit 事件统一收尾 */ });
          resolve();
        };
        const onError = (e: Error): void => { child.off("spawn", onSpawn); reject(new Error("启动失败：" + cmd + " → " + e.message)); };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (e) {
      live.delete(this);
      this.#child = null;
      this.#die(errMsg(e), false);
      throw e;
    }
    this.#started = true;
  }

  /** 发一条请求；超时 / 子进程退出都会 reject */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closed || !this.#child) {
      return Promise.reject(new Error(method + " 失败：" + (this.#reason || "transport 已关闭")));
    }
    const id = this.#nextId++;
    const ms = timeoutMs ?? this.#timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const key = String(id);
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(new Error(method + " 超时（" + ms + "ms）"));
      }, ms);
      this.#pending.set(key, { method, resolve: resolve as unknown as (v: unknown) => void, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** 发一条通知（不等响应）；transport 已死返回 false */
  notify(method: string, params?: unknown): boolean {
    if (this.#closed || !this.#child) {
      this.#logger?.("warn", "[mcp] 通知未发送 " + method + "：" + (this.#reason || "transport 已关闭"));
      return false;
    }
    return this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** 主动关闭：SIGTERM → 1.5s 后 SIGKILL；挂起请求全部 reject */
  close(): void {
    const child = this.#child;
    this.#child = null;
    live.delete(this);
    this.#die("客户端已断开", false);
    if (!child) return;
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, KILL_GRACE_MS);
    timer.unref();
    child.once("exit", () => { clearTimeout(timer); });
  }

  /** 同步强杀（只给进程退出兜底用） */
  kill(): void {
    const child = this.#child;
    this.#child = null;
    live.delete(this);
    this.#closed = true;
    try { child?.kill("SIGKILL"); } catch { /* ignore */ }
  }

  // ── 收帧 ────────────────────────────────────────────────
  #onStdout(chunk: string): void {
    this.#buf += chunk;
    if (this.#buf.length > MAX_BUFFER_BYTES) {
      this.#buf = "";
      this.#logger?.("error", "[mcp] 单帧超过上限，已丢弃缓冲");
      return;
    }
    let nl = this.#buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.#buf.slice(0, nl).replace(/\r$/, "");
      this.#buf = this.#buf.slice(nl + 1);
      if (line.trim()) this.#onLine(line);
      nl = this.#buf.indexOf("\n");
    }
  }

  #onStderr(chunk: string): void {
    for (const raw of chunk.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line) continue;
      this.#stderr.push(line);
      if (this.#stderr.length > STDERR_TAIL_LINES) this.#stderr.shift();
      this.#logger?.(ERRISH.test(line) ? "warn" : "info", "[mcp:stderr] " + line);
    }
  }

  #onLine(line: string): void {
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      this.#logger?.("warn", "[mcp] 丢弃无法解析的帧", { line: line.slice(0, 200) });
      return;
    }

    // 服务端 → 客户端 的请求：本 host 不支持 sampling / roots，回 error 免得对面干等
    if (typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) {
      this.#logger?.("warn", "[mcp] 未实现的服务端请求：" + msg.method);
      this.#write({ jsonrpc: "2.0", id: msg.id, error: { code: RPC_METHOD_NOT_FOUND, message: "Dove MCP host 未实现 " + msg.method } });
      return;
    }
    // 通知
    if (typeof msg.method === "string") {
      for (const h of [...this.#notifyHandlers]) {
        try { h(msg.method, msg.params); } catch { /* 单个订阅者出错不影响其他 */ }
      }
      return;
    }
    // 响应：按 id 配平
    if (msg.id === undefined || msg.id === null) {
      this.#logger?.("warn", "[mcp] 收到既无 id 又无 method 的帧，已忽略");
      return;
    }
    const key = String(msg.id);
    const p = this.#pending.get(key);
    if (!p) {
      this.#logger?.("warn", "[mcp] 收到未知 id 的响应，已忽略：" + key);
      return;
    }
    this.#pending.delete(key);
    clearTimeout(p.timer);
    if (msg.error) {
      const code = typeof msg.error.code === "number" ? msg.error.code : RPC_INTERNAL_ERROR;
      p.reject(new RpcError(code, String(msg.error.message ?? "未知错误"), msg.error.data));
    } else {
      p.resolve(msg.result);
    }
  }

  #write(msg: Record<string, unknown>): boolean {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    try {
      stdin.write(JSON.stringify(msg) + "\n");
      return true;
    } catch (e) {
      this.#logger?.("error", "[mcp] 写入失败", { error: errMsg(e) });
      return false;
    }
  }

  /** 收尾：置关闭 + reject 所有挂起请求；notify=true 时（意外退出）回调 onClose */
  #die(reason: string, notify: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reason = reason;
    for (const [key, p] of [...this.#pending]) {
      this.#pending.delete(key);
      clearTimeout(p.timer);
      p.reject(new Error(p.method + " 失败：" + reason));
    }
    if (notify && this.#started) {
      this.#logger?.("error", "[mcp] transport 关闭：" + reason);
      try { this.#onClose?.(reason); } catch { /* 回调出错不影响收尾 */ }
    }
  }
}
