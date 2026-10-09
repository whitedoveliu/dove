/**
 * cron 任务模型与行映射（T6.7）：类型 / 常量 / 调度计算 / SQLite 行 ↔ 对象。
 * 调度器本体在 cron.ts；拆开是因为两者都容易超过 400 行硬约束。
 */
import type { Row } from "../session/db.ts";
import { nextCronTime, parseAtSchedule, parseDurationMs, resolveTimezone } from "./cron-parse.ts";

/** 调度精度：30 秒扫一次就够（不要秒级） */
export const CRON_TICK_MS = 30_000;
/** 临近触发时的等待下限（用于精确落点） */
export const CRON_MIN_TICK_MS = 200;
export const CRON_HISTORY_LIMIT = 50;
export const CRON_JOB_TYPES = ["at", "every", "cron"] as const;
export const CRON_JOB_MODES = ["main", "isolated"] as const;

export type CronJobType = (typeof CRON_JOB_TYPES)[number];
export type CronJobMode = (typeof CRON_JOB_MODES)[number];
export type CronTrigger = "schedule" | "manual";

export interface CronJob {
  id: string;
  name: string;
  type: CronJobType;
  /** at: ISO / 相对时间；every: 间隔；cron: 5 段表达式 */
  schedule: string;
  mode: CronJobMode;
  prompt: string;
  /** 结果投递目标（主线程 / 会话）；含义由上层解释 */
  deliverTo?: string;
  model?: string;
  /** 缺省 = 本地时区 */
  timezone?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  runCount: number;
}

export interface CronRun {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: number;
  finishedAt?: number | null;
  ok: boolean;
  result?: string;
  error?: string;
  trigger: CronTrigger;
  /** 一次性任务的收据文本 */
  receipt?: string;
}

export interface CronRunResult {
  ok: boolean;
  result?: string;
  error?: string;
}

export function isJobType(v: unknown): v is CronJobType {
  return CRON_JOB_TYPES.includes(v as CronJobType);
}

export function isJobMode(v: unknown): v is CronJobMode {
  return CRON_JOB_MODES.includes(v as CronJobMode);
}

/** 计算下一次触发时间；anchor 用于 every 保持节奏（不被执行耗时拖偏） */
export function computeNextRun(
  job: Pick<CronJob, "type" | "schedule" | "timezone">,
  nowMs: number,
  anchor?: number | null,
): number | null {
  const tz = resolveTimezone(job.timezone);
  if (job.type === "at") {
    const ts = parseAtSchedule(job.schedule, nowMs, tz);
    return ts !== null && ts > nowMs ? ts : null;
  }
  if (job.type === "every") {
    const interval = parseDurationMs(job.schedule, "ms");
    if (!interval || interval <= 0) return null;
    let next = (anchor && anchor > 0 ? anchor : nowMs) + interval;
    while (next <= nowMs) next += interval; // 睡过头的补跑一律跳过，不雪崩
    return next;
  }
  return nextCronTime(job.schedule, nowMs, tz);
}

function str(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

export function rowToJob(row: Row): CronJob {
  return {
    id: String(row.id),
    name: String(row.name),
    type: String(row.type) as CronJobType,
    schedule: String(row.schedule),
    mode: String(row.mode) as CronJobMode,
    prompt: String(row.prompt ?? ""),
    deliverTo: str(row.deliver_to),
    model: str(row.model),
    timezone: str(row.timezone),
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastRunAt: num(row.last_run_at),
    nextRunAt: num(row.next_run_at),
    runCount: Number(row.run_count ?? 0),
  };
}

export function rowToRun(row: Row): CronRun {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    jobName: String(row.job_name ?? ""),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    ok: Number(row.ok) === 1,
    result: str(row.result),
    error: str(row.error),
    trigger: String(row.trigger) === "manual" ? "manual" : "schedule",
    receipt: str(row.receipt),
  };
}

export function safeFileName(name: string): string {
  const s = (name ?? "").replace(/[^A-Za-z0-9\u4e00-\u9fa5._-]/g, "").slice(0, 40);
  return s || "job";
}

export function clipText(text: string, max = 4_000): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}
