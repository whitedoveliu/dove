/**
 * GetGoal —— 读当前目标（update 需要它返回的 id + revision）
 */
import { defineTool, S } from "../types.ts";
import { guarded } from "./util.ts";
import { goalPort, goalPayload } from "./goal-port.ts";

export const GetGoalTool = defineTool({
  name: "GetGoal",
  description: "读当前会话的目标，包含 UpdateGoal 需要的 id 与 revision。改目标前先读一次，不要凭记忆写 revision。",
  parameters: S.obj({}, []),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (_input, ctx) => guarded(async () => {
    const port = goalPort(ctx);
    if (!port) return { ok: false, error: "当前环境没有接入目标服务。" };
    return { ok: true, ...goalPayload(port.get(ctx.threadId)) };
  }),
});
