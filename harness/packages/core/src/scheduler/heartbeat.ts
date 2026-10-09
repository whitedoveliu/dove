/**
 * heartbeat（T6.8）：每 30 分钟醒一次，按 <configDir>/HEARTBEAT.md 的清单自检。
 * 纪律：
 *  - 工作时段 ${HEARTBEAT_ACTIVE_HOURS[0]}–${HEARTBEAT_ACTIVE_HOURS[1]} 点，夜间跳过
 *  - 无事发生必须回 HEARTBEAT_OK —— 这个回复要被抑制，不打扰用户
 *  - 只报告「真的需要用户注意」的事
 *  - 单飞：上一轮没跑完就跳过这一轮
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HEARTBEAT_ACTIVE_HOURS, HEARTBEAT_INTERVAL_MS } from "../constants.ts";

export const HEARTBEAT_OK = "HEARTBEAT_OK";
export const HEARTBEAT_FILE = "HEARTBEAT.md";

/** HEARTBEAT.md 缺失时的兜底清单：保证首次启动也能自检 */
export const DEFAULT_HEARTBEAT_CHECKLIST = [
  "# HEARTBEAT · 主动性检查单",
  "",
  "- 有没有没跑完的任务？",
  "- 有没有值得主动汇报的进展？",
  "- 有没有快到期的事情需要提醒？",
].join("\n");

export interface HeartbeatTickResult {
  ran: boolean;
  /** true = 这轮不该打扰用户（HEARTBEAT_OK / 空输出） */
  suppressed?: boolean;
  output?: string;
  /** 机器可读的原因：off-hours / in-flight / heartbeat-ok / empty / run-failed / deliver-failed */
  reason?: string;
}

export interface HeartbeatOptions {
  configDir: string;
  run: (prompt: string) => Promise<string>;
  deliver: (text: string) => void;
  /** 测试注入时钟；缺省 = 真实时间 */
  now?: () => Date;
  /** 测试可缩短间隔；缺省 HEARTBEAT_INTERVAL_MS（30 分钟） */
  intervalMs?: number;
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function formatStamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/** 工作时段判定：左闭右开（8:00 开始，23:00 之前） */
export function inActiveHours(
  hour: number,
  hours: readonly [number, number] = HEARTBEAT_ACTIVE_HOURS,
): boolean {
  return hour >= hours[0] && hour < hours[1];
}

/** 判定「无事发生」：只有 HEARTBEAT_OK（允许尾部标点与空白）才算 */
export function isHeartbeatOk(text: string): boolean {
  return /^HEARTBEAT_OK[。.!！]?$/i.test(text.trim());
}

export class Heartbeat {
  #configDir: string;
  #run: (prompt: string) => Promise<string>;
  #deliver: (text: string) => void;
  #now: () => Date;
  #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight = false;

  constructor(opts: HeartbeatOptions) {
    this.#configDir = opts.configDir;
    this.#run = opts.run;
    this.#deliver = opts.deliver;
    this.#now = opts.now ?? (() => new Date());
    const ms = Number(opts.intervalMs);
    this.#intervalMs = Number.isFinite(ms) && ms > 0 ? ms : HEARTBEAT_INTERVAL_MS;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  get inFlight(): boolean {
    return this.#inFlight;
  }

  /** 启动定时心跳（幂等）；不在启动时立刻跑一轮，避免开机就打扰模型 */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** 立即跑一轮（定时器、手动触发、测试共用） */
  async tick(): Promise<HeartbeatTickResult> {
    const now = this.#now();
    if (!inActiveHours(now.getHours())) return { ran: false, reason: "off-hours" };
    if (this.#inFlight) return { ran: false, reason: "in-flight" };
    this.#inFlight = true;
    try {
      const prompt = this.#buildPrompt(now);
      const output = String((await this.#run(prompt)) ?? "");
      const text = output.trim();
      if (!text) return { ran: true, suppressed: true, output: "", reason: "empty" };
      if (isHeartbeatOk(text)) {
        return { ran: true, suppressed: true, output: text, reason: "heartbeat-ok" };
      }
      try {
        this.#deliver(text);
      } catch (e) {
        return {
          ran: true,
          suppressed: false,
          output: text,
          reason: "deliver-failed: " + (e instanceof Error ? e.message : String(e)),
        };
      }
      return { ran: true, suppressed: false, output: text };
    } catch (e) {
      return { ran: false, reason: "run-failed: " + (e instanceof Error ? e.message : String(e)) };
    } finally {
      this.#inFlight = false;
    }
  }

  /** 读 HEARTBEAT.md；缺失或空白时用兜底清单 */
  checklist(): string {
    const path = join(this.#configDir, HEARTBEAT_FILE);
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8").trim();
        if (text) return text;
      }
    } catch {
      // 读失败按缺失处理
    }
    return DEFAULT_HEARTBEAT_CHECKLIST;
  }

  #buildPrompt(now: Date): string {
    return [
      "你是 Dove，现在是一次心跳自检（不是用户发来的消息）。",
      `当前时间：${formatStamp(now)}。`,
      "",
      "按下面的清单检查你自己和这个工作台：",
      this.checklist(),
      "",
      "输出规则：",
      "1. 只有「真的需要用户注意」的事情才输出内容，一到三句话，直接说要紧的，不要寒暄。",
      "2. 没有需要汇报的事情，只回复 HEARTBEAT_OK（不要加任何其他字）。",
      "3. 不要为了刷存在感而汇报无关紧要的小事。",
    ].join("\n");
  }
}
