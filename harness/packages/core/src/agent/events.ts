/**
 * 事件类型（T0.6；借鉴 Codex 的封闭枚举思想）
 * 唯一出口：内核任何模块都不直接推事件给 UI，一律走这里。
 */
export type AgentEventType =
  | "session_id" | "turn_start" | "step_start"
  | "text" | "reasoning"
  | "tool_start" | "tool_result" | "tool_approval"
  | "ask_user" | "todo_update"
  | "compaction" | "repair" | "steering"
  /**
   * 这一轮结束了，但**用户什么都没看到**（没有 assistant 文本、也没有 AttemptCompletion）。
   * 载荷：{ endReason, aborted, note }。面板据此把消息标成「已中断」并给出重试按钮 ——
   * 没有它，客户端断开时界面会永远停在"什么都没发生"（见 agent/turn-outcome.ts 的说明）。
   */
  | "interrupted"
  | "stats" | "error" | "done"
  /**
   * 长期目标（goal）的事件。评估结论必须发出来 —— 没有它，用户只会看到
   * 「目标一直没完成」而不知道是哪一条验收标准没过（见 agents/goal-evaluator.ts）。
   *   goal_eval   ：{ pass, round, reason, failures[], scored[], evidence, evaluator, note? }
   *   goal_round  ：{ round, objective, eval_failures? }
   *   goal_blocked：{ reason }
   */
  | "goal_eval" | "goal_round" | "goal_blocked";

export interface AgentEvent {
  type: AgentEventType;
  seq?: number;
  [k: string]: unknown;
}

export type EventSink = (e: AgentEvent) => void;
