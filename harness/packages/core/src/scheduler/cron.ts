/**
 * cron 调度器（T6.7）：任务定义落 SQLite，每次执行落历史 + 收据。
 *  - 调度精度：默认 30 秒 tick 就够；临近触发时自动缩短等待，不空转
 *  - main / isolated 的区别由注入的 run 回调决定（调度器不认识线程）
 *  - 一次性 at 任务触发后自动禁用，并留收据（cron_history.receipt + 收据文件）
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../session/db.ts";
import type { Row } from "../session/db.ts";
import { clipText, computeNextRun, isJobMode, isJobType, rowToJob, rowToRun, safeFileName } from "./cron-model.ts";
import type { CronJob, CronRun, CronRunResult, CronTrigger } from "./cron-model.ts";
import { CRON_HISTORY_LIMIT, CRON_MIN_TICK_MS, CRON_TICK_MS } from "./cron-model.ts";
import { CRON_MIN_SANE_INTERVAL_MS } from "../constants.ts";

export interface CronSchedulerOptions {
  db: Db;
  /** 真正执行任务；返回给用户看的文本。main / isolated 的差异在这里实现 */
  run: (job: CronJob) => Promise<string>;
  configDir: string;
  /** 测试注入时钟；缺省 = Date.now */
  now?: () => number;
  /** 测试可缩短 tick；缺省 CRON_TICK_MS */
  tickMs?: number;
}

