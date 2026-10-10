/**
 * UpdateGoal —— 改目标（状态机 + 乐观并发）
 *
 * 语义（照 DSH，但更严一点）：
 * - edit / pause / resume 是**人类的动作**：模型只在用户明确要求时做，不要自作主张暂停或改目标；
 * - complete / blocked 模型可以做：complete 只在**真的做完并验证过**时用；
 *   blocked 只在同一个具体条件跨多轮都没解决时用，必须写 blocked_reason。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str, optStr, optNum } from "./util.ts";
import { goalPort, goalPayload, goalFailure } from "./goal-port.ts";

const ACTIONS = ["edit", "pause", "resume", "complete", "blocked"] as const;

export const UpdateGoalTool = defineTool({
  name: "UpdateGoal",
  description:
    "更新当前目标。action=complete 只在真的做完并验证过时用；action=blocked 只在同一个具体条件卡住多轮时用，且必须给 blocked_reason。"
    + "edit / pause / resume 属于人类的决定 —— 只在用户明确要求时才做。",
  parameters: S.obj({
    goal_id: S.str("GetGoal 返回的 id"),
    revision: S.num("GetGoal 返回的 revision（乐观并发，过期会被拒）"),
    action: { type: "string", enum: [...ACTIONS], description: "edit | pause | resume | complete | blocked" },
    objective: S.str("换一个目标描述（只在 action=edit 时有效）"),
    max_rounds: S.num("换一个轮数上限（只在 action=edit 时有效）"),
    blocked_reason: S.str("卡住的具体条件（只在 action=blocked 时必填）"),
  }, ["goal_id", "revision", "action"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const port = goalPort(ctx);
    if (!port) return { ok: false, error: "当前环境没有接入目标服务。" };
    const action = str(input, "action") ?? "";
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return { ok: false, error: "action 必须是 " + ACTIONS.join(" / ") + " 之一。" };
    }
    const revision = optNum(input, "revision");
    if (revision === undefined) return { ok: false, error: "revision 必填（先 GetGoal）。" };
    try {
      return { ok: true, ...goalPayload(port.update(ctx.threadId, {
        goalId: str(input, "goal_id") ?? "",
        revision,
        action: action as (typeof ACTIONS)[number],
        ...(optStr(input, "objective") !== undefined ? { objective: optStr(input, "objective")! } : {}),
        ...(optNum(input, "max_rounds") !== undefined ? { maxRounds: optNum(input, "max_rounds")! } : {}),
        ...(optStr(input, "blocked_reason") !== undefined ? { blockedReason: optStr(input, "blocked_reason")! } : {}),
      })) };
    } catch (e) { return goalFailure(e); }
  }),
});
