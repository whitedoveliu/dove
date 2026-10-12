/**
 * Bash —— 执行 shell 命令（spawn / shell:true；工具超时 600s，见 TOOL_TIMEOUT_MS）
 * 纪律：前台输出**不在这里截断**，超长由 budget.ts 统一裁剪 + 落盘（T3.5）。
 * 支持 run_in_background → 返回 job_id，用 BashOutput 读、KillShell 杀。
 *
 * 自动转后台（Alma §3.2.1）：模型**没显式给 timeout_ms** 时，命令跑满
 * autoBackgroundMs()（默认 60 秒）就不再干等 —— 收编成后台任务，立即返回 job_id。
 * 显式给了 timeout_ms 就按老规矩办（那是模型明确要求的时限，不能悄悄改语义）。
 */
import { spawn } from "node:child_process";
import { defineTool, S } from "../types.ts";
import type { ToolContext } from "../types.ts";
import { guarded, str, optNum, optBool } from "./util.ts";
import { TOOL_TIMEOUT_MS, humanDuration } from "../../constants.ts";
import { startJob, adoptJob, autoBackgroundMs } from "./jobs.ts";

/** 极端保护：单流超过这个量级直接杀进程，避免 OOM（正常截断由 budget.ts 负责） */
const HARD_MAX_CHARS = 64 * 1024 * 1024;

function runForeground(
  command: string, ctx: ToolContext, timeoutMs: number, autoBgMs: number | null,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: ctx.workdir, shell: true, env: process.env });
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let lastPushAt = started;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const kill = (sig: string) => { try { child.kill(sig as NodeJS.Signals); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 3000);
    }, timeoutMs);
    const bgTimer = autoBgMs === null ? null : setTimeout(promote, autoBgMs);
    const onAbort = () => kill("SIGTERM");
    if (ctx.signal) ctx.signal.addEventListener("abort", onAbort, { once: true });

    const push = (which: "stdout" | "stderr", chunk: Buffer) => {
      lastPushAt = Date.now();
      const next = (which === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (next.length > HARD_MAX_CHARS) {
        overflow = true;
        if (which === "stdout") stdout = next.slice(0, HARD_MAX_CHARS); else stderr = next.slice(0, HARD_MAX_CHARS);
        kill("SIGKILL");
        return;
      }
      if (which === "stdout") stdout = next; else stderr = next;
    };
    function onStdout(d: Buffer): void { push("stdout", d); }
    function onStderr(d: Buffer): void { push("stderr", d); }
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);

    /** 到点还没跑完 → 收编成后台任务（同一次事件循环里摘旧监听 + 挂新监听，不丢数据） */
    function promote(): void {
      if (settled) return;
      // 已经 exit 的就别收编了：让 close 路径正常收尾（收编反而可能收不到 close 事件）
      if (child.exitCode !== null || child.signalCode !== null) return;
      settled = true;
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      // 摘旧挂新必须在同一个同步块里 —— 中间让出事件循环，这期间到达的 data 就没人接了
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      const job = adoptJob({
        child, command, cwd: ctx.workdir, threadId: ctx.threadId,
        stdout, stderr, startedAt: started, lastOutputAt: lastPushAt,
      });
      ctx.emit("tool:bg-started", { toolCallId: ctx.toolCallId, jobId: job.id, command, promoted: true });
      resolve({
        command,
        job_id: job.id,
        status: "running",
        pid: child.pid,
        promoted_to_background: true,
        stdout,
        stderr,
        duration_ms: Date.now() - started,
        note: "命令跑满 " + humanDuration(autoBgMs ?? 0) + " 还没结束，已自动转后台（job_id=" + job.id +
          "）：用 BashOutput 取结果（可带 wait_seconds 等它结束），用 KillShell 终止。",
      });
    }

    const done = (code: number | null, signal: string | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (bgTimer) clearTimeout(bgTimer);
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
    "执行 shell 命令并返回 stdout/stderr/exit_code。" +
    "读文件/搜索优先用 Read/Grep/Glob；写文件优先用 Write/Edit。" +
    "未显式给 timeout_ms 时，超过 " + humanDuration(autoBackgroundMs()) + " 的命令会**自动转后台**（返回 job_id）、用 BashOutput 取结果；" +
    "显式给了 timeout_ms 就按时终止（最大 " + TOOL_TIMEOUT_MS * 4 + " ms）。" +
    "输出很长时会被统一裁剪并**落盘**，结果里会给出存档路径；需要完整输出必须读该存档文件（分页读遍）。" +
    "长任务直接用 run_in_background=true 更干脆；后台任务用 BashOutput 读、KillShell 杀。",
  parameters: S.obj({
    command: S.str("要执行的 shell 命令"),
    timeout_ms: S.num("显式超时毫秒（不填 = 跑满 " + humanDuration(autoBackgroundMs()) + " 自动转后台；最大 " + TOOL_TIMEOUT_MS * 4 + "）"),
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
    const explicitTimeout = optNum(input, "timeout_ms");
    const timeoutMs = Math.max(1000, Math.min(TOOL_TIMEOUT_MS * 4, Math.floor(explicitTimeout ?? TOOL_TIMEOUT_MS)));
    return await runForeground(command, ctx, timeoutMs, explicitTimeout === undefined ? autoBackgroundMs() : null);
  }),
});
