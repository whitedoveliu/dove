/**
 * Bash —— 执行 shell 命令（spawn / shell:true，超时默认 600s）
 * 纪律：前台输出**不在这里截断**，超长由 budget.ts 统一裁剪 + 落盘（T3.5）。
 * 支持 run_in_background → 返回 job_id，用 BashOutput 读、KillShell 杀。
 */
import { spawn } from "node:child_process";
import { defineTool, S } from "../types.ts";
import type { ToolContext } from "../types.ts";
import { guarded, str, optNum, optBool } from "./util.ts";
import { TOOL_TIMEOUT_MS } from "../../constants.ts";
import { startJob } from "./jobs.ts";

/** 极端保护：单流超过这个量级直接杀进程，避免 OOM（正常截断由 budget.ts 负责） */
const HARD_MAX_CHARS = 64 * 1024 * 1024;

function runForeground(command: string, ctx: ToolContext, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: ctx.workdir, shell: true, env: process.env });
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const kill = (sig: string) => { try { child.kill(sig as NodeJS.Signals); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 3000);
    }, timeoutMs);
    const onAbort = () => kill("SIGTERM");
    if (ctx.signal) ctx.signal.addEventListener("abort", onAbort, { once: true });

    const push = (which: "stdout" | "stderr", chunk: Buffer) => {
      const next = (which === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (next.length > HARD_MAX_CHARS) {
        overflow = true;
        if (which === "stdout") stdout = next.slice(0, HARD_MAX_CHARS); else stderr = next.slice(0, HARD_MAX_CHARS);
        kill("SIGKILL");
        return;
      }
      if (which === "stdout") stdout = next; else stderr = next;
    };
    child.stdout?.on("data", (d: Buffer) => push("stdout", d));
    child.stderr?.on("data", (d: Buffer) => push("stderr", d));

    const done = (code: number | null, signal: string | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      const notes: string[] = [];
      if (timedOut) notes.push("命令超过 " + timeoutMs + " ms 被终止；长任务请用 run_in_background=true。");
      if (overflow) notes.push("输出超过 " + HARD_MAX_CHARS + " 字符硬上限，进程已被强制终止，只保留前 " + HARD_MAX_CHARS + " 字符。");
      if (ctx.signal?.aborted) notes.push("调用被中止。");
      resolve({
        command,
        stdout,
        stderr,
        exit_code: code,
        signal,
        timed_out: timedOut || undefined,
        overflow: overflow || undefined,
        duration_ms: Date.now() - started,
        error: spawnError,
        note: notes.length ? notes.join(" ") : undefined,
      });
    };

    child.on("error", (e) => done(null, null, "启动失败：" + e.message));
    child.on("close", (code, signal) => done(code, signal));
  });
}

export const BashTool = defineTool({
  name: "Bash",
  description:
    "执行 shell 命令并返回 stdout/stderr/exit_code（默认超时 600s）。" +
    "读文件/搜索优先用 Read/Grep/Glob；写文件优先用 Write/Edit。" +
    "输出很长时会被统一裁剪并**落盘**，结果里会给出存档路径；需要完整输出必须读该存档文件（分页读遍）。" +
    "长任务用 run_in_background=true，再用 BashOutput 读、KillShell 杀。",
  parameters: S.obj({
    command: S.str("要执行的 shell 命令"),
    timeout_ms: S.num("超时毫秒（默认 " + TOOL_TIMEOUT_MS + "，最大 " + TOOL_TIMEOUT_MS * 4 + "）"),
    run_in_background: S.bool("true = 后台执行并立即返回 job_id"),
    description: S.str("这条命令做什么（5-10 个字，给人看）"),
  }, ["command"]),
  outputTier: "compact",
  approval: "heuristic",
  concurrencySafe: false,
  timeoutMs: TOOL_TIMEOUT_MS,
  execute: (input, ctx) => guarded(async () => {
    const command = str(input, "command");
    if (optBool(input, "run_in_background", false)) {
      const job = startJob({ command, cwd: ctx.workdir, threadId: ctx.threadId });
      ctx.emit("tool:bg-started", { toolCallId: ctx.toolCallId, jobId: job.id, command });
      return {
        job_id: job.id,
        status: "running",
        pid: job.child?.pid,
        note: "已在后台执行。用 BashOutput 读输出（可带 wait_seconds 等它结束），用 KillShell 终止。",
      };
    }
    const timeoutMs = Math.max(1000, Math.min(TOOL_TIMEOUT_MS * 4, Math.floor(optNum(input, "timeout_ms") ?? TOOL_TIMEOUT_MS)));
    return await runForeground(command, ctx, timeoutMs);
  }),
});
