/**
 * 疲劳（T6.6 / 答疑 p09）：0–100，能量与疲劳互补（能量 = 100 − 疲劳）。
 * 没有 LLM API 也能工作：疲劳随真实时间自然增长，睡着时快速回落，不依赖任何网络调用。
 * 状态：awake（清醒）/ tired（有点累）/ sleepy（很困）/ sleeping（睡着）
 * 存储：<configDir>/fatigue.json
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./frontmatter.ts";

export const FATIGUE_MIN = 0;
export const FATIGUE_MAX = 100;
/** 醒着每小时自然增长 */
export const FATIGUE_AWAKE_PER_HOUR = 4;
/** 睡着每小时回落 */
export const FATIGUE_SLEEP_PER_HOUR = 15;
/** 主动小憩每小时回落（比自然增长快得多，才叫「休息」） */
export const FATIGUE_REST_PER_HOUR = 24;
/** 状态阈值 */
export const FATIGUE_TIRED_AT = 55;
export const FATIGUE_SLEEPY_AT = 80;
/** 睡着时回落到这里就自然醒 */
export const FATIGUE_WAKE_AT = 8;
export const FATIGUE_DEFAULT_REST_MINUTES = 20;

/**
 * 空闲多久算「睡过一觉」。
 *
 * 为什么必须有这条规则（真栽过）：疲劳/清醒时长全靠 `sleep()` / `wake()` 复位，
 * 而**没有任何生产调用方**去调它们（只有 `/api/fatigue` 路由与冒烟脚本），
 * 于是 `awakeSince` 从第一次运行起就冻住 —— 实测 `~/.dove/fatigue.json` 停在 10-06，
 * 到了 10-14 模型每轮都被告知「已连续清醒 206 小时、疲劳 100/100 / 能量 0」。
 * 规则：醒着且距上次落库超过这个时长 → 这一段按睡眠算（疲劳按睡眠速率回落，
 * 醒来时间就是现在）。于是「连续清醒」的上界就是它，不依赖任何外部调度器记得调 sleep()。
 */
export const FATIGUE_IDLE_SLEEP_AFTER_HOURS = 3;

export type FatigueState = "awake" | "tired" | "sleepy" | "sleeping";

export const FATIGUE_STATE_LABEL: Record<FatigueState, string> = {
  awake: "清醒",
  tired: "有点累",
  sleepy: "很困",
  sleeping: "睡着",
};

export interface FatigueRecord {
  fatigue: number;
  sleeping: boolean;
  /** 上次落库时间（自然增长从这个时间点算起） */
  updatedAt: number;
  /** 本次清醒 / 本次睡眠的起点 */
  awakeSince: number;
  note?: string;
}

export interface FatigueSnapshot {
  fatigue: number;
  /** 能量与疲劳同步：100 − 疲劳 */
  energy: number;
  state: FatigueState;
  sleeping: boolean;
  /** sleeping 时 = 已睡小时数；否则 = 已连续清醒小时数 */
  hours: number;
  note?: string;
  updatedAt: number;
  hint: string;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return FATIGUE_MIN;
  return Math.round(Math.max(FATIGUE_MIN, Math.min(FATIGUE_MAX, n)) * 10) / 10;
}

function hintFor(state: FatigueState, hours: number): string {
  if (state === "sleeping") return "正在睡觉，除非用户叫醒，否则不要主动干活。";
  if (state === "sleepy") return "该提醒用户休息了；用户坚持继续时，先简短说明状态，再照做。";
  if (state === "tired") return "可以顺口建议用户休息一下，别硬撑。";
  if (hours >= 10) return "已经连续清醒很久了，注意别硬撑。";
  return "状态还行，不用提醒休息。";
}

export interface FatigueServiceOptions {
  configDir: string;
  /** 测试注入时钟；缺省 = 真实时间 */
  now?: () => Date;
}

export class FatigueService {
  #file: string;
  #now: () => Date;
  #state: FatigueRecord;

  constructor(opts: FatigueServiceOptions) {
    this.#file = join(opts.configDir, "fatigue.json");
    this.#now = opts.now ?? (() => new Date());
    this.#state = this.#load();
  }

  get path(): string {
    return this.#file;
  }

  /**
   * 当前快照（已按经过时间推进）。**推进过的状态会顺手落盘**（一分钟粒度）。
   *
   * 为什么不能纯读：`updatedAt` 只由 sleep/wake/rest/set 推进，而这几条在生产里没人调 ——
   * 只读不落盘的话，`updatedAt` 永远停在老值：疲劳每读一次就从同一个老起点重算一遍
   * （越算越大），「空闲算睡」那条规则也会每次都从同一个老起点重新推、永远睡不着。
   * 落盘节流到一分钟：读的频率远高于一分钟（每轮对话、面板轮询），不值得每次都写盘。
   */
  snapshot(): FatigueSnapshot {
    const now = this.#nowMs();
    const next = this.#apply(now);
    if (next.updatedAt !== this.#state.updatedAt && next.updatedAt - this.#state.updatedAt >= 60_000) {
      this.#save(next);
    }
    return this.#project(next, now);
  }

  /** 去睡觉：转成 sleeping，之后疲劳按 FATIGUE_SLEEP_PER_HOUR 快速回落 */
  sleep(): void {
    const now = this.#nowMs();
    const s = this.#apply(now);
    s.sleeping = true;
    s.awakeSince = now;
    s.updatedAt = now;
    this.#save(s);
  }

