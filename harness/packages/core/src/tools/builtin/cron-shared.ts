/**
 * cron 工具的共用助手（**不是工具**）：调度类型推断与时间显示。
 * 拆出来是因为三个 cron 工具都要用，写在任一个工具文件里会变成「工具 import 工具」。
 */

export const CRON_TYPES = ["at", "every", "cron"] as const;
export const CRON_MODES = ["main", "isolated"] as const;

/** 纯时长：30 / 30s / 5m / 2h / 1d（含中文单位） */
const DURATION_RE = /^\d+(?:\.\d+)?\s*(?:ms|s|m|h|d|毫秒|秒|分|分钟|小时|天)?$/i;
/** 5 段 cron 表达式：分 时 日 月 周 */
const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;
/** ISO / YYYY-MM-DD[ HH:mm] / 带 "in " 或 "+" 前缀的相对时间 */
const AT_RE = /^(?:in\s+|\+)/i;

/**
 * 推断调度类型（只在调用方没给 type 时用）。
 * 顺序有讲究：5 段先判（cron），再判 at 前缀/日期，最后才是纯时长（every）。
 * 纯时长在 at 与 every 之间是**歧义**的（"30m" 两种都合法），这里一律判 every ——
 * 想要一次性任务必须显式写 type:"at"，工具描述里写明了这一点。
 */
export function inferCronType(schedule: string): { type: "at" | "every" | "cron" | null; reason: string } {
  const s = (schedule ?? "").trim();
  if (!s) return { type: null, reason: "schedule 为空" };
  if (CRON_RE.test(s)) return { type: "cron", reason: "5 段表达式 → cron" };
  if (AT_RE.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s)) return { type: "at", reason: "日期/相对时间 → at" };
  if (DURATION_RE.test(s)) return { type: "every", reason: "纯时长 → every（一次性请显式传 type:\"at\"）" };
  return { type: null, reason: "认不出是什么调度，请显式传 type" };
}

/** epoch 毫秒 → 指定时区的人话时间（不带时区名，调用方自己带） */
export function formatAt(ts: number | null | undefined, timeZone: string): string | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

export function clipText(s: string, max = 200): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
