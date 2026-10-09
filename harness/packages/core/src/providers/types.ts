/**
 * Provider 抽象（T1.1）
 * 形态对齐 AI SDK 的 streamText：一次调用 = 一个流式 step，
 * 内部可能产生多个 tool call，结束后回填 messages 再进下一步。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[] | null;
  tool_calls?: ToolCallPayload[];
  tool_call_id?: string;
  name?: string;
}

export interface ContentBlock {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ToolCallPayload {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "high" | "max";
  signal?: AbortSignal;
  /** 流式增量 */
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  /** 每个 step 结束后的用量 */
  onUsage?: (u: StreamUsage) => void;
}

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StreamResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCallPayload[];
  usage: StreamUsage;
  finishReason: string;
  /** 原始错误（若有） */
  error?: string;
}

export interface Provider {
  id: string;
  stream(opts: StreamOptions): Promise<StreamResult>;
}

export class EmptyStreamError extends Error {
  constructor() { super("LLM_EMPTY_STREAM"); this.name = "EmptyStreamError"; }
}