  /** 醒来：转成 awake，重新开始计清醒时长 */
  wake(): void {
    const now = this.#nowMs();
    const s = this.#apply(now);
    s.sleeping = false;
    s.awakeSince = now;
    s.updatedAt = now;
    this.#save(s);
  }

  /** 小憩 minutes 分钟：疲劳下降，其余状态不变 */
  rest(minutes: number = FATIGUE_DEFAULT_REST_MINUTES): void {
    const now = this.#nowMs();
    const s = this.#apply(now);
    const m = Number.isFinite(minutes) ? Math.max(0, minutes) : FATIGUE_DEFAULT_REST_MINUTES;
    const rate = s.sleeping ? FATIGUE_SLEEP_PER_HOUR : FATIGUE_REST_PER_HOUR;
    s.fatigue = clamp(s.fatigue - (m / 60) * rate);
    s.updatedAt = now;
    this.#save(s);
  }

  /** 直接落一个疲劳值（面板 / 测试用），可带一句备注 */
  set(fatigue: number, note?: string): void {
    const now = this.#nowMs();
    const s = this.#apply(now);
    s.fatigue = clamp(fatigue);
    if (note !== undefined) s.note = note.trim() || undefined;
    s.updatedAt = now;
    this.#save(s);
  }

  /** 渲染成注入 mt 尾部的短块（3–6 行，每轮都变，绝不进系统提示词） */
  renderBlock(): string {
    const s = this.snapshot();
    const head = `状态：${FATIGUE_STATE_LABEL[s.state]}（疲劳 ${Math.round(s.fatigue)}/100，能量 ${Math.round(s.energy)}）。`;
    const when =
      s.state === "sleeping"
        ? `已经睡了 ${s.hours.toFixed(1)} 小时。`
        : `已连续清醒 ${s.hours.toFixed(1)} 小时。`;
    const note = s.note ? `备注：${s.note}` : "";
    return [head, when, `建议：${s.hint}`, note].filter((l) => l.length > 0).join("\n");
  }

  #nowMs(): number {
    const t = this.#now().getTime();
    return Number.isFinite(t) ? t : Date.now();
  }

  /** 把记录按经过时间推进到 now（纯函数，不改 this.#state） */
  #apply(now: number): FatigueRecord {
    const s = this.#state;
    const elapsed = Math.max(0, now - s.updatedAt);
    if (elapsed === 0) return { ...s };
    const hours = elapsed / 3_600_000;
    if (!s.sleeping) {
      // 空闲超过阈值 = 没人记这一觉（生产里没人调 sleep()）→ 按睡过处理。
      // 不这么做，「连续清醒」会无限累积（实测冻到 206 小时）。
      if (hours >= FATIGUE_IDLE_SLEEP_AFTER_HOURS) {
        return {
          ...s,
          fatigue: clamp(s.fatigue - hours * FATIGUE_SLEEP_PER_HOUR),
          awakeSince: now,
          updatedAt: now,
        };
      }
      return { ...s, fatigue: clamp(s.fatigue + hours * FATIGUE_AWAKE_PER_HOUR), updatedAt: now };
    }
    // 睡着：先按睡眠速率回落；睡够了就自然醒，醒来后的时间按清醒速率重新累积
    const needHours = Math.max(0, (s.fatigue - FATIGUE_WAKE_AT) / FATIGUE_SLEEP_PER_HOUR);
    if (hours < needHours) {
      return { ...s, fatigue: clamp(s.fatigue - hours * FATIGUE_SLEEP_PER_HOUR), updatedAt: now };
    }
    const wakeAt = s.updatedAt + needHours * 3_600_000;
    const awakeHours = (now - wakeAt) / 3_600_000;
    return {
      ...s,
      sleeping: false,
      awakeSince: wakeAt,
      fatigue: clamp(FATIGUE_WAKE_AT + awakeHours * FATIGUE_AWAKE_PER_HOUR),
      updatedAt: now,
    };
  }

  #project(s: FatigueRecord, now: number): FatigueSnapshot {
    const fatigue = clamp(s.fatigue);
    const state: FatigueState = s.sleeping
      ? "sleeping"
      : fatigue >= FATIGUE_SLEEPY_AT
        ? "sleepy"
        : fatigue >= FATIGUE_TIRED_AT
          ? "tired"
          : "awake";
    const hours = Math.max(0, (now - s.awakeSince) / 3_600_000);
    return {
      fatigue,
      energy: clamp(FATIGUE_MAX - fatigue),
      state,
      sleeping: s.sleeping,
      hours,
      note: s.note,
      updatedAt: s.updatedAt,
      hint: hintFor(state, hours),
    };
  }

  #load(): FatigueRecord {
    const now = this.#nowMs();
    const fallback: FatigueRecord = { fatigue: 0, sleeping: false, updatedAt: now, awakeSince: now };
    if (!existsSync(this.#file)) return fallback;
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<FatigueRecord>;
      const fatigue = Number(raw?.fatigue);
      const updatedAt = Number(raw?.updatedAt);
      const awakeSince = Number(raw?.awakeSince);
      return {
        fatigue: Number.isFinite(fatigue) ? clamp(fatigue) : 0,
        sleeping: raw?.sleeping === true,
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now,
        awakeSince: Number.isFinite(awakeSince) && awakeSince > 0 ? awakeSince : now,
        note: typeof raw?.note === "string" && raw.note.trim() ? raw.note.trim() : undefined,
      };
    } catch {
      return fallback;
    }
  }

  #save(s: FatigueRecord): void {
    this.#state = s;
    atomicWriteText(this.#file, JSON.stringify(s, null, 2) + "\n");
  }
}
