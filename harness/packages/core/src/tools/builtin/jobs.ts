/**
 * 后台任务注册表（Bash / BashOutput / KillShell 共用）
 * 进程内单例：jobId → 状态 + 输出缓冲。
 * 说明：后台任务在**源头**按流截断（内存保护），前台 Bash 不截断（交给 budget.ts）。
 *
 * 缓冲策略：**丢头保尾**（Alma §3.2.1，上限 200,000 字符/流）。
 *   旧写法 `next.slice(0, MAX)` 是丢尾保头 —— 长跑任务（dev server / 训练日志）跑一阵后，
 *   模型能看到的永远是**最初**那一屏，最新的报错/进度永远拿不到。现在超限时从头部裁掉、
 *   保留尾部，并把丢了多少字符记在案，BashOutput 据此明说「更早的输出已被丢弃」。
 *
 * 停滞守卫（Alma §3.2.1）：运行中连续 stall 阈值没有新输出 → stalled。
 *   只标注、不杀进程：模型需要知道「它可能卡住了」，等 / 催 / 杀由它自己决定。
 *   阈值可配（DOVE_JOB_STALL_MS）—— 冒烟测试把它压到几百毫秒，不用真等 90 秒。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export const MAX_JOB_STREAM_CHARS = 200_000;

/** 停滞判定阈值：默认 90 秒（Alma §3.2.1）。DOVE_JOB_STALL_MS 可调（测试/联调）。 */
export const JOB_STALL_MS = 90_000;
export function jobStallMs(): number {
  const raw = Number(process.env.DOVE_JOB_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : JOB_STALL_MS;
}

/**
 * 前台 Bash 的自动转后台阈值：默认 60 秒（Alma §3.2.1）。
 * 未显式给 timeout 的命令跑满这个时间，会被收编成后台任务（bash.ts 调 adoptJob），
 * 工具立即返回 job_id —— 前台窗口不是用来干等的。
 * DOVE_AUTO_BACKGROUND_MS 可调：测试把它压小，否则每条用例都要真等一分钟。
 */
export const AUTO_BACKGROUND_MS = 60_000;
export function autoBackgroundMs(): number {
  const raw = Number(process.env.DOVE_AUTO_BACKGROUND_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : AUTO_BACKGROUND_MS;
}

export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface JobRecord {
  id: string;
  command: string;
  cwd: string;
  threadId: string;
  status: JobStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  finishedAt?: number;
  /** 最近一次收到输出的时刻（停滞判定用）；启动时 = startedAt */
  lastOutputAt: number;
  /** 丢头保尾时累计丢掉的字符数（BashOutput 要明确告诉模型「更早的输出被丢弃」） */
  droppedStdout: number;
  droppedStderr: number;
  outputCapped: boolean;
  child?: ChildProcess;
}

const jobs = new Map<string, JobRecord>();
const waiters = new Map<string, (job: JobRecord) => void>();
let seq = 0;

function newJobId(): string {
  return "sh_" + Date.now().toString(36) + "_" + (++seq).toString(36);
}

function finish(job: JobRecord, code: number | null, signal: string | null, status: JobStatus): void {
  if (job.finishedAt) return;
  job.exitCode = code;
  job.signal = signal;
  job.status = job.status === "killed" ? "killed" : status;
  job.finishedAt = Date.now();
  const w = waiters.get(job.id);
  if (w) { waiters.delete(job.id); w(job); }
}

/**
 * 丢头保尾时的安全切点：如果切在代理对（emoji 等星形平面字符占两个 UTF-16 单元）中间，
 * 往后挪一位。不挪的话，每次切点都会在缓冲开头留下一个孤立代理项，
 * 送去 JSON 序列化/编码时静默变成 U+FFFD —— 模型看到的是乱码，还以为是程序输出坏了。
 */
function safeTail(s: string, keep: number): string {
  const tail = s.slice(s.length - keep);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/** 追加一段输出：超上限时**丢头保尾** —— 新的永远在，先扔最老的 */
function appendChunk(job: JobRecord, which: "stdout" | "stderr", chunk: string): void {
  if (!chunk) return;
  job.lastOutputAt = Date.now();
  const next = job[which] + chunk;
  if (next.length <= MAX_JOB_STREAM_CHARS) { job[which] = next; return; }
  const dropped = next.length - MAX_JOB_STREAM_CHARS;
  job[which] = safeTail(next, MAX_JOB_STREAM_CHARS);
  if (which === "stdout") job.droppedStdout += dropped; else job.droppedStderr += dropped;
  job.outputCapped = true;
}

/** 给子进程挂「写入 job 缓冲 + 结束落状态」的监听（startJob 与 adoptJob 共用） */
function wireChild(job: JobRecord): void {
  const child = job.child!;
  child.stdout?.on("data", (c: Buffer) => appendChunk(job, "stdout", c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => appendChunk(job, "stderr", c.toString("utf8")));
  child.on("error", (e) => {
    appendChunk(job, "stderr", "\n[spawn error] " + e.message);
    finish(job, null, null, "failed");
  });
  child.on("close", (code, signal) => finish(job, code, signal, code === 0 ? "completed" : "failed"));
}

/** 启动后台任务（立即返回，不等待） */
export function startJob(opts: { command: string; cwd: string; threadId: string }): JobRecord {
  const child = spawn(opts.command, { cwd: opts.cwd, shell: true, env: process.env });
  const now = Date.now();
  const job: JobRecord = {
    id: newJobId(), command: opts.command, cwd: opts.cwd, threadId: opts.threadId,
    status: "running", exitCode: null, signal: null, stdout: "", stderr: "",
    startedAt: now, lastOutputAt: now, droppedStdout: 0, droppedStderr: 0,
    outputCapped: false, child,
  };
  jobs.set(job.id, job);
  wireChild(job);
  return job;
}

/**
 * 把**已经在跑**的子进程收编成后台任务（前台自动转后台用，见 bash.ts 的 promote）。
 *
 * ⚠️ 调用方必须先在同一个同步块里摘掉前台侧的 data 监听再调这里：
 *    两边监听同时挂着会双写；中间让出事件循环则会丢一段输出。
 * ⚠️ 收编前进程可能已经退出（exit 发生但 close 还没派发/已派发给旧监听）——
 *    这里用 exitCode/signalCode 兜底补一次 finish，否则这条记录会永远停在 running。
 */
export function adoptJob(opts: {
  child: ChildProcess; command: string; cwd: string; threadId: string;
  stdout?: string; stderr?: string; startedAt: number; lastOutputAt?: number;
}): JobRecord {
  const now = Date.now();
  const job: JobRecord = {
    id: newJobId(), command: opts.command, cwd: opts.cwd, threadId: opts.threadId,
    status: "running", exitCode: null, signal: null, stdout: "", stderr: "",
    startedAt: opts.startedAt, lastOutputAt: opts.lastOutputAt ?? now,
    droppedStdout: 0, droppedStderr: 0, outputCapped: false, child: opts.child,
  };
  // 先灌存量输出（此刻还没有新监听者，顺序反了这段就丢了），再挂监听
  appendChunk(job, "stdout", opts.stdout ?? "");
  appendChunk(job, "stderr", opts.stderr ?? "");
  // 存量灌入不代表「刚刚有输出」：停滞计时从真实的最后一次输出算起
  job.lastOutputAt = opts.lastOutputAt ?? now;
  jobs.set(job.id, job);
  wireChild(job);
  const c = opts.child;
  if (c.exitCode !== null || c.signalCode !== null) {
    finish(job, c.exitCode, c.signalCode, c.exitCode === 0 ? "completed" : "failed");
  }
  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function listJobs(threadId?: string): JobRecord[] {
  const all = [...jobs.values()];
  return threadId ? all.filter((j) => j.threadId === threadId) : all;
}

/** 终止后台任务；signal 默认 SIGTERM */
export function killJob(id: string, signal: string = "SIGTERM"): { ok: boolean; job?: JobRecord; error?: string } {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: "没有这个后台任务：" + id };
  if (job.status !== "running") return { ok: true, job };
  job.status = "killed";
  try {
    job.child?.kill(signal as NodeJS.Signals);
  } catch (e) {
    return { ok: false, job, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, job };
}

/** 等任务结束（或超时）；返回最新记录 */
export function waitForJob(id: string, ms: number): Promise<JobRecord | undefined> {
  const job = jobs.get(id);
  if (!job) return Promise.resolve(undefined);
  if (job.status !== "running") return Promise.resolve(job);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(id); resolve(jobs.get(id)); }, Math.max(0, ms));
    waiters.set(id, (j) => { clearTimeout(timer); resolve(j); });
  });
}

/** 停滞判定：运行中且连续 silence ≥ 阈值。非 running 一律 false（停了的任务不存在「卡住」） */
export function jobStallInfo(job: JobRecord, now = Date.now()): { stalled: boolean; silenceMs: number } {
  if (job.status !== "running") return { stalled: false, silenceMs: 0 };
  const silenceMs = Math.max(0, now - job.lastOutputAt);
  return { stalled: silenceMs >= jobStallMs(), silenceMs };
}

/** 给模型看的摘要（不含输出正文） */
export function jobSummary(job: JobRecord): Record<string, unknown> {
  const stall = jobStallInfo(job);
  return {
    job_id: job.id,
    command: job.command,
    status: job.status,
    exit_code: job.exitCode,
    signal: job.signal,
    pid: job.child?.pid,
    duration_ms: (job.finishedAt ?? Date.now()) - job.startedAt,
    // 停滞守卫：让模型一眼看出「它可能卡住了」，而不是自己数时间
    silence_ms: job.status === "running" ? stall.silenceMs : undefined,
    stalled: stall.stalled || undefined,
    output_capped: job.outputCapped || undefined,
    dropped_stdout_chars: job.droppedStdout || undefined,
    dropped_stderr_chars: job.droppedStderr || undefined,
  };
}
