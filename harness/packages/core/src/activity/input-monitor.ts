/**
 * 全局输入监听（T7.4）：Swift helper 的运行时编译、长驻进程与事件流解析
 * - helper 源码是同目录的 input-monitor.swift；按内容 sha256 缓存到 ~/.dove/cache/input-monitor-<hash>
 * - 事件为 NDJSON：permission / app / key / leftMouseDown / rightMouseDown / scroll
 * - 隐私：keyDown 只透传 keyCode + 修饰键，**没有字符**（helper 侧就不采）
 * - 无常驻进程时绝不抛：编译失败 → { ok:false, error }，权限不足 → permission 事件里说明
 * - 生命周期：stop() 先关 stdin（helper 读到 EOF 自杀）再 SIGTERM，500ms 后 SIGKILL，绝不留僵尸
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureSwiftHelper, run, type HelperResult } from "../docs/swift.ts";

export const INPUT_MONITOR_PREFIX = "input-monitor";
/** 同一 keyCode 在这个窗口内只发一次（长按会以 30Hz 刷屏） */
export const KEY_THROTTLE_MS = 200;
export const CHECK_TIMEOUT_MS = 10_000;
export const START_WAIT_MS = 2_000;
export const STOP_GRACE_MS = 500;

/** 辅助功能权限面板（系统设置深链） */
export const ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
export const ACCESSIBILITY_HINT =
  "未获得「辅助功能」权限：可以记录 app 切换，但收不到键盘/鼠标事件。" +
  "打开 系统设置 → 隐私与安全性 → 辅助功能 勾选运行 Dove 的程序（终端 / IDE）后重启它。";

export type InputEventKind = "permission" | "app" | "key" | "leftMouseDown" | "rightMouseDown" | "scroll";

/** 一行 NDJSON 事件（字段按 kind 取用；未用到的字段缺省） */
export interface InputEvent {
  kind: InputEventKind;
  ts: number;
  /** app：名称 / bundle id / pid / 前台窗口标题 */
  app?: string;
  bundleId?: string;
  pid?: number;
  windowTitle?: string;
  /** key：虚拟键码 + 修饰键（cmd/shift/ctrl/opt/fn/caps），绝不带字符 */
  keyCode?: number;
  modifiers?: string[];
  repeat?: boolean;
  /** 鼠标/滚轮：屏幕坐标（左下原点）与滚动增量 */
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  /** permission：是否已授权 + 中文引导 */
  granted?: boolean;
  hint?: string;
}

export function monitorSourcePath(): string {
  return fileURLToPath(new URL("./input-monitor.swift", import.meta.url));
}

/** 确保输入监听 helper 可用（必要时用 swiftc 现场编译并缓存） */
export async function ensureMonitor(): Promise<HelperResult> {
  return ensureSwiftHelper({
    source: monitorSourcePath(),
    prefix: INPUT_MONITOR_PREFIX,
    frameworks: ["AppKit", "ApplicationServices"],
  });
}

/** 打开系统设置的「辅助功能」面板（失败静默：引导文案仍在） */
export function openAccessibilitySettings(): void {
  try {
    const child = spawn("/usr/bin/open", [ACCESSIBILITY_PANE], { detached: true, stdio: "ignore" });
    child.on("error", () => { /* 打不开也不影响其他能力 */ });
    child.unref();
  } catch { /* ignore */ }
}

export interface InputMonitorOptions {
  keyThrottleMs?: number;
  now?: () => number;
  logger?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

export class InputMonitor {
  #child: ChildProcess | null = null;
  #buf = "";
  #onEvent: ((e: InputEvent) => void) | null = null;
  #keyAt = new Map<number, number>();
  #granted: boolean | null = null;
  #dropped = 0;
  #throttleMs: number;
  #now: () => number;
  #logger?: InputMonitorOptions["logger"];
  #reap = (): void => { try { this.#child?.kill("SIGKILL"); } catch { /* ignore */ } };

  constructor(opts: InputMonitorOptions = {}) {
    this.#throttleMs = opts.keyThrottleMs ?? KEY_THROTTLE_MS;
    this.#now = opts.now ?? (() => Date.now());
    this.#logger = opts.logger;
  }

