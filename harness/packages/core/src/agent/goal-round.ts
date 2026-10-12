/**
 * 目标自动续跑 —— 只做**判定与提示词渲染**（纯逻辑，好测）
 *
 * 与 DSH 的差别：不引入独立的 goal-round-driver 进程，也不做投影；
 * 运行期在**一轮结束时**问一句「还要不要接着干」，要就带着这段提示词自动开下一轮。
 * 判定权在代码里，不在提示词里 —— 轮次上限、phase、是否被人类暂停，都是硬条件。
 *
 * 带验收标准的目标多一道：轮末的独立评估没过时，失败项作为反馈塞进下一轮
 * （「失败项必修 / 通过项不得回归」）—— 模型不用猜评估器想要什么，反馈就在提示词里。
 */
/** 判定只需要这几个字段 —— 用结构化类型，工具层/服务层的视图对象可以直接传 */
export interface GoalLike {
  objective: string;
  phase: string;
  roundsStarted: number;
  maxRounds: number;
}

/** 下一轮的反馈：上一条评估的失败项（结构对齐 agents/goal-criteria.ts 的 GoalFailureItem） */
export interface GoalFeedbackItem {
  id: string;
  description: string;
  reason: string;
  score?: number | null;
  threshold?: number;
}

/** 续跑提示词的标记（测试与前端识别用） */
export const GOAL_ROUND_TAG = "goal_round";

/**
 * 续跑提示词。措辞对齐本项目的脾气：
 * - 以工作区与工具结果为准，不要凭上一轮的口头叙述下结论；
 * - 做完要有证据；没做完就留在 active 给下一轮；
 * - 卡住要说具体条件，不要拿「难」当 blocked。
 */
export function renderGoalRoundPrompt(
  goal: Pick<GoalLike, "objective" | "roundsStarted" | "maxRounds">,
  feedback: { items: GoalFeedbackItem[]; reason?: string } | null = null,
  opts: { graded?: boolean } = {},
): string {
  const lines = [
    "<" + GOAL_ROUND_TAG + ">",
    "目标：" + goal.objective,
    "轮次：" + (goal.roundsStarted + 1) + "/" + goal.maxRounds,
    "",
    "在同一会话里继续朝目标推进：",
    "- 以工作区现状、工具结果、会话里已落盘的事实为准；不要假设上一轮的叙述还有效，先看再动。",
    "- 这一轮要有具体进展并验证：改了就跑、写了就看、说了就给证据。",
    opts.graded
      ? "- 宣布完成之前，转完整个目标（不是其中一步）再 UpdateGoal action=complete；带验收标准的目标轮末会被**独立评估**，没过则 complete 直接被拒。"
      : "- 宣布完成之前，先确认整个目标真的达成（不是其中一步），再 UpdateGoal action=complete。",
    "- 还有活没干完就把它留在 active，下一轮继续；不要为了收尾好看而草率宣布完成。",
    "- 确实卡住了：只有同一个具体条件跨多轮没解决才 UpdateGoal action=blocked，并写清 blocked_reason。",
  ];
  if (feedback && feedback.items.length > 0) {
    lines.push(
      "",
      "<goal_eval_feedback>",
      "上一轮结束时的独立评估**没有通过**" + (feedback.reason ? "：" + feedback.reason : "") + "。",
      "失败项（必修，做完要有能核验的证据）：",
      ...feedback.items.map((f) => "- [" + f.id + "] " + f.description + " —— " + f.reason
        + (f.score === undefined || f.score === null || f.threshold === undefined ? "" : "（当前 " + f.score + "/100，阈值 " + f.threshold + "）")),
      "已经过的项不得回归；不要改验收标准，也不要绕开评估去收尾。",
      "</goal_eval_feedback>",
    );
  }
  lines.push("</" + GOAL_ROUND_TAG + ">");
  return lines.join("\n");
}

/** 一轮结束后的续跑判定 */
export type GoalContinuation =
  | { action: "continue"; prompt: string; round: number }
  | { action: "blocked"; reason: string }
  | { action: "stop"; reason: "no-goal" | "not-active" | "disabled" };

export function decideGoalContinuation(
  goal: (GoalLike & { criteria?: unknown[] }) | null,
  opts: { disabled?: boolean; feedback?: { items: GoalFeedbackItem[]; reason?: string } | null } = {},
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
  const graded = (goal.criteria?.length ?? 0) > 0;
  return {
    action: "continue",
    prompt: renderGoalRoundPrompt(goal, opts.feedback ?? null, { graded }),
    round: goal.roundsStarted + 1,
  };
}
