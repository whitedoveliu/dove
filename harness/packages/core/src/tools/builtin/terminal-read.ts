/**
 * TerminalRead —— 回看常驻会话的输出历史（按行分页）
 * offset 从**最新**往回数（0 = 最新一行），lines 是要取多少行。
 */
import { defineTool, S } from "../types.ts";
import { clampNum, guarded, optNum, str } from "./util.ts";
import { DEFAULT_READ_LINES, MAX_BUFFER_LINES, readSession } from "./terminal-session.ts";

export const TerminalReadTool = defineTool({
  name: "TerminalRead",
  description:
    "回看常驻会话的输出缓冲（滚动保留最近 " + MAX_BUFFER_LINES + " 行 / 256 KiB，更早的被丢弃时 truncated=true）。" +
    "offset 从**最新**往回数：0 = 最新一行，1 = 跳过最新一行再往前取；lines 是取多少行（默认 " + DEFAULT_READ_LINES + "）。" +
    "配合 timeout 的 TerminalSend 用它看「命令后来跑出什么了」。会话 id 不存在会返回 error，不会抛。",
  parameters: S.obj({
    session_id: S.str("TerminalOpen 返回的会话 id"),
    lines: S.num("取多少行（默认 " + DEFAULT_READ_LINES + "，最大 " + MAX_BUFFER_LINES + "）"),
    offset: S.num("从最新往回跳过多少行（默认 0）"),
  }, ["session_id"]),
  discoverable: "回看常驻终端会话的输出历史（按行分页）",
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const sessionId = str(input, "session_id");
    const lines = Math.floor(clampNum(optNum(input, "lines") ?? DEFAULT_READ_LINES, 1, MAX_BUFFER_LINES));
    const offset = Math.floor(clampNum(optNum(input, "offset") ?? 0, 0, Number.MAX_SAFE_INTEGER));
    const r = readSession({ id: sessionId, threadId: ctx.threadId, lines, offset });
    if (!r.ok) return { session_id: sessionId, error: r.error };
    return {
      session_id: r.session_id, text: r.text, total_lines: r.total_lines, returned: r.returned,
      dropped_lines: r.dropped_lines || undefined, truncated: r.truncated, note: r.note,
    };
  }),
});