  get running(): boolean { return !!this.#child && this.#child.exitCode === null && this.#child.signalCode === null; }
  get pid(): number | null { return this.#child?.pid ?? null; }
  /** helper 上报的权限状态（start 之前为 null） */
  get accessibilityGranted(): boolean | null { return this.#granted; }
  get droppedKeys(): number { return this.#dropped; }

  /** 启动长驻监听；ok=false 时附明确原因（不改其他能力） */
  async start(onEvent: (e: InputEvent) => void): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: true };
    const helper = await ensureMonitor();
    if (!helper.ok || !helper.bin) return { ok: false, error: helper.error ?? "输入监听 helper 不可用" };
    this.#onEvent = onEvent;
    let child: ChildProcess;
    try {
      // stdin 必须是管道：父进程退出/关闭 stdin 时 helper 读到 EOF 会自杀，不留孤儿
      child = spawn(helper.bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      return { ok: false, error: "启动监听进程失败：" + String(e) };
    }
    this.#child = child;
    this.#buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { this.#feed(chunk); });
    child.on("error", (e) => { this.#log("warn", "监听进程异常", { error: String((e as Error).message) }); });
    child.on("exit", (code, signal) => {
      this.#log("info", "监听进程退出", { code, signal });
      if (this.#child === child) this.#child = null;
    });
    process.once("exit", this.#reap);

    // 等第一条事件（helper 启动即发 permission + 当前前台 app），顺便确认进程活着
    const first = await this.#waitFirst(START_WAIT_MS);
    if (first === "dead") return { ok: false, error: "监听进程启动后立即退出（helper 可能缺少依赖）" };
    return { ok: true };
  }

  /** 停止监听：关 stdin → SIGTERM → 500ms 后 SIGKILL；同步返回，配合 waitStopped() 确认 */
  stop(): void {
    const child = this.#child;
    process.off("exit", this.#reap);
    if (!child) return;
    try { child.stdin?.end(); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    const killer = setTimeout(() => {
      try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* ignore */ }
    }, STOP_GRACE_MS);
    killer.unref?.();
    if (this.#child === child) this.#child = null;
    this.#onEvent = null;
  }

  /** 等进程真正退出（自测 / 关服务时确认不留僵尸） */
  async waitStopped(timeoutMs = 2_000): Promise<boolean> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(child.exitCode !== null || child.signalCode !== null), timeoutMs);
      timer.unref?.();
      child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
  }

  /** 辅助功能权限：先信进程内状态，否则跑 helper --check */
  async isAccessibilityGranted(): Promise<boolean> {
    if (this.#granted !== null) return this.#granted;
    const helper = await ensureMonitor();
    if (!helper.ok || !helper.bin) return false;
    const r = await run(helper.bin, ["--check"], { timeoutMs: CHECK_TIMEOUT_MS });
    for (const line of r.stdout.split("\n")) {
      const e = parseLine(line);
      if (e?.kind === "permission") { this.#granted = e.granted === true; return this.#granted; }
    }
    return false;
  }

  // ── 内部 ───────────────────────────────────────────────
  #feed(chunk: string): void {
    this.#buf += chunk;
    const lines = this.#buf.split("\n");
    this.#buf = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseLine(line);
      if (!event) continue;
      if (event.kind === "permission") this.#granted = event.granted === true;
      if (event.kind === "key" && !this.#acceptKey(event)) continue;
      try { this.#onEvent?.(event); }
      catch (e) { this.#log("warn", "事件回调异常", { error: String(e).slice(0, 200) }); }
    }
  }

  /** 节流：同一 keyCode 在 keyThrottleMs 内只发一次 */
  #acceptKey(e: InputEvent): boolean {
    if (typeof e.keyCode !== "number") return false;
    if (keyThrottle(this.#keyAt, e.keyCode, this.#now(), this.#throttleMs)) return true;
    this.#dropped++;
    return false;
  }

  #waitFirst(timeoutMs: number): Promise<"event" | "dead" | "timeout"> {
    const child = this.#child;
    if (!child) return Promise.resolve("dead");
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: "event" | "dead" | "timeout"): void => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      timer.unref?.();
      const probe = (e: InputEvent): void => { if (e.kind === "permission" || e.kind === "app") finish("event"); };
      const prev = this.#onEvent;
      this.#onEvent = (e) => { probe(e); prev?.(e); };
      child.once("exit", () => finish("dead"));
    });
  }

  #log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
    try { this.#logger?.(level, msg, data); } catch { /* ignore */ }
  }
}

/** 一行文本 → 事件（非 JSON / 缺 kind / ts 非法 → null） */
export function parseLine(line: string): InputEvent | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(s) as Record<string, unknown>; } catch { return null; }
  const kind = raw.kind;
  if (typeof kind !== "string") return null;
  const out: Record<string, unknown> = { ...raw };
  out.kind = kind;
  out.ts = typeof raw.ts === "number" ? raw.ts : Date.now();
  return out as unknown as InputEvent;
}

/** 节流判定（纯函数，便于自测）：同一 keyCode 在 windowMs 内只放行一次 */
export function keyThrottle(state: Map<number, number>, keyCode: number, at: number, windowMs = KEY_THROTTLE_MS): boolean {
  const last = state.get(keyCode);
  if (last !== undefined && at - last < windowMs) return false;
  state.set(keyCode, at);
  return true;
}
