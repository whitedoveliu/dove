/**
 * cron 调度解析（T6.7）：零依赖自己实现，不引任何 cron 库。
 *  - at   ：ISO 时间（可带偏移）/ 相对时间（30s、5m、2h、1d，支持小数与 ms）
 *  - every：间隔（1000 或 "1s" / "30m" / "1h"）
 *  - cron ：标准 5 段表达式 `分 时 日 月 周`（支持 * , - /）
 * 时区：默认本地时区，任务可用 timezone 覆盖；用 Intl 做墙钟换算，不依赖库。
 */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  毫秒: 1,
  秒: 1_000,
  分钟: 60_000,
  分: 60_000,
  小时: 3_600_000,
  天: 86_400_000,
};

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 校验并解析时区名；非法或缺失都回落到本地时区 */
export function resolveTimezone(tz?: string): string {
  const t = (tz ?? "").trim();
  if (!t) return localTimezone();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: t });
    return t;
  } catch {
    return localTimezone();
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = 周日 … 6 = 周六 */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 把 epoch 毫秒换算成目标时区的墙钟字段 */
export function zonedParts(epochMs: number, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const hourRaw = get("hour") === "24" ? 0 : Number(get("hour"));
  const wd = WEEKDAYS.indexOf(get("weekday"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number.isFinite(hourRaw) ? hourRaw : 0,
    minute: Number(get("minute")),
    weekday: wd < 0 ? 0 : wd,
  };
}

/** 该时刻的时区偏移（毫秒）：本地墙钟 − UTC。分钟精度，够 cron 用 */
export function timezoneOffsetMs(epochMs: number, tz: string): number {
  const p = zonedParts(epochMs, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUTC - Math.floor(epochMs / 60_000) * 60_000;
}

/** 目标时区的墙钟时间 → epoch 毫秒（用两次偏移逼近，能扛住夏令时） */
export function zonedTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = timezoneOffsetMs(guess, tz);
  let ts = guess - off1;
  const off2 = timezoneOffsetMs(ts, tz);
  if (off2 !== off1) ts = guess - off2;
  return ts;
}

/** 解析时长：`30`（默认单位见参数）、`1.5h`、`500ms`、`30分钟` */
export function parseDurationMs(text: string, defaultUnit: "ms" | "s" = "ms"): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|毫秒|秒|分钟|分|小时|天)?$/i.exec((text ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit ? UNIT_MS[unit] : defaultUnit === "s" ? 1_000 : 1;
  if (!mult) return null;
  return Math.round(n * mult);
}

/** `at` 调度：ISO 时间 / `YYYY-MM-DD HH:mm[:ss]`（按任务时区）/ 相对时间（默认单位秒） */
export function parseAtSchedule(schedule: string, nowMs: number, tz: string): number | null {
  const text = (schedule ?? "").trim();
  if (!text) return null;
  const zone = resolveTimezone(tz);
  const relText = text.replace(/^in\s+/i, "").replace(/^\+/, "");
  const dur = parseDurationMs(relText, "s");
  if (dur !== null) return nowMs + dur;
  const iso = Date.parse(text);
  if (Number.isFinite(iso)) return iso;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return zonedTimeToEpoch(Number(y), Number(mo), Number(d), Number(h ?? 0), Number(mi ?? 0), zone);
}

// ── 5 段 cron 表达式 ─────────────────────────────────────────

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** 日 / 周字段是否就是 `*`（决定两者都限定时取「或」还是「与」） */
  dayOfMonthAny: boolean;
  dayOfWeekAny: boolean;
}

const FIELDS: [number, number][] = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周（0 与 7 都是周日）
];

/** 解析单个字段：星号 / 单值 / a-b / 步长（星号-n、a-b-n、a-n = a 到上界）/ 逗号列表 */
function parseField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const chunk of field.split(",")) {
    const slash = chunk.indexOf("/");
    const rangePart = slash >= 0 ? chunk.slice(0, slash) : chunk;
    let step = 1;
    if (slash >= 0) {
      step = Number(chunk.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      lo = Number(rangePart);
      if (!Number.isInteger(lo)) return null;
      // 标准 cron：单值带步长 = 从该值到上界
      hi = slash >= 0 ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

/** 解析 5 段表达式；不合法返回 null */
export function parseCronExpr(expr: string): CronFields | null {
  const parts = (expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const values: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const range = FIELDS[i]!;
    const parsed = parseField(parts[i]!, range[0], range[1]);
    if (!parsed) return null;
    values.push(parsed);
  }
  const dow = values[4]!.map((d) => (d === 7 ? 0 : d));
  return {
    minutes: values[0]!,
    hours: values[1]!,
    daysOfMonth: values[2]!,
    months: values[3]!,
    daysOfWeek: [...new Set(dow)].sort((a, b) => a - b),
    dayOfMonthAny: parts[2] === "*",
    dayOfWeekAny: parts[4] === "*",
  };
}

function dayMatches(f: CronFields, day: number, weekday: number): boolean {
  if (f.dayOfMonthAny && f.dayOfWeekAny) return true;
  const domOk = f.daysOfMonth.includes(day);
  const dowOk = f.daysOfWeek.includes(weekday);
  if (f.dayOfMonthAny) return dowOk;
  if (f.dayOfWeekAny) return domOk;
  return domOk || dowOk; // 两者都限定 → 标准 cron 取「或」
}

/** 下一次触发时间（严格大于 afterMs）；两年内没有就返回 null */
export function nextCronTime(expr: string, afterMs: number, tz?: string): number | null {
  const f = parseCronExpr(expr);
  if (!f) return null;
  const zone = resolveTimezone(tz);
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000; // 从下一分钟开始
  const p0 = zonedParts(start, zone);
  for (let offset = 0; offset <= 366 * 2; offset++) {
    const civil = new Date(Date.UTC(p0.year, p0.month - 1, p0.day + offset));
    const year = civil.getUTCFullYear();
    const month = civil.getUTCMonth() + 1;
    const day = civil.getUTCDate();
    const weekday = civil.getUTCDay();
    if (!f.months.includes(month)) continue;
    if (!dayMatches(f, day, weekday)) continue;
    for (const hour of f.hours) {
      for (const minute of f.minutes) {
        const ts = zonedTimeToEpoch(year, month, day, hour, minute, zone);
        if (ts >= start) return ts;
      }
    }
  }
  return null;
}
