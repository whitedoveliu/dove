/**
 * BashOutput —— 读后台任务输出（Bash run_in_background 的产物）
 * 后台输出在源头有内存上限（jobs.ts，**丢头保尾**）；这里不做模型可见性截断，交给 budget.ts。
 */
import { defineTool, S } from "../types.ts";
import { guarded, optStr, optNum } from "./util.ts";
import { humanDuration } from "../../constants.ts";
import {
  getJob, waitForJob, listJobs, jobSummary, jobStallInfo, jobStallMs, MAX_JOB_STREAM_CHARS,
} from "./jobs.ts";

const MAX_WAIT_MS = 60_000;

/** 取末尾 N 字符（看长日志的尾部比头部有用） */
function tail(s: string, chars: number): string {
  if (!s || chars <= 0 || s.length <= chars) return s;
  return "…[前 " + (s.length - chars) + " 字符已省略，下面是末尾 " + chars + " 字符]\n" + s.slice(-chars);
}

/** 命令原文可能很长（一整个 heredoc），通知里只留够认人的开头 */
function briefCommand(command: string): string {
  const one = command.replace(/\s+/g, " ").trim();
  return one.length > 60 ? one.slice(0, 60) + "…" : one;
}

export const BashOutputTool = defineTool({
  name: "BashOutput",
  description:
    "读后台任务（Bash 的 run_in_background / 自动转后台）的状态与输出。省略 job_id 时列出当前线程的后台任务。" +
    "可等待最多 60 秒直到任务结束；输出很长时用 tail_chars 只取末尾。" +
    "任务超过停滞阈值没有新输出时会明确标注 stalled —— 那是「可能卡住了」的信号，别无限等下去。",
  parameters: S.obj({
    job_id: S.str("后台任务 id（Bash 返回的 job_id）；省略则列出全部后台任务"),
    wait_seconds: S.num("最多等待多少秒（0–60，默认 0 立即返回）"),
    tail_chars: S.num("每个流只返回末尾这么多字符（默认全量）"),
  }, []),
  outputTier: "compact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const id = optStr(input, "job_id");
    if (!id) {
      const jobs = listJobs(ctx.threadId);
      return {
        count: jobs.length,
        jobs: jobs.map(jobSummary),
        note: jobs.length ? "用 job_id 读具体任务的输出。" : "当前线程没有后台任务。",
      };
    }

    const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, (optNum(input, "wait_seconds") ?? 0) * 1000));
    const job = waitMs > 0 ? await waitForJob(id, waitMs) : getJob(id);
    if (!job) return { job_id: id, error: "没有这个后台任务（注册表不跨进程重启）。" };

    const tailChars = Math.max(0, Math.floor(optNum(input, "tail_chars") ?? 0));
    const notes: string[] = [];
    const stall = jobStallInfo(job);
    if (job.status === "running") {
      notes.push("任务仍在运行：可再次调用并设置 wait_seconds 等待，或用 KillShell 终止。");
      if (stall.stalled) {
        // 点名是哪个任务：模型可能同时盯着好几个 job，只说「这个」它在长上下文里对不上号
        notes.push("⚠️ 这个任务可能卡住了（job_id=" + job.id + "，命令：" + briefCommand(job.command) + "）：" +
          "已经 " + humanDuration(stall.silenceMs) + " 没有新输出（停滞判定阈值 " + humanDuration(jobStallMs()) + "）。" +
          "先看下面输出的尾部，判断它在死等、在等输入还是真卡死；确认没救就 KillShell。");
      }
    }
    if (job.outputCapped) {
      const lost: string[] = [];
      if (job.droppedStdout) lost.push("stdout 丢了前 " + job.droppedStdout + " 字符");
      if (job.droppedStderr) lost.push("stderr 丢了前 " + job.droppedStderr + " 字符");
      notes.push("⚠️ 更早的输出已被丢弃（源头按流只保留尾部最多 " + MAX_JOB_STREAM_CHARS + " 字符）：" +
        lost.join("、") + "。丢掉的这一段不在任何地方落盘；要更早的内容只能重跑并把输出重定向进文件（> 文件 2>&1）。");
    }

    return {
      ...jobSummary(job),
      stdout: tail(job.stdout, tailChars),
      stderr: tail(job.stderr, tailChars),
      note: notes.length ? notes.join(" ") : undefined,
    };
  }),
});
