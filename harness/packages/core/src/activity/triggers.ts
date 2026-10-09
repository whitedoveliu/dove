/**
 * 触发与 debounce（T7.3）
 * 周期触发：heartbeat 120s / visual_change 12s；
 * 事件触发：app_focus / click（即时）/ typing_pause（停手 1.2s 后）；
 * 全部过 4000ms 全局 debounce；空闲时指数降频（×2，上限 5 分钟），有活动立即恢复。
 */
import type { TriggerKind, TriggerMeta } from "./types.ts";

export const TRIGGER_INTERVALS: Record<TriggerKind, number> = {
  heartbeat: 120_000,
  visual_change: 12_000,
  typing_pause: 1_200,
  app_focus: 0,   // 事件驱动，无固定间隔
  click: 0,
  manual: 0,
};
export const DEBOUNCE_MS = 4_000;
export const IDLE_BACKOFF_MAX_MS = 300_000;   // 降频上限 5 分钟
export const IDLE_BACKOFF_BASE = 2;           // 每轮空闲 ×2
export const TYPING_PAUSE_MS = 1_200;

type Timer = ReturnType<typeof setTimeout>;

export interface TriggerOptions {
  /** 通过 debounce 后回调；上层在这里编号召采帧 */
  onCapture: (reason: TriggerKind, meta?: TriggerMeta) => void;
  intervals?: Partial<Record<TriggerKind, number>>;
  debounceMs?: number;
  idleBackoffMaxMs?: number;
  typingPauseMs?: number;
  /** 返回 true 时暂停采集（锁屏 / 用户关了开关） */
  shouldPause?: () => boolean;
  /** 可注入时钟，便于自测 */
  now?: () => number;
}

export class TriggerEngine {
  #opts: TriggerOptions;
  #intervals: Record<TriggerKind, number>;
  #debounceMs: number;
  #idleMax: number;
  #typingMs: number;
  #now: () => number;

  #heartbeat: Timer | null = null;
  #visual: Timer | null = null;
  #typing: Timer | null = null;
  #running = false;

  #lastCaptureAt = 0;
  #lastActivityAt = 0;
  #idleStreak = 0;
  #captures = 0;
  #drops = 0;

  constructor(opts: TriggerOptions) {
    this.#opts = opts;
    this.#intervals = { ...TRIGGER_INTERVALS, ...(opts.intervals ?? {}) };
    this.#debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.#idleMax = opts.idleBackoffMaxMs ?? IDLE_BACKOFF_MAX_MS;
    this.#typingMs = opts.typingPauseMs ?? TYPING_PAUSE_MS;
    this.#now = opts.now ?? (() => Date.now());
    this.#lastActivityAt = this.#now();
  }

  get running(): boolean { return this.#running; }
  get captures(): number { return this.#captures; }
  get drops(): number { return this.#drops; }
  get idleStreak(): number { return this.#idleStreak; }
  get lastCaptureAt(): number { return this.#lastCaptureAt; }
  /** 当前降频倍数 */
  get multiplier(): number { return IDLE_BACKOFF_BASE ** this.#idleStreak; }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#lastActivityAt = this.#now();
    this.#scheduleHeartbeat(0);
    this.#scheduleVisual(0);
  }

  stop(): void {
    this.#running = false;
    if (this.#heartbeat) { clearTimeout(this.#heartbeat); this.#heartbeat = null; }
    if (this.#visual) { clearTimeout(this.#visual); this.#visual = null; }
    if (this.#typing) { clearTimeout(this.#typing); this.#typing = null; }
  }

  /** 外部事件源（Swift 输入监听 / 面板）调用；事件类触发立即参与 debounce 判定 */
  notify(kind: TriggerKind, meta?: TriggerMeta): void {
    if (kind === "typing_pause") { this.notifyTyping(meta); return; }
    if (kind === "heartbeat" || kind === "visual_change") { this.#fire(kind, meta); return; }
    this.markActivity();
    this.#fire(kind, meta);
  }

  /** 打字：每次按键重置 1.2s 计时器，停手后触发一次 typing_pause */
  notifyTyping(meta?: TriggerMeta): void {
    this.markActivity();
    if (!this.#running) return;
    if (this.#typing) clearTimeout(this.#typing);
    this.#typing = setTimeout(() => {
      this.#typing = null;
      this.#fire("typing_pause", meta);
    }, this.#typingMs);
    this.#typing.unref?.();
  }

  /** 有真人活动：立即恢复全速 */
  markActivity(): void {
    this.#lastActivityAt = this.#now();
    this.#idleStreak = 0;
  }

  /** 显式标记空闲（锁屏 / 长时间无输入） */
  markIdle(): void {
    this.#lastActivityAt = this.#now() - this.#idleMax * 2;
    this.#idleStreak += 1;
  }

  /** 供自测：按当前状态推进一次空闲判定，返回下一次周期触发的延迟 */
  nextDelay(kind: TriggerKind): number {
    const base = this.#intervals[kind] || this.#intervals.visual_change;
    const idleFor = this.#now() - this.#lastActivityAt;
    if (idleFor < base) this.#idleStreak = 0;                       // 刚有活动 → 立即恢复全速
    else this.#idleStreak = Math.min(this.#idleStreak + 1, 12);     // 整轮无活动 → 降一档
    return Math.min(base * this.multiplier, this.#idleMax);
  }

  // ── 内部 ─────────────────────────────────────────────
  #fire(kind: TriggerKind, meta?: TriggerMeta): void {
    if (!this.#running) return;
    if (this.#opts.shouldPause?.()) { this.#drops++; return; }
    const t = this.#now();
    if (t - this.#lastCaptureAt < this.#debounceMs) { this.#drops++; return; }
    this.#lastCaptureAt = t;
    this.#captures++;
    try { this.#opts.onCapture(kind, meta); }
    catch { /* 回调异常不许打断定时器 */ }
  }

  #scheduleHeartbeat(delay: number): void {
    if (this.#heartbeat) clearTimeout(this.#heartbeat);
    this.#heartbeat = setTimeout(() => {
      this.#heartbeat = null;
      if (!this.#running) return;
      this.#fire("heartbeat");
      this.#scheduleHeartbeat(this.nextDelay("heartbeat"));
    }, delay);
    this.#heartbeat.unref?.();
  }

  #scheduleVisual(delay: number): void {
    if (this.#visual) clearTimeout(this.#visual);
    this.#visual = setTimeout(() => {
      this.#visual = null;
      if (!this.#running) return;
      this.#fire("visual_change");
      this.#scheduleVisual(this.nextDelay("visual_change"));
    }, delay);
    this.#visual.unref?.();
  }
}
