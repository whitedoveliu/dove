/**
 * 工具层的 Goal 端口 —— **形状定义在 tools/types.ts**，这里只做转发与三个小助手。
 *
 * 为什么不在这里定义：runtime.ts 的 AgentServices 也要引用同一个 GoalPort；
 * 定义两处迟早漂移。工具层不 import agents/（依赖方向是 tools 在下层），
 * 真正的实现 GoalStore 由 server 层注入。
 *
 * ⚠️ 验收标准（criteria）这几个字段**故意不写进 tools/types.ts**：那里是给模型侧的
 *    GoalPort 形状，而 criteria 的形状（GoalCriterion）与判定在 agents/goal-criteria.ts。
 *    就地加宽成结构类型即可 —— GoalStore 本来就满足，工具层也不用回头依赖 agents/。
 */
import type { GoalPort, GoalView } from "../types.ts";

export type { GoalPort, GoalView };

/** 一条验收标准的形状（与 agents/goal-criteria.ts 的 GoalCriterion 结构一致） */
export interface GoalCriterionView {
  id: string;
  description: string;
  /** 0–100；得分 >= threshold 才算通过 */
  threshold: number;
}

/** 最近一次独立评估（轮末由目标续跑写入，模型改不了） */
export interface GoalEvalView {
  pass: boolean;
  round: number;
  reason: string;
  failures?: { id: string; description: string; reason: string; score: number | null; threshold: number }[];
}

export interface GoalViewWithCriteria extends GoalView {
  criteria?: GoalCriterionView[];
  lastVerdict?: GoalEvalView;
}

/** 比 tools 层的 GoalPort 宽一点：create 收 criteria，get 回 criteria/最近一次评估 */
export interface GoalPortWithCriteria extends GoalPort {
  get(threadId: string): GoalViewWithCriteria | null;
  create(threadId: string, input: { objective: string; maxRounds?: number; criteria?: unknown }): GoalViewWithCriteria;
}

export function goalPort(ctx: { services: unknown }): GoalPortWithCriteria | undefined {
  return (ctx.services as { goals?: GoalPortWithCriteria }).goals;
}

export function goalPayload(rec: GoalViewWithCriteria | null): Record<string, unknown> {
  if (!rec) return { goal: null, note: "当前会话没有目标。要长期推进就用 CreateGoal 建一个。" };
  const graded = (rec.criteria?.length ?? 0) > 0;
  const note = rec.phase === "active"
    ? "目标进行中（第 " + rec.roundsStarted + "/" + rec.maxRounds + " 轮）。做完并验证过再 UpdateGoal action=complete。"
      + (graded ? "这个目标带 " + rec.criteria!.length + " 条验收标准：轮末会自动跑独立评估，没过（或没有可核验证据）时 complete 会被拒。" : "")
    : rec.phase === "complete" ? "目标已完成。" : "目标已停止自动推进（不会自动开下一轮）。";
  return {
    goal: {
      id: rec.id, revision: rec.revision, objective: rec.objective, phase: rec.phase,
      rounds_started: rec.roundsStarted, max_rounds: rec.maxRounds,
      ...(graded ? { criteria: rec.criteria } : {}),
      ...(rec.lastVerdict ? {
        last_eval: {
          pass: rec.lastVerdict.pass, round: rec.lastVerdict.round, reason: rec.lastVerdict.reason,
          ...(rec.lastVerdict.failures ? { failures: rec.lastVerdict.failures } : {}),
        },
      } : {}),
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
