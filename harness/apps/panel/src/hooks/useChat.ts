/** 对话 hook：历史加载 + SSE 流 + 停止 / 回答 / 审批 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { api } from "../lib/api.ts";
import { chatReducer, initialChatState, pendingApproval } from "../lib/chat.ts";
import { fromRawMessages } from "../lib/history.ts";
import { streamChat } from "../lib/sse.ts";
import type { UIToolPart } from "../types.ts";

export function useChat(threadId: string | null, projectId: string | null) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const projectRef = useRef<string | null>(null);
  streamingRef.current = state.streaming;
  projectRef.current = projectId;

  // 切会话：清空并拉历史
  useEffect(() => {
    dispatch({ type: "switch", threadId });
    if (!threadId) return;
    let cancelled = false;
    api
      .messages(threadId)
      .then((raw) => {
        if (!cancelled) dispatch({ type: "history", messages: fromRawMessages(raw) });
      })
      .catch((err: unknown) => {
        if (!cancelled) dispatch({ type: "history", messages: [], error: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const send = useCallback(
    async (text: string) => {
      const tid = threadId;
      const body = text.trim();
      if (!tid || !body || streamingRef.current) return;
      dispatch({ type: "send", text: body });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await streamChat(
          { threadId: tid, message: body, projectId: projectRef.current },
          { signal: ctrl.signal, onEvent: (event) => dispatch({ type: "event", event }) },
        );
        dispatch({ type: "finish" });
      } catch (err) {
        if (ctrl.signal.aborted) dispatch({ type: "finish", reason: "已停止" });
        else dispatch({ type: "fail", error: (err as Error).message });
      } finally {
        abortRef.current = null;
      }
    },
    [threadId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (threadId) api.stop(threadId).catch(() => undefined);
    dispatch({ type: "finish", reason: "用户已停止" });
  }, [threadId]);

  /** 回答 ask_user */
  const reply = useCallback(
    async (answer: string) => {
      if (!threadId) return;
      dispatch({ type: "clearAsk" });
      try {
        await api.answer(threadId, answer);
      } catch (err) {
        dispatch({ type: "event", event: { type: "error", content: (err as Error).message } });
      }
    },
    [threadId],
  );

  /** 审批工具调用 */
  const decide = useCallback(
    async (part: UIToolPart, approved: boolean, reason?: string) => {
      if (!threadId) return;
      dispatch({
        type: "resolveApproval",
        toolCallId: part.toolCallId,
        decision: approved ? "allow" : "deny",
        reason,
      });
      try {
        await api.approve({ threadId, toolCallId: part.toolCallId, approved, reason });
      } catch (err) {
        dispatch({ type: "event", event: { type: "error", content: (err as Error).message } });
      }
    },
    [threadId],
  );

  const dismissAsk = useCallback(() => dispatch({ type: "clearAsk" }), []);

  const approval = useMemo(() => pendingApproval(state.messages), [state.messages]);

  return { state, approval, send, stop, reply, decide, dismissAsk };
}
