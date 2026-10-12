/**
 * 看门狗与超时分级（T1.4）
 * 三类计时：整轮看门狗 / 空闲超时 / 工具超时。
 * 关键纪律：**等待审批时暂停计量**，否则长审批会被空闲超时误杀。
 */
import {
  TURN_WATCHDOG_MS, IDLE_TIMEOUT_MS, IDLE_TIMEOUT_IMAGE_MS,
  IDLE_TIMEOUT_REASONING_MS, IDLE_TIMEOUT_CRON_MS, TOOL_TIMEOUT_MS, TOOL_TIMEOUT_CRON_MS,
  approvalTimeoutMs,
} from "../constants.ts";

export type IdleProfile = "normal" | "image" | "reasoning" | "cron";

export interface WatchdogOptions {
  /**
   * 暂停计量的一次性上限（毫秒）。
   *
   * 为什么必须有上限：pause() 是给「等审批 / 等用户回话」用的，而等待本身**有上限**
   * （DOVE_APPROVAL_TIMEOUT_MS，缺省 5 分钟）。但 resume() 从来没有被任何调用方调过
   * （runtime 只在 onApprovalNeeded 里 pause），于是**一次审批 = 这一轮永久静音**：
   * `#check()` 一上来就 `if (this.#paused) return`，idle 和 max_generation_time 两条兜底
   * 同时失效。实测形态：网络晚点 + 一次审批之后，回合可以永远挂着不报错，
   * 客户端不断开就没人知道它卡住了。
   * 上限取「审批超时 + 一分钟缓冲」：正常路径上审批早就有结论了，
   * 超过这个时间说明等待那侧也出问题了，看门狗必须自己醒过来。
   */
  maxPauseMs?: number;
}

export class Watchdog {
  #startedAt = Date.now();
  #lastActivity = Date.now();
  #paused = false;
  #pauseStartedAt = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #onTimeout: (reason: string) => void;
  #maxMs: number;
  #maxPauseMs: number;

  constructor(onTimeout: (reason: string) => void, maxMs = TURN_WATCHDOG_MS, opts: WatchdogOptions = {}) {
    this.#onTimeout = onTimeout;
    this.#maxMs = maxMs;
    this.#maxPauseMs = opts.maxPauseMs ?? approvalTimeoutMs() + 60_000;
  }

  start(): void {
    this.#startedAt = Date.now();
    this.#lastActivity = Date.now();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = setInterval(() => this.#check(), 1_000);
  }

  stop(): void { if (this.#timer) { clearInterval(this.#timer); this.#timer = null; } }

  /** 收到任何模型/工具活动就调这个 */
  touch(): void { if (!this.#paused) this.#lastActivity = Date.now(); }

  /** 等待审批 / 等待用户回答时暂停计量 */
  pause(): void { if (!this.#paused) { this.#paused = true; this.#pauseStartedAt = Date.now(); } }
  resume(): void {
    if (!this.#paused) return;
    const delta = Date.now() - this.#pauseStartedAt;
    this.#lastActivity += delta;
    this.#startedAt += delta;
    this.#paused = false;
  }

  get elapsedMs(): number { return Date.now() - this.#startedAt; }

  idleTimeoutMs(profile: IdleProfile = "normal"): number {
    switch (profile) {
      case "image": return IDLE_TIMEOUT_IMAGE_MS;
      case "reasoning": return IDLE_TIMEOUT_REASONING_MS;
      case "cron": return IDLE_TIMEOUT_CRON_MS;
      default: return IDLE_TIMEOUT_MS;
    }
  }

  toolTimeoutMs(profile: IdleProfile = "normal"): number {
    return profile === "cron" ? TOOL_TIMEOUT_CRON_MS : TOOL_TIMEOUT_MS;
  }

  #check(): void {
    if (this.#paused) {
      // 暂停也有上限（见 WatchdogOptions.maxPauseMs）：到点自己醒过来，
      // 让下面的 idle / max 兜底重新生效。
      if (Date.now() - this.#pauseStartedAt <= this.#maxPauseMs) return;
      this.resume();
    }
    const now = Date.now();
    if (now - this.#startedAt > this.#maxMs) { this.#onTimeout("max_generation_time"); return; }
    if (now - this.#lastActivity > IDLE_TIMEOUT_REASONING_MS) { this.#onTimeout("idle_timeout"); }
  }
}

/** 给任意 Promise 套一个超时 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
