/**
 * 工具层的 Goal 端口 —— **形状定义在 tools/types.ts**，这里只做转发与三个小助手。
 *
 * 为什么不在这里定义：runtime.ts 的 AgentServices 也要引用同一个 GoalPort；
 * 定义两处迟早漂移。工具层不 import agents/（依赖方向是 tools 在下层），
 * 真正的实现 GoalStore 由 server 层注入。
 */
import type { GoalPort, GoalView } from "../types.ts";

export type { GoalPort, GoalView };

export function goalPort(ctx: { services: unknown }): GoalPort | undefined {
  return (ctx.services as { goals?: GoalPort }).goals;
}

export function goalPayload(rec: GoalView | null): Record<string, unknown> {
  if (!rec) return { goal: null, note: "当前会话没有目标。要长期推进就用 CreateGoal 建一个。" };
  const note = rec.phase === "active"
    ? "目标进行中（第 " + rec.roundsStarted + "/" + rec.maxRounds + " 轮）。做完并验证过再 UpdateGoal action=complete。"
    : rec.phase === "complete" ? "目标已完成。" : "目标已停止自动推进（不会自动开下一轮）。";
  return {
    goal: {
      id: rec.id, revision: rec.revision, objective: rec.objective, phase: rec.phase,
      rounds_started: rec.roundsStarted, max_rounds: rec.maxRounds,
      ...(rec.blockedReason ? { blocked_reason: rec.blockedReason } : {}),
    },
    note,
  };
}

/** 把 GoalStore 抛出的结构化错误转成工具结果（工具永远不抛） */
export function goalFailure(e: unknown): Record<string, unknown> {
  const code = (e as { code?: string })?.code;
  const message = e instanceof Error ? e.message : String(e);
  return { ok: false, ...(code ? { code } : {}), error: message };
}
