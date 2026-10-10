/**
 * CronList —— 列出定时任务（含下次触发时间，按任务时区显示）
 */
import { defineTool, S } from "../types.ts";
import { guarded, optBool } from "./util.ts";
import { clipText, formatAt } from "./cron-shared.ts";

export const CronListTool = defineTool({
  name: "CronList",
  discoverable: "列出**定时任务**（id、调度、模式、开关、下次/上次触发时间）",
  description: [
    "列出当前的定时任务：id、名字、类型（at/every/cron）、调度、模式（main/isolated）、",
    "是否启用、下次触发时间（按任务时区显示）、上次触发与累计次数。",
    "",
    "只想知道「有没有定时任务、下次什么时候跑」时用它。",
  ].join("\n"),
  parameters: S.obj({
    include_disabled: S.bool("是否包含已禁用的（默认 true）"),
  }, []),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const svc = ctx.services?.cron;
    if (!svc) {
      return { count: 0, jobs: [], error: "CRON_UNAVAILABLE", note: "定时服务没接上（ctx.services.cron 为空）—— 看不到任务列表。" };
    }
    const includeDisabled = optBool(input, "include_disabled", true);
    const localTz = svc.timezone();
    const all = svc.list();
    const jobs = (includeDisabled ? all : all.filter((j) => j.enabled)).map((j) => {
      const tz = j.timezone ?? localTz;
      return {
        id: j.id,
        name: j.name,
        type: j.type,
        schedule: j.schedule,
        mode: j.mode,
        enabled: j.enabled,
        timezone: tz,
        next_run_at: formatAt(j.nextRunAt, tz),
        last_run_at: formatAt(j.lastRunAt, tz),
        run_count: j.runCount,
        prompt: clipText(j.prompt, 160),
      };
    });
    return {
      count: jobs.length,
      total: all.length,
      enabled: all.filter((j) => j.enabled).length,
      timezone: localTz,
      jobs,
      note: all.length === 0
        ? "现在没有任何定时任务。要建的话用 CronCreate。"
        : "时间按各任务的时区显示（缺省 " + localTz + "）。删除用 CronDelete(id)。",
    };
  }),
});
