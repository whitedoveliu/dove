/**
 * 后台任务注册表（Bash / BashOutput / KillShell 共用）
 * 进程内单例：jobId → 状态 + 输出缓冲。
 * 说明：后台任务在**源头**按流截断（内存保护），前台 Bash 不截断（交给 budget.ts）。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export const MAX_JOB_STREAM_CHARS = 1_000_000;

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
  outputCapped: boolean;
  child?: ChildProcess;
}

const jobs = new Map<string, JobRecord>();
const waiters = new Map<string, (job: JobRecord) => void>();
let seq = 0;

function finish(job: JobRecord, code: number | null, signal: string | null, status: JobStatus): void {
  if (job.finishedAt) return;
  job.exitCode = code;
  job.signal = signal;
  job.status = job.status === "killed" ? "killed" : status;
  job.finishedAt = Date.now();
  const w = waiters.get(job.id);
  if (w) { waiters.delete(job.id); w(job); }
}

/** 启动后台任务（立即返回，不等待） */
export function startJob(opts: { command: string; cwd: string; threadId: string }): JobRecord {
  const id = "sh_" + Date.now().toString(36) + "_" + (++seq).toString(36);
  const child = spawn(opts.command, { cwd: opts.cwd, shell: true, env: process.env });
  const job: JobRecord = {
    id, command: opts.command, cwd: opts.cwd, threadId: opts.threadId,
    status: "running", exitCode: null, signal: null, stdout: "", stderr: "",
    startedAt: Date.now(), outputCapped: false, child,
  };
  jobs.set(id, job);

  const append = (which: "stdout" | "stderr") => (chunk: Buffer) => {
    const next = job[which] + chunk.toString("utf8");
    if (next.length > MAX_JOB_STREAM_CHARS) {
      job[which] = next.slice(0, MAX_JOB_STREAM_CHARS);
      job.outputCapped = true;
    } else {
      job[which] = next;
    }
  };
  child.stdout?.on("data", append("stdout"));
  child.stderr?.on("data", append("stderr"));
  child.on("error", (e) => {
    job.stderr += "\n[spawn error] " + e.message;
    finish(job, null, null, "failed");
  });
  child.on("close", (code, signal) => {
    finish(job, code, signal, code === 0 ? "completed" : "failed");
  });
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

/** 给模型看的摘要（不含输出正文） */
export function jobSummary(job: JobRecord): Record<string, unknown> {
  return {
    job_id: job.id,
    command: job.command,
    status: job.status,
    exit_code: job.exitCode,
    signal: job.signal,
    pid: job.child?.pid,
    duration_ms: (job.finishedAt ?? Date.now()) - job.startedAt,
    output_capped: job.outputCapped || undefined,
  };
}
