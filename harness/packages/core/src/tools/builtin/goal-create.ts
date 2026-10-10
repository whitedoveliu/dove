/**
 * CreateGoal —— 建一个跨轮推进的长期目标
 * 只建档；"谁在什么时候开下一轮"由上层循环决定（受 max_rounds 限制）。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str, optNum } from "./util.ts";
import { goalPort, goalPayload, goalFailure } from "./goal-port.ts";

export const CreateGoalTool = defineTool({
  name: "CreateGoal",
  description:
    "为一个长期目标建档：只要目标还是 active，每一轮结束后会自动接着干（受 max_rounds 限制）。"
    + "只在确实需要跨多轮推进时用（大改造、长调研、多步交付）；一轮能做完的事不要建。",
  parameters: S.obj({
    objective: S.str("完成标准：一句话说清「做到什么算完成」"),
    max_rounds: S.num("自动续跑轮数上限（默认 20，最大 200）"),
  }, ["objective"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const port = goalPort(ctx);
    if (!port) return { ok: false, error: "当前环境没有接入目标服务。" };
    try {
      return { ok: true, ...goalPayload(port.create(ctx.threadId, {
        objective: str(input, "objective") ?? "",
        ...(optNum(input, "max_rounds") !== undefined ? { maxRounds: optNum(input, "max_rounds")! } : {}),
      })) };
    } catch (e) { return goalFailure(e); }
  }),
});
