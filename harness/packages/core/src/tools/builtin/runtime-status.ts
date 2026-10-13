/**
 * RuntimeStatus —— 只读的「我和这个工作台现在什么状态」快照。
 *
 * 为什么需要它（实测日志里的病灶）：
 *   Home 线程按设计拿不到 Bash / Write / Edit（策略裁剪，见 agent/tool-policy.ts），
 *   而心跳清单要求「检查有没有没跑完的任务、有没有值得汇报的进展」——
 *   模型没有能"看运行状态"的手段，只能凭印象猜，于是每次心跳 1–4 步就 HEARTBEAT_OK，
 *   日志里每轮都跟着一条 policy ... blocked=['Write','Edit','Bash','KillShell']。
 *
 * 所以这里给的是**能力**，不是提示词请求：一个不写任何东西、也不收任何参数的只读快照，
 * 把「后台任务 / 子代理 / 定时任务 / 当前时间」一次问清楚。
 * 拿不到的服务显式回 `available: false`，绝不假装查过。
 */
import { defineTool, S } from "../types.ts";
import { guarded } from "./util.ts";
import { jobStallInfo, jobStallMs, listJobs } from "./jobs.ts";
import { humanDuration } from "../../constants.ts";

function localTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function pad2(n: number): string { return n < 10 ? "0" + n : String(n); }

/** 时间戳 → 指定时区的 YYYY-MM-DD HH:mm（时区不合法时退回本地时间） */
function stamp(ms: number | null | undefined, tz: string): string | null {
  if (ms === null || ms === undefined) return null;
  const d = new Date(ms);
  try {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d);
    const g = (t: string): string => p.find((x) => x.type === t)?.value ?? "";
    return g("year") + "-" + g("month") + "-" + g("day") + " " + (g("hour") === "24" ? "00" : g("hour")) + ":" + g("minute");
  } catch {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
      + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
}

/** 距现在多少分钟（负数 = 还没到） */
function minutesFromNow(ms: number | null | undefined, now: number): number | null {
  return ms === null || ms === undefined ? null : Math.round((ms - now) / 60_000);
}

export const RuntimeStatusTool = defineTool({
  name: "RuntimeStatus",
  description:
    "只读快照：现在几点、这个进程跑了多久、有没有还没跑完的任务（后台任务 / 子代理 / 后台 shell）、" +
    "shell 任务是否已经停滞（长时间没有新输出）、定时任务的下一次触发时间、当前线程与工作区。" +
    "心跳/自检先问它再下结论 —— 不要凭印象猜。" +
    "它不写任何东西、也不接受参数；拿不到的服务会显式说 available=false。",
  parameters: S.obj({}, []),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (_input, ctx) => guarded(async () => {
    const now = Date.now();
    const tz = localTimezone();
    const svc = ctx.services;

    // ── 后台任务（TaskRegistry；bootstrap → AgentServices → run-services 三处接线）
    const background = (() => {
      if (!svc.listTasks) return { available: false, note: "后台任务表未接入，看不到派出去的任务。" };
      const items = svc.listTasks(ctx.threadId).slice(0, 20).map((t) => ({
        id: t.id, kind: t.kind, status: t.status,
        prompt: (t.prompt ?? "").slice(0, 160),
        created_at: stamp(t.createdAt, tz),
        finished_at: stamp(t.finishedAt, tz),
        running_minutes: t.finishedAt ? null : Math.round((now - t.createdAt) / 60_000),
        // token 用量：provider 没报时给「未上报」，**不给 0**（0 会被读成没花 token）
        usage: t.usage ? { input_tokens: t.usage.inputTokens, output_tokens: t.usage.outputTokens } : "未上报",
      }));
      return {
        available: true,
        total: items.length,
        unfinished: items.filter((t) => t.status === "running").length,
        items,
      };
    })();

    // ── 后台 shell 任务（Bash 起的那些）
    // 为什么在这里直接读 jobs.ts 的注册表：它和终端会话一样是**进程内 OS 资源**的单例，
    // 拿不到就没有第二个地方能回答「有没有命令卡住了」—— 而 Home 线程恰恰被裁掉了 Bash，
    // 心跳自检只剩这一个只该读的入口。判据与 BashOutput 共用 jobStallInfo，两处口径不会漂。
    const shellJobs = (() => {
      const running = listJobs().filter((j) => j.status === "running");
      const stalled = running.filter((j) => jobStallInfo(j).stalled);
      return {
        running: running.length,
        stalled: stalled.length,
        stall_threshold_ms: jobStallMs(),
        items: running.slice(-20).map((j) => {
          const stall = jobStallInfo(j);
          return {
            job_id: j.id,
            command: j.command.length > 120 ? j.command.slice(0, 120) + "…" : j.command,
            thread_id: j.threadId,
            duration_ms: now - j.startedAt,
            duration: humanDuration(now - j.startedAt),
            silence_ms: stall.silenceMs,
            stalled: stall.stalled || undefined,
          };
        }),
        note: (stalled.length
          ? "⚠️ " + stalled.length + " 个后台任务可能卡住了：连续 " + humanDuration(jobStallMs()) +
            "没有任何新输出（stalled=true）。用 BashOutput 看输出尾部再决定催还是 KillShell —— 别无限等。"
          : running.length
            ? "有 " + running.length + " 个后台任务在跑；要读输出用 BashOutput（带 job_id）。"
            : "没有正在跑的后台任务。") +
          (running.length > 20 ? "（列表只列最新的 20 个，别据此断定某个任务不在跑。）" : ""),
      };
    })();

    // ── 子代理（本进程还在跟踪的 + 库里留档的）
    const agents = (() => {
      if (!svc.listAgents) return { available: false, note: "子代理控制面未接入。" };
      const items = svc.listAgents().slice(0, 20).map((a) => ({
        id: a.id, label: a.label, status: a.status, background: a.background,
        source: a.source, steps: a.steps ?? null,
        started_at: stamp(a.startedAt, tz),
        finished_at: stamp(a.finishedAt, tz),
      }));
      return { available: true, total: items.length, running: items.filter((a) => a.status === "running").length, items };
    })();

    // ── 定时任务（CronOps）：快到期的那些是「有没有要提醒的事」的答案
    const cron = (() => {
      if (!svc.cron) return { available: false, note: "定时服务未接入。" };
      const jobs = svc.cron.list().slice(0, 50).map((j) => ({
        id: j.id, name: j.name, type: j.type, schedule: j.schedule, mode: j.mode, enabled: j.enabled,
        next_run: stamp(j.nextRunAt, j.timezone ?? tz),
        next_run_in_minutes: minutesFromNow(j.nextRunAt, now),
        last_run: stamp(j.lastRunAt, tz),
        run_count: j.runCount,
        prompt: (j.prompt ?? "").slice(0, 160),
      }));
      return { available: true, timezone: svc.cron.timezone(), total: jobs.length, jobs };
    })();

    return {
      now: stamp(now, tz),
      timezone: tz,
      process_uptime_minutes: Math.round(process.uptime() / 60),
      thread_id: ctx.threadId,
      workdir: ctx.workdir,
      background_tasks: background,
      shell_jobs: shellJobs,
      agents,
      cron,
      note: "只读快照；要读文件内容请用 Read/Glob/Grep。这个工具没有 Bash 通道，跑命令类检查在 Home 线程做不了。",
    };
  }),
});
