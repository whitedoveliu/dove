/**
 * BashOutput —— 读后台任务输出（Bash run_in_background 的产物）
 * 后台输出在源头有内存上限；这里不做模型可见性截断，交给 budget.ts。
 */
import { defineTool, S } from "../types.ts";
import { guarded, optStr, optNum } from "./util.ts";
import { getJob, waitForJob, listJobs, jobSummary } from "./jobs.ts";

const MAX_WAIT_MS = 60_000;

/** 取末尾 N 字符（看长日志的尾部比头部有用） */
function tail(s: string, chars: number): string {
  if (!s || chars <= 0 || s.length <= chars) return s;
  return "…[前 " + (s.length - chars) + " 字符已省略，下面是末尾 " + chars + " 字符]\n" + s.slice(-chars);
}

export const BashOutputTool = defineTool({
  name: "BashOutput",
  description:
    "读后台任务（Bash 的 run_in_background）的状态与输出。省略 job_id 时列出当前线程的后台任务。" +
    "可等待最多 60 秒直到任务结束；输出很长时用 tail_chars 只取末尾。",
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
    if (job.status === "running") notes.push("任务仍在运行：可再次调用并设置 wait_seconds 等待，或用 KillShell 终止。");
    if (job.outputCapped) notes.push("任务输出超过源头内存上限，只保留了前 " + job.stdout.length + " 字符（stdout）。");

    return {
      ...jobSummary(job),
      stdout: tail(job.stdout, tailChars),
      stderr: tail(job.stderr, tailChars),
      note: notes.length ? notes.join(" ") : undefined,
    };
  }),
});
