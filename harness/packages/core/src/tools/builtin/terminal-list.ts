/**
 * TerminalList —— 列出本线程还活着的常驻会话
 * 只列**当前线程**的：别的线程的会话既看不见也操作不了（注册表按 threadId 隔离）。
 */
import { defineTool, S } from "../types.ts";
import { guarded } from "./util.ts";
import { listSessions } from "./terminal-session.ts";

export const TerminalListTool = defineTool({
  name: "TerminalList",
  description:
    "列出本线程还开着的常驻终端会话：session_id / name / pid / cwd / running / idle_ms / last_command。" +
    "idle_ms 是距上次使用的毫秒数（空闲 30 分钟会被自动回收），last_command 是最后发过的那条命令。" +
    "收尾前用它检查有没有忘了关的会话。",
  parameters: S.obj({}, []),
  discoverable: "列出当前线程还开着的常驻终端会话",
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  timeoutMs: 10_000,
  execute: (_input, ctx) => guarded(async () => {
    const sessions = listSessions(ctx.threadId);
    return {
      sessions,
      count: sessions.length,
      note: sessions.length ? "不需要了就 TerminalClose 关掉。" : "当前没有常驻终端会话（TerminalOpen 可以开一个）。",
    };
  }),
});
