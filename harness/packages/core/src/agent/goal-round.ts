/**
 * 目标自动续跑 —— 只做**判定与提示词渲染**（纯逻辑，好测）
 *
 * 与 DSH 的差别：不引入独立的 goal-round-driver 进程，也不做投影；
 * 运行期在**一轮结束时**问一句「还要不要接着干」，要就带着这段提示词自动开下一轮。
 * 判定权在代码里，不在提示词里 —— 轮次上限、phase、是否被人类暂停，都是硬条件。
 */
/** 判定只需要这几个字段 —— 用结构化类型，工具层/服务层的视图对象可以直接传 */
export interface GoalLike {
  objective: string;
  phase: string;
  roundsStarted: number;
  maxRounds: number;
}

/** 续跑提示词的标记（测试与前端识别用） */
export const GOAL_ROUND_TAG = "goal_round";

/**
 * 续跑提示词。措辞对齐本项目的脾气：
 * - 以工作区与工具结果为准，不要凭上一轮的口头叙述下结论；
 * - 做完要有证据；没做完就留在 active 给下一轮；
 * - 卡住要说具体条件，不要拿「难」当 blocked。
 */
export function renderGoalRoundPrompt(goal: Pick<GoalLike, "objective" | "roundsStarted" | "maxRounds">): string {
  return [
    "<" + GOAL_ROUND_TAG + ">",
    "目标：" + goal.objective,
    "轮次：" + (goal.roundsStarted + 1) + "/" + goal.maxRounds,
    "",
    "在同一会话里继续朝目标推进：",
    "- 以工作区现状、工具结果、会话里已落盘的事实为准；不要假设上一轮的叙述还有效，先看再动。",
    "- 这一轮要有具体进展并验证：改了就跑、写了就看、说了就给证据。",
    "- 宣布完成之前，先确认整个目标真的达成（不是其中一步），再 UpdateGoal action=complete。",
    "- 还有活没干完就把它留在 active，下一轮继续；不要为了收尾好看而草率宣布完成。",
    "- 确实卡住了：只有同一个具体条件跨多轮没解决才 UpdateGoal action=blocked，并写清 blocked_reason。",
    "</" + GOAL_ROUND_TAG + ">",
  ].join("\n");
}

/** 一轮结束后的续跑判定 */
export type GoalContinuation =
  | { action: "continue"; prompt: string; round: number }
  | { action: "blocked"; reason: string }
  | { action: "stop"; reason: "no-goal" | "not-active" | "disabled" };

export function decideGoalContinuation(
  goal: GoalLike | null,
  opts: { disabled?: boolean } = {},
): GoalContinuation {
  if (opts.disabled === true) return { action: "stop", reason: "disabled" };
  if (!goal) return { action: "stop", reason: "no-goal" };
  if (goal.phase !== "active") return { action: "stop", reason: "not-active" };
  if (goal.roundsStarted >= goal.maxRounds) {
    return {
      action: "blocked",
      reason: "轮次已用满（" + goal.roundsStarted + "/" + goal.maxRounds + "）：目标没完成，但自动续跑到了上限，需要人来决定是加轮次还是改目标。",
    };
  }
  return { action: "continue", prompt: renderGoalRoundPrompt(goal), round: goal.roundsStarted + 1 };
}
