/**
 * 目标自动续跑：**一轮跑完后**如果会话还有 active 目标，就带着 <goal_round> 再开一轮。
 *
 * 判定权在代码里（decideGoalContinuation），不在提示词里 —— 轮次上限、phase、是否被人类暂停都是硬条件。
 * 单次请求内还有一道硬上限：防止一个 HTTP/SSE 请求跑飞（剩下的轮次留给下一次消息）。
 *
 * 验收标准这条线（Alma Sprint Harness 的纪律）：**轮末先评估，再决定能不能收尾**。
 * 评估器是独立的一次调用，只看目标原文 + 验收标准 + 落盘证据，看不到主代理的自我陈述；
 * 没过就把失败项塞进下一轮的提示词，并且 GoalStore 那边会硬拒 UpdateGoal action=complete。
 * 评估器**可注入**（opts.evaluator）：冒烟脚本用桩替掉，测试不绑死在真模型上。
 */
import { decideGoalContinuation } from "../../core/src/agent/goal-round.ts";
import type { GoalFeedbackItem } from "../../core/src/agent/goal-round.ts";
import type { AgentRuntime } from "../../core/src/agent/runtime.ts";
import type { TurnMode } from "../../core/src/agent/mode-injection.ts";
import type { GoalPort, GoalView } from "../../core/src/tools/types.ts";
import type { GoalCriterion, GoalVerdict } from "../../core/src/agents/goal-criteria.ts";
import { collectRoundEvidence } from "../../core/src/agents/goal-evidence.ts";
import { makeModelEvaluator } from "../../core/src/agents/goal-evaluator.ts";
import type { GoalEvaluator } from "../../core/src/agents/goal-evaluator.ts";

/** 一次请求内最多自动续几轮（真正的轮数上限在 goal.maxRounds，这个只是防跑飞） */
export const MAX_AUTO_ROUNDS_PER_REQUEST = 5;

/**
 * 运行时内需要的目标视图/端口：比 tools 层的 GoalPort 多 criteria 与最近一次评估。
 *
 * 为什么不直接改 tools/types.ts 的 GoalPort：那是**给模型侧**的契约形状，而
 * recordVerdict 是运行时内部的动作（模型不能自己给自己写验收结论）。就地加宽，
 * GoalStore 结构上满足它，工具契约保持干净。
 */
interface GoalRunView extends GoalView {
  criteria: GoalCriterion[];
  lastVerdict?: GoalVerdict;
}
interface GoalRunPort extends GoalPort {
  get(threadId: string): GoalRunView | null;
  recordVerdict?(threadId: string, goalId: string, verdict: GoalVerdict): GoalRunView | null;
}

export interface GoalRunOptions {
  threadId: string;
  userText: string;
  projectId?: string | null;
  model?: string;
  signal?: AbortSignal;
  sink: (e: { type: string; [k: string]: unknown }) => void;
  /** 这一轮的模式（透传给 runtime.run）：面板从 /api/chat 的 body.mode 传下来 */
  mode?: TurnMode;
  /** 验收评估器（可注入）。不传 = 用真模型评估器 */
  evaluator?: GoalEvaluator;
}

function lastMessageId(runtime: AgentRuntime, threadId: string): string | undefined {
  try { return runtime.services.store.recentMessages(threadId, 1)[0]?.id; }
  catch { return undefined; }
}

/** 证据里的相对路径要靠它解析；口径与 runtime.run 一致（项目目录 → 首个项目 → cwd） */
function workdirOf(runtime: AgentRuntime, opts: GoalRunOptions): string {
  try {
    const store = runtime.services.store;
    const pid = opts.projectId ?? store.getThread(opts.threadId)?.projectId ?? null;
    const proj = pid ? store.getProject(pid) : undefined;
    return proj?.path ?? store.listProjects()[0]?.path ?? process.cwd();
  } catch { return process.cwd(); }
}

function evalModel(runtime: AgentRuntime, opts: GoalRunOptions): string {
  try { return opts.model ?? runtime.services.store.getThread(opts.threadId)?.model ?? "deepseek-flash"; }
  catch { return opts.model ?? "deepseek-flash"; }
}

export async function runWithGoalContinuation(
  runtime: AgentRuntime, opts: GoalRunOptions,
): Promise<{ rounds: number; endReason: string }> {
  const goals = runtime.services.goals as GoalRunPort | undefined;
  const evaluator = opts.evaluator
    ?? makeModelEvaluator({ provider: runtime.services.provider, model: evalModel(runtime, opts), signal: opts.signal });

  let since = lastMessageId(runtime, opts.threadId);
  let result = await runtime.run(opts as never);
  let rounds = 0;
  let feedback: { items: GoalFeedbackItem[]; reason?: string } | null = null;

  while (true) {
    if (!goals) break;
    // 用户中止了这一轮（点了停止）：别再评估、也别再续跑 ——
    // 中止的一轮本来就没有完整证据，评了只会误判；继续跑下去则是拿同一份证据反复烧 token。
    if (opts.signal?.aborted) break;
    let goal = goals.get(opts.threadId) ?? null;
    if (!goal) break;

    // ── ① 独立评估：只在「还活着的、带验收标准的」目标上做。
    //    没配 criteria 的目标一步都不多走（老行为，回归靠它）。
    if (goal.phase === "active" && goal.criteria.length > 0) {
      const round = goal.roundsStarted + 1;
      const evidence = collectRoundEvidence(runtime.services.store, opts.threadId, {
        workdir: workdirOf(runtime, opts), sinceMessageId: since,
      });
      const verdict = await evaluator.evaluate({
        objective: goal.objective, criteria: goal.criteria, evidence, round,
      });
      const recorded = goals.recordVerdict?.(opts.threadId, goal.id, verdict);
      opts.sink({
        type: "goal_eval",
        pass: verdict.pass,
        round,
        reason: verdict.reason,
        failures: verdict.failures.map((f) => ({ id: f.id, description: f.description, reason: f.reason, score: f.score, threshold: f.threshold })),
        scored: verdict.items.map((s) => ({ id: s.id, score: s.score })),
        evidence: evidence.length,
        evaluator: evaluator.id ?? "unknown",
        // 端口写不回结论时闸门会一直关着（fail-closed）：这事必须说出来，否则只有模型在原地打转
        ...(recorded ? {} : { note: "目标端口不支持 recordVerdict：评估结论没能落盘，complete 会一直被拒。" }),
      });
      feedback = verdict.pass ? null : { items: verdict.failures, reason: verdict.reason };
      // 评估期间用户可能刚暂停/完成/改目标：重读一次，尊重人的决定
      goal = goals.get(opts.threadId) ?? goal;
      if (goal.phase !== "active") break;
    } else {
      feedback = null;
    }

    const decision = decideGoalContinuation(goal, { feedback });
    if (decision.action !== "continue") {
      if (decision.action === "blocked") opts.sink({ type: "goal_blocked", reason: decision.reason });
      break;
    }
    if (rounds >= MAX_AUTO_ROUNDS_PER_REQUEST) break;
    try {
      goals.bumpRound(opts.threadId, goal.id, goal.revision);
    } catch { break; }   // revision 过期（用户刚改过）→ 停下，别覆盖人的决定
    rounds++;
    opts.sink({
      type: "goal_round", round: decision.round, objective: goal.objective,
      ...(feedback ? { eval_failures: feedback.items.map((f) => f.id) } : {}),
    });
    since = lastMessageId(runtime, opts.threadId);
    result = await runtime.run({ ...opts, userText: decision.prompt } as never);
  }
  return { rounds, endReason: (result as { endReason?: string }).endReason ?? "stop" };
}
