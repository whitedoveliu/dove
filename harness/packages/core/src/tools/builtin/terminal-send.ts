/**
 * TerminalSend —— 往常驻会话里发命令并等它跑完
 * ⚠️ 参数名必须叫 command：loop/tool-exec.ts 的启发式审批**只读 args.command / args.cmd**，
 *    改名（text/input/…）会让这个工具**永远不触发审批** —— 这个项目为此栽过一次。
 */
import { defineTool, S } from "../types.ts";
import { clampNum, guarded, optBool, optNum, str } from "./util.ts";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, sendToSession } from "./terminal-session.ts";

export const TerminalSendTool = defineTool({
  name: "TerminalSend",
  description:
    "往 TerminalOpen 开的常驻会话里发一条命令，并等它跑完（默认等 " + DEFAULT_WAIT_MS + "ms，上限 " + MAX_WAIT_MS + "ms）。" +
    "wait_reason 说明为什么返回：prompt=命令跑完回到了提示符（正常）/ timeout=等待超时（命令可能还在跑，也可能卡住）" +
    "/ exit=shell 在这期间退出了。output 只含**本次命令**新产生的输出。" +
    "同一会话一次只允许一条在飞命令：上一条还没回来时再发会被拒（防止输出交错）。" +
    "submit=false 表示只写文本不回车（送控制字符、给 REPL 送半截输入时用）；" +
    "反过来 command 传空串 + submit=true 就是**单发一个回车**（用来结束半截输入）。",
  parameters: S.obj({
    session_id: S.str("TerminalOpen 返回的会话 id"),
    command: S.str("要发给 shell 的命令（默认自动补一个回车）"),
    wait_ms: S.num("等多久算超时（默认 " + DEFAULT_WAIT_MS + "，最大 " + MAX_WAIT_MS + "）"),
    submit: S.bool("false = 只写文本不按回车（默认 true）"),
  }, ["session_id", "command"]),
  discoverable: "往常驻终端会话里发一条命令并等它跑完",
  outputTier: "compact",
  approval: "heuristic",
  concurrencySafe: false,
  timeoutMs: MAX_WAIT_MS + 20_000,
  execute: (input, ctx) => guarded(async () => {
    const sessionId = str(input, "session_id");
    const submit = optBool(input, "submit", true);
    // command 允许空串：submit=true 时就是「单发一个回车」，用来结束半截输入。
    // 但空串 + 不回车 = 什么都没写，直接拒（别让模型以为发了）。
    const raw = input.command;
    const command = raw === undefined || raw === null ? "" : String(raw);
    if (!command && !submit) return { session_id: sessionId, error: "command 为空且 submit=false：没有任何东西可写。" };
    const waitMs = Math.floor(clampNum(optNum(input, "wait_ms") ?? DEFAULT_WAIT_MS, 200, MAX_WAIT_MS));
    const r = await sendToSession({ id: sessionId, threadId: ctx.threadId, text: command, waitMs, submit });
    if (!r.ok) {
      return { session_id: r.session_id ?? sessionId, error: r.error, session_status: r.session_status ?? "unknown" };
    }
    ctx.emit("tool:terminal-send", {
      toolCallId: ctx.toolCallId, sessionId, waitReason: r.wait_reason, status: r.session_status,
    });
    return {
      session_id: r.session_id, output: r.output, wait_reason: r.wait_reason,
      session_status: r.session_status, exit_code: r.exit_code, truncated: r.truncated, note: r.note,
    };
  }),
});
