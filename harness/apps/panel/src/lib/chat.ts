/** 对话状态机：把 SSE 事件增量合并成可渲染的消息 + parts（纯函数，便于推理） */
import { extractCommand } from "./format.ts";
import type {
  Approval,
  AskRequest,
  PartState,
  SSEEvent,
  Todo,
  UIMessage,
  UIPart,
  UIToolPart,
} from "../types.ts";
import { isToolSettled } from "../types.ts";

export interface ChatState {
  threadId: string | null;
  messages: UIMessage[];
  streaming: boolean;
  loading: boolean;
  sessionId: string | null;
  turn: number;
  step: number;
  todos: Todo[];
  ask: AskRequest | null;
  error: string | null;
}

export const initialChatState: ChatState = {
  threadId: null,
  messages: [],
  streaming: false,
  loading: false,
  sessionId: null,
  turn: 0,
  step: 0,
  todos: [],
  ask: null,
  error: null,
};

export type ChatAction =
  | { type: "switch"; threadId: string | null }
  | { type: "history"; messages: UIMessage[]; error?: string }
  | { type: "reload" }
  | { type: "send"; text: string }
  | { type: "event"; event: SSEEvent }
  | { type: "finish"; reason?: string }
  | { type: "fail"; error: string }
  | { type: "resolveApproval"; toolCallId: string; decision: "allow" | "deny"; reason?: string }
  | { type: "clearAsk" };

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return prefix + "-" + Date.now().toString(36) + "-" + counter;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "switch":
      return { ...initialChatState, threadId: action.threadId, loading: Boolean(action.threadId) };
    case "reload":
      return { ...state, loading: true, error: null };
    case "history":
      return { ...state, loading: false, messages: action.messages, error: action.error ?? null };
    case "send":
      return {
        ...state,
        streaming: true,
        error: null,
        ask: null,
        messages: [
          ...state.messages,
          {
            id: nextId("u"),
            role: "user",
            parts: [{ kind: "text", id: nextId("t"), text: action.text, done: true }],
            createdAt: Date.now(),
          },
        ],
      };
    case "event":
      return applyEvent(state, action.event);
    case "finish":
      return closeOpen({ ...state, streaming: false }, action.reason);
    case "fail":
      return closeOpen({ ...state, streaming: false, error: action.error }, action.error);
    case "resolveApproval":
      return {
        ...state,
        messages: state.messages.map((m) => ({
          ...m,
          parts: m.parts.map((p) => {
            if (p.kind !== "tool" || p.toolCallId !== action.toolCallId) return p;
            const denied = action.decision === "deny";
            return {
              ...p,
              state: (denied ? "permission-denied" : "approval-responded") as PartState,
              errorText: denied ? action.reason || "用户拒绝" : p.errorText,
              finishedAt: Date.now(),
            };
          }),
        })),
      };
    case "clearAsk":
      return { ...state, ask: null };
    default:
      return state;
  }
}

/* ---------- 事件处理 ---------- */

function applyEvent(state: ChatState, ev: SSEEvent): ChatState {
  switch (ev.type) {
    case "session_id":
      return ev.content ? { ...state, sessionId: ev.content } : state;
    case "turn_start":
      return { ...state, turn: ev.turn ?? state.turn };
    case "step_start":
      return { ...state, step: ev.step ?? state.step };
    case "text":
      return appendDelta(state, "text", ev.content ?? "");
    case "reasoning":
      return appendDelta(state, "reasoning", ev.content ?? "");
    case "tool_start":
      return upsertTool(state, ev, "input-available");
    case "tool_approval":
      return upsertTool(state, ev, "approval-requested");
    case "tool_result":
      return settleTool(state, ev);
    case "ask_user":
      return ev.question
        ? { ...state, ask: { question: ev.question, suggestions: ev.suggestions ?? [] } }
        : state;
    case "todo_update":
      return { ...state, todos: ev.todos ?? [] };
    case "stats":
      return withStats(state, ev);
    case "error":
      return appendError(state, ev.content ?? "未知错误");
    case "done":
      return closeOpen({ ...state, streaming: false });
    default:
      return state;
  }
}

/** 找到（或新建）当前仍在接收的 assistant 消息 */
function ensureOpenAssistant(state: ChatState): { messages: UIMessage[]; index: number } {
  const messages = state.messages.slice();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    if (messages[i].open) return { messages, index: i };
    break;
  }
  messages.push({ id: nextId("a"), role: "assistant", parts: [], createdAt: Date.now(), open: true });
  return { messages, index: messages.length - 1 };
}

function appendDelta(state: ChatState, kind: "text" | "reasoning", delta: string): ChatState {
  if (!delta) return state;
  const { messages, index } = ensureOpenAssistant(state);
  const msg = messages[index];
  const parts = msg.parts.slice();
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) {
    parts[parts.length - 1] = { ...last, text: last.text + delta };
  } else {
    parts.push({ kind, id: nextId(kind), text: delta, done: false });
  }
  messages[index] = { ...msg, parts };
  return { ...state, messages };
}

