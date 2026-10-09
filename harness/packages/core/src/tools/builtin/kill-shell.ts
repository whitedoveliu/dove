/**
 * KillShell —— 终止后台任务
 * 只作用于本进程启动的后台任务（jobs.ts 注册表），不会误杀系统进程。
 */
import { defineTool, S } from "../types.ts";
import { guarded, optStr, str } from "./util.ts";
import { killJob, listJobs, jobSummary } from "./jobs.ts";

const DEFAULT_SIGNAL = "SIGTERM";

export const KillShellTool = defineTool({
  name: "KillShell",
  description:
    "终止由 Bash 后台启动的任务（先发 SIGTERM，必要时可指定 SIGKILL）。省略 job_id 时列出当前可终止的任务。",
  parameters: S.obj({
    job_id: S.str("要终止的后台任务 id（省略则列出全部后台任务）"),
    signal: S.str("信号，默认 " + DEFAULT_SIGNAL + "（强杀用 SIGKILL）"),
  }, []),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const id = optStr(input, "job_id");
    if (!id) {
      const jobs = listJobs(ctx.threadId).filter((j) => j.status === "running");
      return { running: jobs.length, jobs: jobs.map(jobSummary), note: jobs.length ? "传 job_id 终止。" : "没有正在运行的后台任务。" };
    }
    const signal = optStr(input, "signal") ?? DEFAULT_SIGNAL;
    const r = killJob(id, signal);
    if (!r.ok) return { job_id: id, killed: false, error: r.error };
    const job = r.job!;
    ctx.emit("tool:bg-killed", { toolCallId: ctx.toolCallId, jobId: id, signal });
    return {
      job_id: id,
      killed: job.status === "killed" || job.status !== "running",
      status: job.status,
      exit_code: job.exitCode,
      signal,
      note: job.status === "running" ? "信号已发出，稍后用 BashOutput 确认已退出。" : undefined,
    };
  }),
});
