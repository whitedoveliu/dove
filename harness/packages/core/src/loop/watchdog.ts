/**
 * 看门狗与超时分级（T1.4）
 * 三类计时：整轮看门狗 / 空闲超时 / 工具超时。
 * 关键纪律：**等待审批时暂停计量**，否则长审批会被空闲超时误杀。
 */
import {
  TURN_WATCHDOG_MS, IDLE_TIMEOUT_MS, IDLE_TIMEOUT_IMAGE_MS,
  IDLE_TIMEOUT_REASONING_MS, IDLE_TIMEOUT_CRON_MS, TOOL_TIMEOUT_MS, TOOL_TIMEOUT_CRON_MS,
} from "../constants.ts";

export type IdleProfile = "normal" | "image" | "reasoning" | "cron";

export class Watchdog {
  #startedAt = Date.now();
  #lastActivity = Date.now();
  #paused = false;
  #pauseStartedAt = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #onTimeout: (reason: string) => void;
  #maxMs: number;

  constructor(onTimeout: (reason: string) => void, maxMs = TURN_WATCHDOG_MS) {
    this.#onTimeout = onTimeout;
    this.#maxMs = maxMs;
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
    if (this.#paused) return;
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
