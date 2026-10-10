/**
 * 目标自动续跑：**一轮跑完后**如果会话还有 active 目标，就带着 <goal_round> 再开一轮。
 *
 * 判定权在代码里（decideGoalContinuation），不在提示词里 —— 轮次上限、phase、是否被人类暂停都是硬条件。
 * 单次请求内还有一道硬上限：防止一个 HTTP/SSE 请求跑飞（剩下的轮次留给下一次消息）。
 */
import { decideGoalContinuation } from "../../core/src/agent/goal-round.ts";
import type { AgentRuntime } from "../../core/src/agent/runtime.ts";

/** 一次请求内最多自动续几轮（真正的轮数上限在 goal.maxRounds，这个只是防跑飞） */
export const MAX_AUTO_ROUNDS_PER_REQUEST = 5;

export interface GoalRunOptions {
  threadId: string;
  userText: string;
  projectId?: string | null;
  model?: string;
  signal?: AbortSignal;
  sink: (e: { type: string; [k: string]: unknown }) => void;
}

export async function runWithGoalContinuation(
  runtime: AgentRuntime, opts: GoalRunOptions,
): Promise<{ rounds: number; endReason: string }> {
  let result = await runtime.run(opts as never);
  let rounds = 0;
  while (rounds < MAX_AUTO_ROUNDS_PER_REQUEST) {
    const goals = runtime.services.goals;
    if (!goals) break;
    const goal = goals.get(opts.threadId) ?? null;
    const decision = decideGoalContinuation(goal);
    if (decision.action !== "continue" || !goal) {
      if (decision.action === "blocked") opts.sink({ type: "goal_blocked", reason: decision.reason });
      break;
    }
    try {
      goals.bumpRound(opts.threadId, goal.id, goal.revision);
    } catch { break; }   // revision 过期（用户刚改过）→ 停下，别覆盖人的决定
    rounds++;
    opts.sink({ type: "goal_round", round: decision.round, objective: goal.objective });
    result = await runtime.run({ ...opts, userText: decision.prompt } as never);
  }
  return { rounds, endReason: (result as { endReason?: string }).endReason ?? "stop" };
}
