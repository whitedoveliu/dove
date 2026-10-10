/**
 * TerminalOpen —— 开一个**常驻** shell 会话（TerminalSend/Read/Close 的入口）
 * 与 Bash 的分工：Bash 每条命令一个新 shell（cd/export 不保留）；
 * 需要「先 cd 到某处，再连着干几件事」时用常驻会话。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { defineTool, S } from "../types.ts";
import { guarded, optStr, resolvePath } from "./util.ts";
import { openSession } from "./terminal-session.ts";

export const TerminalOpenTool = defineTool({
  name: "TerminalOpen",
  description:
    "开一个**常驻** shell 会话并返回 session_id：之后 TerminalSend 发的命令都在同一个 shell 里跑，" +
    "cd / export 出来的状态会一直保留（Bash 每条命令都是新 shell，不保留）。" +
    "适合「先 cd 到某处，再连着跑几条命令」；一次性命令仍优先用 Bash（更省）。" +
    "用完用 TerminalClose 关掉（会杀整个进程组），空闲 30 分钟也会自动回收。",
  parameters: S.obj({
    cwd: S.str("起始工作目录（默认当前工作目录；允许工作区外的路径，返回值里的 cwd 是真实路径）"),
    name: S.str("会话标签，给人看（可选）"),
  }, []),
  discoverable: "开一个常驻 shell 会话，跨命令保持 cwd 与环境变量",
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  timeoutMs: 30_000,   // 起 shell 的探针最长 8s，留足余量
  execute: (input, ctx) => guarded(async () => {
    const cwd = resolvePath(optStr(input, "cwd") ?? ctx.workdir, ctx.workdir);
    let isDir = false;
    try { isDir = fs.statSync(cwd).isDirectory(); } catch { /* 不存在 */ }
    if (!isDir) return { error: "目录不存在或不是目录：" + cwd };

    const r = await openSession({ cwd, name: optStr(input, "name"), threadId: ctx.threadId });
    if (!r.ok || !r.session) return { error: r.error ?? "开会话失败" };
    const s = r.session;
    ctx.emit("tool:terminal-open", { toolCallId: ctx.toolCallId, sessionId: s.id, pid: s.pid, pty: s.pty });
    const root = path.resolve(ctx.workdir);
    const outside = s.cwd !== root && !s.cwd.startsWith(root + path.sep);
    return {
      session_id: s.id, name: s.name, pid: s.pid, cwd: s.cwd, shell: s.shell, pty: s.pty,
      status: "ready",
      note: [
        r.note,
        outside ? "⚠️ 这个 cwd 在工作区（" + root + "）之外 —— 是你明确指定的路径，如实报告。" : "",
        "下一步用 TerminalSend 发命令（参数名 command）。",
      ].filter(Boolean).join(" "),
    };
  }),
});