/** "2s" / "30m" / "1h" → 毫秒；认不出来返回 null */
export function parseEveryToMs(spec: string): number | null {
  const m = /^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/.exec(spec ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ?? "s";
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

export class CronScheduler {
  #db: Db;
  #runJob: (job: CronJob) => Promise<string>;
  #configDir: string;
  #now: () => number;
  #tickMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #ticking = false;
  #running = new Set<string>();

  constructor(opts: CronSchedulerOptions) {
    this.#db = opts.db;
    this.#runJob = opts.run;
    this.#configDir = opts.configDir;
    this.#now = opts.now ?? (() => Date.now());
    const tick = Number(opts.tickMs);
    this.#tickMs = Number.isFinite(tick) && tick > 0 ? Math.max(CRON_MIN_TICK_MS, tick) : CRON_TICK_MS;
  }

  get running(): boolean {
    return !this.#stopped;
  }

  /**
   * 启动前的安全检查：有没有「间隔短到会烧钱」的定时任务。
   *
   * 为什么要这个：实测踩过一次 —— 冒烟测试建的「每 2 秒报一次时」落进了生产库，
   * 而且因为重复跑测试攒成 4 个副本。App 一启动，这 4 个任务同时每 2 秒
   * 调一次模型，25 分钟跑了 1080 轮（约 900 万 input tokens）。
   *
   * 这类事故**不会报错**，只会安静地烧钱 —— 所以启动时必须吼一声。
   */
  #warnOnAggressiveJobs(): void {
    try {
      const jobs = this.list().filter((j) => j.enabled && j.type === "every");
      const hot = jobs.filter((j) => {
        const ms = parseEveryToMs(j.schedule);
        return ms !== null && ms > 0 && ms < CRON_MIN_SANE_INTERVAL_MS;
      });
      if (hot.length === 0) return;
      const detail = hot.map((j) => `${j.name}（${j.schedule}）`).join("、");
      console.warn(
        `[cron] ⚠️ 有 ${hot.length} 个启用中的定时任务间隔短于 ${CRON_MIN_SANE_INTERVAL_MS / 1000} 秒：${detail}。` +
        `\n        每个任务每次触发都会真实调用模型 —— 间隔 2 秒意味着每分钟 30 轮。` +
        `\n        如果不是有意为之，用面板的「任务」页停掉它们。`,
      );
    } catch { /* 检查失败不能挡住启动 */ }
  }

  /** 启动调度循环（幂等）；启动时不立即执行，等一个 tick */
  start(): void {
    this.#warnOnAggressiveJobs();
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#arm();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** 建任务；schedule 不合法直接抛错，避免建出一个永远不触发的僵尸 */
  create(job: Partial<CronJob>): CronJob {
    const now = this.#now();
    const type = isJobType(job.type) ? job.type : "every";
    const mode = isJobMode(job.mode) ? job.mode : "main";
    const schedule = String(job.schedule ?? "").trim();
    if (!schedule) throw new Error("cron 任务缺少 schedule");
    const timezone = job.timezone ? String(job.timezone) : undefined;
    const first = computeNextRun({ type, schedule, timezone }, now, null);
    if (first === null) throw new Error(`无法解析的 ${type} 调度：${schedule}`);
    const enabled = job.enabled !== false;
    const row: CronJob = {
      id: job.id ? String(job.id) : randomUUID().slice(0, 12),
      name: String(job.name ?? "").trim() || "未命名任务",
      type,
      schedule,
      mode,
      prompt: String(job.prompt ?? ""),
      deliverTo: job.deliverTo ? String(job.deliverTo) : undefined,
      model: job.model ? String(job.model) : undefined,
      timezone,
      enabled,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: enabled ? first : null,
      runCount: 0,
    };
    this.#db.run(
      "INSERT INTO cron_jobs(id, name, type, schedule, mode, prompt, deliver_to, model, timezone, enabled, created_at, updated_at, last_run_at, next_run_at, run_count) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)",
      row.id, row.name, row.type, row.schedule, row.mode, row.prompt,
      row.deliverTo ?? null, row.model ?? null, row.timezone ?? null,
      row.enabled ? 1 : 0, row.createdAt, row.updatedAt, row.nextRunAt ?? null,
    );
    return row;
  }

  list(): CronJob[] {
    return this.#db.all<Row>("SELECT * FROM cron_jobs ORDER BY created_at ASC").map(rowToJob);
  }

  get(id: string): CronJob | undefined {
    const row = this.#db.get<Row>("SELECT * FROM cron_jobs WHERE id = ?", id);
    return row ? rowToJob(row) : undefined;
  }

  remove(id: string): boolean {
    const row = this.#db.get<Row>("SELECT id FROM cron_jobs WHERE id = ?", id);
    if (!row) return false;
    this.#db.run("DELETE FROM cron_jobs WHERE id = ?", id);
    this.#running.delete(id);
    return true;
  }

  /** 开关任务；打开时重算下一次触发时间 */
  enable(id: string, on: boolean): boolean {
    const job = this.get(id);
    if (!job) return false;
    const now = this.#now();
    const next = on ? computeNextRun(job, now, null) : null;
    this.#db.run(
      "UPDATE cron_jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      on ? 1 : 0, next, now, id,
    );
    if (!on) this.#running.delete(id);
    return true;
  }

  /** 立即执行一次，不等调度（不改调度节奏，也不消费一次性任务） */
  async runNow(id: string): Promise<CronRunResult> {
    const job = this.get(id);
    if (!job) return { ok: false, error: "任务不存在：" + id };
    if (this.#running.has(id)) return { ok: false, error: "任务正在执行中" };
    const run = await this.#execute(job, "manual");
    return run.ok ? { ok: true, result: run.result ?? "" } : { ok: false, error: run.error ?? "执行失败" };
  }

  history(id?: string, limit: number = CRON_HISTORY_LIMIT): CronRun[] {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : CRON_HISTORY_LIMIT;
    const rows = id
      ? this.#db.all<Row>("SELECT * FROM cron_history WHERE job_id = ? ORDER BY started_at DESC LIMIT ?", id, n)
      : this.#db.all<Row>("SELECT * FROM cron_history ORDER BY started_at DESC LIMIT ?", n);
    return rows.map(rowToRun);
  }

  /** 扫一轮：把到期任务跑掉。定时循环、手动触发、测试都用它 */
  async tick(): Promise<{ ran: number }> {
    if (this.#ticking) return { ran: 0 };
    this.#ticking = true;
    try {
      const now = this.#now();
      const rows = this.#db.all<Row>(
        "SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
        now,
      );
      let ran = 0;
      for (const row of rows) {
        const job = rowToJob(row);
        if (this.#running.has(job.id)) continue; // 单飞：上一轮没跑完就跳过
        await this.#execute(job, "schedule");
        ran++;
      }
      return { ran };
    } finally {
      this.#ticking = false;
    }
  }

  async #execute(job: CronJob, trigger: CronTrigger): Promise<CronRun> {
    const startedAt = this.#now();
    const id = randomUUID().slice(0, 12);
    // 先把调度推进到位：执行再慢也不会导致同一个点被重复触发
    const receipt = trigger === "schedule" ? this.#advance(job, startedAt) : null;
    this.#db.run(
      "INSERT INTO cron_history(id, job_id, job_name, started_at, trigger, ok, receipt) VALUES (?, ?, ?, ?, ?, 0, ?)",
      id, job.id, job.name, startedAt, trigger, receipt,
    );
    this.#running.add(job.id);
    let ok = true;
    let result = "";
    let error = "";
    try {
      result = String((await this.#runJob(job)) ?? "");
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      this.#running.delete(job.id);
    }
    const finishedAt = this.#now();
    this.#db.run(
      "UPDATE cron_history SET finished_at = ?, ok = ?, result = ?, error = ? WHERE id = ?",
      finishedAt, ok ? 1 : 0, clipText(result), clipText(error), id,
    );
    this.#db.run(
      "UPDATE cron_jobs SET last_run_at = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?",
      startedAt, finishedAt, job.id,
    );
    if (receipt) this.#writeReceipt(job, receipt, result, error, startedAt);
    return {
      id, jobId: job.id, jobName: job.name, startedAt, finishedAt,
      ok, result: result || undefined, error: error || undefined, trigger,
      receipt: receipt ?? undefined,
    };
  }

  /** 推进调度；一次性任务返回收据文本，其余返回 null */
  #advance(job: CronJob, now: number): string | null {
    if (job.type === "at") {
      this.#db.run("UPDATE cron_jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?", now, job.id);
      return `一次性任务「${job.name}」已于 ${new Date(now).toISOString()} 触发，已自动禁用；原定：${job.schedule}。`;
    }
    const next = computeNextRun(job, now, job.nextRunAt ?? null);
    if (next === null) {
      this.#db.run("UPDATE cron_jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?", now, job.id);
      return `任务「${job.name}」的调度 ${job.type}:${job.schedule} 已无下一次触发，自动禁用。`;
    }
    this.#db.run("UPDATE cron_jobs SET next_run_at = ?, updated_at = ? WHERE id = ?", next, now, job.id);
    return null;
  }

  #writeReceipt(job: CronJob, receipt: string, result: string, error: string, at: number): void {
    try {
      const dir = join(this.#configDir, "cron", "receipts");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
      const body = [
        `# 收据 · ${job.name}`,
        "",
        `- 时间：${new Date(at).toISOString()}`,
        `- 调度：${job.type} / ${job.schedule}${job.timezone ? " (" + job.timezone + ")" : ""}`,
        `- 模式：${job.mode}`,
        "",
        receipt,
        "",
        "## 本次输出",
        error ? "失败：" + error : result || "（无输出）",
        "",
      ].join("\n");
      writeFileSync(join(dir, `${stamp}-${safeFileName(job.name)}.md`), body, "utf8");
    } catch {
      // 收据文件写失败不影响任务本身；DB 里的 receipt 已经留下
    }
  }

  #arm(): void {
    if (this.#stopped) return;
    const now = this.#now();
    const row = this.#db.get<Row>(
      "SELECT MIN(next_run_at) AS t FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL",
    );
    const due = Number(row?.t);
    const delay = Number.isFinite(due)
      ? Math.min(this.#tickMs, Math.max(CRON_MIN_TICK_MS, due - now))
      : this.#tickMs;
    const timer = setTimeout(() => {
      this.#timer = null;
      void this.tick().finally(() => this.#arm());
    }, delay);
    timer.unref?.();
    this.#timer = timer;
  }
}

// 上层只需要 import cron.ts：模型与常量一并再导出
export * from "./cron-model.ts";
