/**
 * CronDelete —— 删除定时任务
 */
import { defineTool, S } from "../types.ts";
import { guarded, str } from "./util.ts";

export const CronDeleteTool = defineTool({
  name: "CronDelete",
  discoverable: "删除一个**定时任务**（用 CronList 拿 id）",
  description: [
    "删除一个定时任务。id 从 CronList 来。",
    "删除是永久的（任务定义与调度都消失，历史记录保留）。只想临时停掉可以先不删 —— 面板上能禁用。",
    "id 不存在时返回结构化错误并附上现有 id，不会抛。",
  ].join("\n"),
  parameters: S.obj({
    id: S.str("要删除的任务 id（CronList 的 id）"),
  }, ["id"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const id = str(input, "id");
    const svc = ctx.services?.cron;
    if (!svc) {
      return { ok: false, id, error: "CRON_UNAVAILABLE", note: "定时服务没接上（ctx.services.cron 为空）—— 没有删除任何东西。" };
    }
    const before = svc.list().find((j) => j.id === id);
    const r = svc.remove(id);
    if (!r.ok) {
      return {
        ok: false, id, error: r.error ?? "删除失败",
        known_ids: svc.list().map((j) => ({ id: j.id, name: j.name })),
        note: "用 CronList 或 known_ids 核对 id 再试。",
      };
    }
    ctx.emit("tool:cron-deleted", { toolCallId: ctx.toolCallId, jobId: id, name: before?.name });
    return { ok: true, id, name: before?.name, deleted: true, note: "任务已删除，不会再触发。" };
  }),
});
