/**
 * 重复调用断路器（最便宜的反死循环护栏）
 *
 * 病灶：模型卡住时最典型的动作是「原样重试」——同一个工具、同一份参数，结果当然一模一样。
 * dove 之前只有「续跑次数」计数（auto-continue ≤10 / completion-guard ≤3，见 loop/gates.ts），
 * 那是按**回合**数的，一轮里原地重试 20 次工具调用完全不受约束 —— 又慢又烧钱。
 * 对照：Kimi Code 按 (工具名 + 规范化参数) 在 3/5/8/12 次重复时分级干预，最后强制一步纯文本。
 *
 * 分级（阈值取自 constants.ts 的 REPEAT_BREAKER_LEVELS，单点定义）：
 *   3  → 轻提醒；5 → 硬提醒（明说「你在重复同一个调用」）；8 → 本批剩余调用不再执行；
 *   12 → 直接终止这一轮。
 * **每个 key 只在某一档首次命中时给动作**：每次都发提醒的话，提醒本身就变成噪声，
 * 模型会把上下文里最显眼的东西当成主题，反而更绕不出来。
 *
 * key 的规范化：JSON 解析后**按 key 排序**再序列化，`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 同 key ——
 * 模型每次重试时参数键顺序抖动很常见（不同 provider 的序列化顺序不一样），不规范化就漏判。
 * 解析失败（参数是半截 JSON、被截断的流）退回原始串 trim 后比较：**不抛错**，护栏不许自己变成故障源。
 */
import { REPEAT_BREAKER_LEVELS } from "../constants.ts";

export interface BreakerDecision {
  /** 要注入给模型的话（走既有 injection 通道，见 loop/turn.ts） */
  reminder?: string;
  /** 本轮剩余调用不要再执行 */
  stopBatch?: boolean;
  /** 直接结束这一轮 */
  fail?: boolean;
}

export interface RepeatBreaker {
  /** 记一次调用；只有「该档位首次命中」时才带动作返回 */
  note(call: { id: string; name: string; arguments: string }): BreakerDecision;
  /** 清空计数（新一轮开始时调用） */
  reset(): void;
  /** 当前各 key 的次数（诊断 / 测试用，多的在前） */
  summary(): { key: string; count: number }[];
}

const [LEVEL_REMIND, LEVEL_HARD, LEVEL_STOP, LEVEL_FAIL] = REPEAT_BREAKER_LEVELS;

/** 递归按键名排序，保证同一份参数无论键序怎么抖都得到同一个串 */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonical((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * 调用指纹：工具名 + 规范化参数。
 * ⚠️ **不用调用 id** —— 同一个调用重试时 provider 每次给的 id 都是新的，
 *    拿它做 key 就永远数不到重复（这正是以前漏掉这个护栏的原因之一）。
 */
export function repeatKey(name: string, args: string): string {
  const raw = (args ?? "").trim();
  // 无参调用的 arguments 常是空串（也有 provider 给 "{}"）：两者必须同 key
  if (raw === "") return `${name}\u0000{}`;
  try {
    return `${name}\u0000${JSON.stringify(canonical(JSON.parse(raw)))}`;
  } catch {
    return `${name}\u0000${raw}`;
  }
}

function lightReminder(name: string): string {
  return [
    "<system-reminder>",
    `检测到你正在重复同一个调用：${name}（参数与上一次完全相同，这是第 ${LEVEL_REMIND} 次）。`,
    "结果不会因为重试而改变 —— 先看一下上一次的结果，再决定下一步。",
    "</system-reminder>",
  ].join("\n");
}

function hardReminder(name: string): string {
  return [
    "<system-reminder>",
    `**你在原地打转**：同一个 ${name} 调用（参数一字不改）已经第 ${LEVEL_HARD} 次了。`,
    "不要再重复这次调用 —— 换参数、换工具，或者把卡住的点直接告诉用户。",
    "</system-reminder>",
  ].join("\n");
}

export function createRepeatBreaker(): RepeatBreaker {
  const counts = new Map<string, number>();
  /** 每个 key 已经报过的档位 —— 只认「首次命中」，否则提醒本身变成噪声 */
  const fired = new Map<string, Set<number>>();

  return {
    note(call) {
      const key = repeatKey(call.name, call.arguments);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);

      let done = fired.get(key);
      if (!done) { done = new Set<number>(); fired.set(key, done); }
      if (done.has(n)) return {};   // 这一档早报过了（比如同一批里的第 3、4、5 次）

      let decision: BreakerDecision;
      if (n === LEVEL_REMIND) decision = { reminder: lightReminder(call.name) };
      else if (n === LEVEL_HARD) decision = { reminder: hardReminder(call.name) };
      else if (n === LEVEL_STOP) decision = { stopBatch: true };
      else if (n === LEVEL_FAIL) decision = { fail: true };
      else return {};
      done.add(n);
      return decision;
    },

    reset() {
      counts.clear();
      fired.clear();
    },

    summary() {
      return [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count);
    },
  };
}