/** 文本段落地（工具开始前收尾，避免光标一直闪） */
function settleTextParts(p: UIPart): UIPart {
  if ((p.kind === "text" || p.kind === "reasoning") && !p.done) return { ...p, done: true };
  return p;
}

function approvalOf(ev: SSEEvent, fallbackTool: string, input: unknown): Approval {
  return {
    toolCallId: ev.toolCallId ?? "",
    tool: ev.tool ?? fallbackTool,
    message: ev.message ?? "该工具调用需要人工确认",
    riskLevel: ev.riskLevel ?? "unknown",
    command: extractCommand(ev.input ?? input),
  };
}

function upsertTool(state: ChatState, ev: SSEEvent, partState: PartState): ChatState {
  const toolCallId = ev.toolCallId ?? ev.tool ?? "unknown";
  const { messages, index } = ensureOpenAssistant(state);
  const msg = messages[index];
  const parts = msg.parts.map(settleTextParts);
  const at = parts.findIndex((p) => p.kind === "tool" && p.toolCallId === toolCallId);
  if (at >= 0) {
    const prev = parts[at] as UIToolPart;
    parts[at] = {
      ...prev,
      name: ev.tool ?? prev.name,
      input: ev.input ?? prev.input,
      state: partState,
      approval: ev.type === "tool_approval" ? approvalOf(ev, prev.name, prev.input) : prev.approval,
    };
  } else {
    parts.push({
      kind: "tool",
      id: nextId("tool"),
      toolCallId,
      name: ev.tool ?? "tool",
      input: ev.input,
      state: partState,
      approval: ev.type === "tool_approval" ? approvalOf(ev, ev.tool ?? "tool", ev.input) : undefined,
      startedAt: Date.now(),
    });
  }
  messages[index] = { ...msg, parts };
  return { ...state, messages };
}

function isErrorResult(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result === "string") return /^\s*(error|错误|失败)[:：\s]/i.test(result);
  if (typeof result === "object") {
    const bag = result as Record<string, unknown>;
    if (bag.isError === true || bag.ok === false || bag.is_error === true) return true;
    if (typeof bag.error === "string" && bag.error.trim()) return true;
    if (typeof bag.errorText === "string" && bag.errorText.trim()) return true;
  }
  return false;
}

function errorTextOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const bag = result as Record<string, unknown>;
    if (typeof bag.error === "string") return bag.error;
    if (typeof bag.errorText === "string") return bag.errorText;
  }
  return "工具执行失败";
}

function settleTool(state: ChatState, ev: SSEEvent): ChatState {
  const toolCallId = ev.toolCallId ?? ev.tool ?? "";
  const failed = isErrorResult(ev.result);
  let found = false;
  const messages = state.messages.map((m) => {
    if (found) return m;
    const at = m.parts.findIndex((p) => p.kind === "tool" && p.toolCallId === toolCallId);
    if (at < 0) return m;
    found = true;
    const parts = m.parts.slice();
    const prev = parts[at] as UIToolPart;
    parts[at] = {
      ...prev,
      name: ev.tool ?? prev.name,
      output: ev.result,
      spillPath: ev.spillPath ?? prev.spillPath,
      errorText: failed ? errorTextOf(ev.result) : prev.errorText,
      state: failed ? "output-error" : "output-available",
      finishedAt: Date.now(),
    };
    return { ...m, parts };
  });
  if (found) return { ...state, messages };
  // 结果先于 start 到达：补一张已完成的卡片
  const synthetic: SSEEvent = { ...ev, input: undefined };
  const withCard = upsertTool({ ...state, messages }, synthetic, failed ? "output-error" : "output-available");
  return settleTool(withCard, ev);
}

function withStats(state: ChatState, ev: SSEEvent): ChatState {
  const messages = state.messages.slice();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    messages[i] = { ...messages[i], usage: ev.usage ?? messages[i].usage, durationMs: ev.durationMs ?? messages[i].durationMs };
    break;
  }
  return { ...state, messages };
}

function appendError(state: ChatState, text: string): ChatState {
  const { messages, index } = ensureOpenAssistant(state);
  const msg = messages[index];
  messages[index] = { ...msg, parts: [...msg.parts, { kind: "error", id: nextId("err"), text }] };
  return { ...state, messages, error: text };
}

/** 收尾：未完成的工具落失败态，未完成的文本段落定 */
function closeOpen(state: ChatState, reason?: string): ChatState {
  return {
    ...state,
    messages: state.messages.map((m) => ({
      ...m,
      open: false,
      parts: m.parts.map((p): UIPart => {
        if (p.kind === "tool" && !isToolSettled(p.state)) {
          return {
            ...p,
            state: "output-error" as PartState,
            errorText: p.errorText ?? reason ?? "生成中断，状态未知",
            finishedAt: p.finishedAt ?? Date.now(),
          };
        }
        return settleTextParts(p);
      }),
    })),
  };
}
/** 当前待审批的工具（取第一个 approval-requested） */
export function pendingApproval(messages: UIMessage[]): UIToolPart | null {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === "tool" && p.state === "approval-requested") return p;
    }
  }
  return null;
}
