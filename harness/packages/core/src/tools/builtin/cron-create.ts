/**
 * CronCreate —— 建一个定时任务（at / every / cron × main / isolated）
 * 类型与模式都对齐 scheduler/cron-model.ts 的 CronJob；时区交给调度器（缺省 = 本地时区）。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str, optStr } from "./util.ts";
import { CRON_MODES, CRON_TYPES, formatAt, inferCronType } from "./cron-shared.ts";

export const CronCreateTool = defineTool({
  name: "CronCreate",
  discoverable: "建**定时任务**（cron 表达式 / 固定间隔 / 某个时间点），到点自动跑一段提示词",
  description: [
    "建一个定时任务：到点自动派一个 agent 跑你写的提示词。",
    "",
    "三种调度（type 省略时按 schedule 猜，返回值里会写明猜成了什么）：",
    "- type=\"cron\"：5 段表达式「分 时 日 月 周」，如 \"0 9 * * 1-5\"（工作日 9:00）、\"*/30 * * * *\"（每 30 分钟）",
    "- type=\"every\"：固定间隔，如 \"30m\"、\"2h\"、\"1d\"（最短建议 ≥ 1 分钟：每次触发都真实调用模型）",
    "- type=\"at\"：一次性，ISO 时间 \"2026-03-01T09:00\" 或相对时间 \"30m\" / \"in 2h\"；触发后自动禁用",
    "⚠️ 纯时长（如 \"30m\"）默认判成 every；一次性提醒必须显式写 type:\"at\"。",
    "",
    "两种模式：",
    "- mode=\"main\"（默认）：在主线程（Home）里跑，结果直接出现在用户面前，带上之前的上下文；",
    "- mode=\"isolated\"：每次起一条新线程，不带上下文 —— 适合独立的定时采集/巡检。",
    "",
    "prompt 要**自包含**：触发时只有它，没有你和用户的对话。时区缺省用本地时区。",
  ].join("\n"),
  parameters: S.obj({
    schedule: S.str("调度：cron 表达式 / 间隔（30m）/ 时间点（2026-03-01T09:00 或 30m）"),
    prompt: S.str("到点时让 agent 做什么（自包含：背景 + 目标 + 输出要求）"),
    name: S.str("任务名（显示用，如「每早待办提醒」）"),
    type: S.str("at / every / cron（省略则按 schedule 推断）"),
    mode: S.str("main（默认，跑在主线程）/ isolated（每次新线程）"),
    timezone: S.str("IANA 时区名（如 Asia/Shanghai）；省略 = 本地时区"),
  }, ["schedule", "prompt"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const schedule = str(input, "schedule").trim();
    const prompt = str(input, "prompt");
    const name = optStr(input, "name") ?? "定时任务";
    const svc = ctx.services?.cron;
    if (!svc) {
      return {
        ok: false, error: "CRON_UNAVAILABLE",
        note: "定时服务没接上（ctx.services.cron 为空）—— 任务没有创建。可以改用别的方式（如告诉用户手动加）。",
      };
    }

    const givenType = optStr(input, "type")?.toLowerCase();
    let type = givenType;
    let inferred: string | undefined;
    if (!type) {
      const guess = inferCronType(schedule);
      if (!guess.type) return { ok: false, schedule, error: "无法推断调度类型：" + guess.reason, valid_types: CRON_TYPES };
      type = guess.type;
      inferred = guess.reason;
    }
    if (!(CRON_TYPES as readonly string[]).includes(type)) {
      return { ok: false, schedule, error: "不支持的 type：" + type, valid_types: CRON_TYPES };
    }
    const mode = (optStr(input, "mode") ?? "main").toLowerCase();
    if (!(CRON_MODES as readonly string[]).includes(mode)) {
      return { ok: false, error: "不支持的 mode：" + mode, valid_modes: CRON_MODES, note: "main = 跑在主线程；isolated = 每次新线程。" };
    }

    const r = svc.create({
      name, type, schedule, mode, prompt,
      timezone: optStr(input, "timezone"),
    });
    if (!r.ok || !r.job) {
      return { ok: false, schedule, type, error: r.error ?? "创建失败", warning: r.warning };
    }
    const job = r.job;
    ctx.emit("tool:cron-created", {
      toolCallId: ctx.toolCallId, jobId: job.id, type: job.type, schedule: job.schedule, mode: job.mode,
    });
    const tz = job.timezone ?? svc.timezone();
    return {
      ok: true,
      id: job.id, name: job.name,
      type: job.type, schedule: job.schedule, mode: job.mode,
      type_inferred: inferred,
      timezone: tz,
      next_run_at: formatAt(job.nextRunAt, tz),
      enabled: job.enabled,
      warning: r.warning,
      note: "任务已创建，到点会自动跑。要取消用 CronDelete(id)，要看全部用 CronList。" + (r.warning ? " ⚠️ " + r.warning : ""),
    };
  }),
});
