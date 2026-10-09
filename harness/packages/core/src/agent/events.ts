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
  | "stats" | "error" | "done";

export interface AgentEvent {
  type: AgentEventType;
  seq?: number;
  [k: string]: unknown;
}

export type EventSink = (e: AgentEvent) => void;
