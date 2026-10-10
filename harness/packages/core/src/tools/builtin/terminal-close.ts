/**
 * TerminalClose —— 关闭常驻会话
 * 纪律：**等到进程真的没了才返回**（SIGTERM → 3s → SIGKILL 进程组），绝不留孤儿。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str } from "./util.ts";
import { closeSession } from "./terminal-session.ts";

export const TerminalCloseTool = defineTool({
  name: "TerminalClose",
  description:
    "关闭 TerminalOpen 开的常驻会话：先给**整个进程组**发 SIGTERM，3 秒还没退就 SIGKILL，" +
    "**确认进程真的消失**才返回（closed=true）。返回值里 note 会说明是否强杀。" +
    "会话已经退出/已经关闭过也不算错，error 只在「id 不存在」或「不属于本线程」时出现。",
  parameters: S.obj({
    session_id: S.str("要关闭的会话 id"),
  }, ["session_id"]),
  discoverable: "关闭常驻 shell 会话并确认进程组已退出",
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  timeoutMs: 20_000,   // 最坏 3s(SIGTERM 宽限) + 2s(SIGKILL 等待)
  execute: (input, ctx) => guarded(async () => {
    const sessionId = str(input, "session_id");
    const r = await closeSession(sessionId, ctx.threadId);
    if (!r.ok) return { session_id: sessionId, closed: false, error: r.error };
    ctx.emit("tool:terminal-close", { toolCallId: ctx.toolCallId, sessionId, closed: r.closed === true });
    return { session_id: r.session_id, closed: r.closed, note: r.note };
  }),
});
