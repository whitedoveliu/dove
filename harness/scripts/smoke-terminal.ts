/**
 * 持久终端自测（TerminalOpen / TerminalSend / TerminalRead / TerminalClose / TerminalList）
 * 运行：cd harness && node --no-warnings scripts/smoke-terminal.ts
 *
 * 全真跑：真起 shell、真 cd、真 export、真杀进程组、真看进程还在不在（process.kill(pid,0)）。
 * 覆盖：状态保持（cd / export）· 三种 wait_reason（prompt/timeout/exit）· 一次一个 send
 *      · 行分页 · ANSI 剥离 · 线程隔离 · 结构化错误（绝不抛）· 关完进程真的没了（ESRCH）
 *      · 强制管道模式（DOVE_TERMINAL_NO_PTY=1）
 * 环境能力缺失（比如没有 /bin/bash）按「如实降级」跳过；有能力却做错一定 exit 1。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "../packages/core/src/tools/types.ts";
import { TerminalOpenTool } from "../packages/core/src/tools/builtin/terminal-open.ts";
import { TerminalSendTool } from "../packages/core/src/tools/builtin/terminal-send.ts";
import { TerminalReadTool } from "../packages/core/src/tools/builtin/terminal-read.ts";
import { TerminalCloseTool } from "../packages/core/src/tools/builtin/terminal-close.ts";
import { TerminalListTool } from "../packages/core/src/tools/builtin/terminal-list.ts";
import { closeAllSessions, groupAlive } from "../packages/core/src/tools/builtin/terminal-session.ts";
import { executeOne } from "../packages/core/src/loop/tool-exec.ts";
import type { ToolCallPayload } from "../packages/core/src/providers/types.ts";

const THREAD = "smoke-thread";
let passed = 0, failed = 0, degraded = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};
const skip = (name: string, why: string): void => { degraded++; console.log("  ⚠️  跳过 " + name + " — " + why); };
const section = (t: string): void => { console.log("\n=== " + t + " ==="); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ctxOf(threadId = THREAD): ToolContext {
  return {
    toolCallId: "smoke", threadId, workdir: process.cwd(), outputsDir: tmpdir(),
    emit: () => {}, requestApproval: async () => ({ approved: true }), services: {},
  } as unknown as ToolContext;
}
const run = (tool: Tool, args: Record<string, unknown>, threadId = THREAD): Promise<Record<string, unknown>> =>
  tool.execute(args, ctxOf(threadId)) as Promise<Record<string, unknown>>;
const S = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
/** 真看系统状态：进程还在吗（ESRCH 才算真没了） */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
async function waitDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await sleep(50);
  return !alive(pid);
}

const workdir = mkdtempSync(join(tmpdir(), "dove-term-smoke-"));
let mainId = ""; let mainPid = 0; let exitId = ""; let exitPid = 0; let pipeId = ""; let pipePid = 0;

try {
  // ── 1. open ─────────────────────────────────────────
  section("1. TerminalOpen：真的起了一个 shell");
  const open = await run(TerminalOpenTool, { cwd: workdir, name: "主会话" });
  mainId = S(open.session_id); mainPid = Number(open.pid);
  check("返回 session_id", mainId.startsWith("term_"), mainId);
  check("返回 pid 且进程真的活着", mainPid > 0 && alive(mainPid), "pid=" + mainPid);
  check("cwd 是请求的目录", S(open.cwd) === workdir, S(open.cwd));
  check("note 说明了是 PTY 还是管道", S(open.note).length > 0, S(open.note));
  console.log("     shell=" + S(open.shell) + " pty=" + S(open.pty));
  if (S(open.note).includes("PTY 起不来")) {
    skip("PTY 模式", "本机不可用（" + S(open.note).slice(0, 90) + "）");
  }

  // ── 2. 基本命令 ──────────────────────────────────────
  section("2. TerminalSend：命令跑完能拿到输出（wait_reason=prompt）");
  const pwd1 = await run(TerminalSendTool, { session_id: mainId, command: "pwd" });
  check("pwd 的 wait_reason=prompt", S(pwd1.wait_reason) === "prompt", S(pwd1.wait_reason));
  check("pwd 回的就是起始 cwd", S(pwd1.output).includes(workdir), JSON.stringify(S(pwd1.output)));
  check("session_status=ready", S(pwd1.session_status) === "ready", S(pwd1.session_status));

  // ── 3. 状态保持：cd ──────────────────────────────────
  section("3. 状态保持①：cd /tmp 之后 pwd 必须是 /tmp（同一个 shell）");
  const cd = await run(TerminalSendTool, { session_id: mainId, command: "cd /tmp" });
  check("cd 成功返回", S(cd.wait_reason) === "prompt", S(cd.wait_reason));
  const pwd2 = await run(TerminalSendTool, { session_id: mainId, command: "pwd" });
  check("pwd 现在等于 /tmp", S(pwd2.output).trim() === "/tmp", JSON.stringify(S(pwd2.output)));
  const list1 = await run(TerminalListTool, {});
  const row = (list1.sessions as Record<string, unknown>[])[0] ?? {};
  check("TerminalList 里的 cwd 跟着 cd 走了", S(row.cwd) === "/tmp", S(row.cwd));

  // ── 4. 状态保持：export ──────────────────────────────
  section("4. 状态保持②：export DOVE_T=42 之后 echo $DOVE_T 必须是 42");
  await run(TerminalSendTool, { session_id: mainId, command: "export DOVE_T=42" });
  const echo = await run(TerminalSendTool, { session_id: mainId, command: "echo $DOVE_T" });
  check("echo $DOVE_T = 42", S(echo.output).trim() === "42", JSON.stringify(S(echo.output)));

  // ── 5. ANSI 剥离 ─────────────────────────────────────
  section("5. 输出剥 ANSI（彩色输出不该把转义码带回来）");
  const color = await run(TerminalSendTool, { session_id: mainId, command: "printf '\\033[31mRED\\033[0m\\n'" });
  check("彩色输出只剩纯文本", S(color.output).trim() === "RED", JSON.stringify(S(color.output)));

  // ── 6. read / 分页 ───────────────────────────────────
  section("6. TerminalRead：回看历史 + 按行分页（offset 从最新往回数）");
  const readAll = await run(TerminalReadTool, { session_id: mainId, lines: 200, offset: 0 });
  const text = S(readAll.text);
  check("历史里有 cd 之后的 pwd 结果（/tmp）", text.includes("/tmp"));
  check("历史里有 export 的 42", text.split("\n").some((l) => l.trim() === "42"));
  check("total_lines > 0", Number(readAll.total_lines) > 0, "total=" + S(readAll.total_lines));
  check("truncated=false（没超上限）", readAll.truncated === false, S(readAll.truncated));
  const lastTwo = await run(TerminalReadTool, { session_id: mainId, lines: 2, offset: 0 });
  const allLines = text.split("\n");
  check("lines=2 只回 2 行", Number(lastTwo.returned) === 2, "returned=" + S(lastTwo.returned));
  check("lines=2 回的正是最后两行", S(lastTwo.text) === allLines.slice(-2).join("\n"), JSON.stringify(S(lastTwo.text)));
  const skipped = await run(TerminalReadTool, { session_id: mainId, lines: 2, offset: 2 });
  check("offset=2 往前挪两行", S(skipped.text) === allLines.slice(-4, -2).join("\n"), JSON.stringify(S(skipped.text)));

  // ── 7. 一次一个 send ─────────────────────────────────
  section("7. 一次一个 send：在飞命令没回来时再发必须被拒（结构化错误）");
  const inflight = run(TerminalSendTool, { session_id: mainId, command: "sleep 2; echo SLEPT", wait_ms: 30_000 });
  await sleep(400);
  const overlapped = await run(TerminalSendTool, { session_id: mainId, command: "echo SHOULD_NOT_RUN" });
  check("并发 send 被拒（有 error）", typeof overlapped.error === "string" && S(overlapped.error).length > 0, S(overlapped.error).slice(0, 60));
  check("并发 send 标了 session_status=busy", S(overlapped.session_status) === "busy", S(overlapped.session_status));
  const slept = await inflight;
  check("在飞的那条最终还是跑完了", S(slept.wait_reason) === "prompt" && S(slept.output).includes("SLEPT"), S(slept.wait_reason) + " " + JSON.stringify(S(slept.output)));
  check("被拒的那条**没有**偷偷执行", !S(readAll.text).includes("SHOULD_NOT_RUN") && !(await run(TerminalReadTool, { session_id: mainId, lines: 50 })).text?.toString().includes("SHOULD_NOT_RUN"));

  // ── 8. 超时 ──────────────────────────────────────────
  section("8. wait_reason=timeout：等不到提示符就如实说，并继续占着在飞位");
  const slow = await run(TerminalSendTool, { session_id: mainId, command: "sleep 2; echo LATE", wait_ms: 300 });
  check("超时返回 wait_reason=timeout", S(slow.wait_reason) === "timeout", S(slow.wait_reason));
  check("超时后 session_status=busy", S(slow.session_status) === "busy", S(slow.session_status));
  const during = await run(TerminalSendTool, { session_id: mainId, command: "echo NOPE" });
  check("超时期间再 send 仍被拒（不交错）", typeof during.error === "string", S(during.error).slice(0, 50));
  await sleep(2200);
  const after = await run(TerminalSendTool, { session_id: mainId, command: "echo AFTER_LATE" });
  check("命令真跑完后又能发了", S(after.wait_reason) === "prompt" && S(after.output).includes("AFTER_LATE"), S(after.wait_reason));
  const late = await run(TerminalReadTool, { session_id: mainId, lines: 80 });
  check("迟到的那条命令的输出也进了缓冲", S(late.text).includes("LATE"), "");

  // ── 9. submit=false ─────────────────────────────────
  section("9. submit=false：只写文本不回车");
  const partial = await run(TerminalSendTool, { session_id: mainId, command: "echo PARTIAL_MARK", submit: false, wait_ms: 1000 });
  check("submit=false 不会真的执行命令", !S(partial.output).includes("PARTIAL_MARK") && S(partial.note).includes("submit=false"), S(partial.note).slice(0, 60));
  const completed = await run(TerminalSendTool, { session_id: mainId, command: "", submit: true, wait_ms: 5000 });
  check("补一个空回车把它提交掉，输出出现", S(completed.output).includes("PARTIAL_MARK") || S(completed.wait_reason) === "prompt", JSON.stringify(S(completed.output)));

  // ── 10. exit 原因 ────────────────────────────────────
  section("10. wait_reason=exit：shell 退出要能判别出来");
  const open2 = await run(TerminalOpenTool, { cwd: workdir, name: "退出会话" });
  exitId = S(open2.session_id); exitPid = Number(open2.pid);
  const bye = await run(TerminalSendTool, { session_id: exitId, command: "exit" });
  check("exit 返回 wait_reason=exit", S(bye.wait_reason) === "exit", S(bye.wait_reason));
  check("session_status=exited", S(bye.session_status) === "exited", S(bye.session_status));
  await waitDead(exitPid, 3000);
  check("退出后进程真的没了", !alive(exitPid), "pid=" + exitPid);
  const sendDead = await run(TerminalSendTool, { session_id: exitId, command: "echo X" });
  check("往已退出的会话发命令 → 结构化错误", typeof sendDead.error === "string" && S(sendDead.session_status) === "exited", S(sendDead.error).slice(0, 50));
  const closeDead = await run(TerminalCloseTool, { session_id: exitId });
  check("已退出的会话也能正常回收（closed=true）", closeDead.closed === true, S(closeDead.note));
  exitId = "";

  // ── 11. 结构化错误 + 线程隔离 ─────────────────────────
  section("11. 错误一律结构化，绝不抛；会话按线程隔离");
  const badSend = await run(TerminalSendTool, { session_id: "term_nope", command: "echo hi" });
  check("send 未知会话 → error", typeof badSend.error === "string", S(badSend.error).slice(0, 40));
  const badRead = await run(TerminalReadTool, { session_id: "term_nope" });
  check("read 未知会话 → error", typeof badRead.error === "string", S(badRead.error).slice(0, 40));
  const badClose = await run(TerminalCloseTool, { session_id: "term_nope" });
  check("close 未知会话 → error 且 closed=false", typeof badClose.error === "string" && badClose.closed === false, S(badClose.error).slice(0, 40));
  const crossSend = await run(TerminalSendTool, { session_id: mainId, command: "echo hi" }, "别的线程");
  check("跨线程 send 被拒", S(crossSend.error).includes("线程"), S(crossSend.error).slice(0, 40));
  const crossClose = await run(TerminalCloseTool, { session_id: mainId }, "别的线程");
  check("跨线程 close 被拒（不能杀别人的会话）", S(crossClose.error).includes("线程"), S(crossClose.error).slice(0, 40));
  const crossList = await run(TerminalListTool, {}, "别的线程");
  check("跨线程 list 看不见这些会话", (crossList.sessions as unknown[]).length === 0, JSON.stringify(crossList.sessions));
  check("本线程 list 看得见", (list1.sessions as unknown[]).length >= 1, JSON.stringify((list1.sessions as Record<string, unknown>[]).map((x) => x.name)));

  // ── 11.5 滚动缓冲：丢头保尾 + sticky truncated（真打 2100 行） ──
  section("11.5 滚动缓冲：超上限丢头保尾，并置 sticky truncated");
  const big = await run(TerminalSendTool, { session_id: mainId, command: "seq 1 2100 | sed 's/^/L/'", wait_ms: 20_000 });
  check("2100 行的命令跑完", S(big.wait_reason) === "prompt", S(big.wait_reason));
  check("发送结果就标了 truncated=true", big.truncated === true, S(big.truncated));
  const bigRead = await run(TerminalReadTool, { session_id: mainId, lines: 2000 });
  check("缓冲最多留 2000 行", Number(bigRead.total_lines) <= 2000, "total=" + S(bigRead.total_lines));
  check("丢头保尾：最后一行是 L2100", S(bigRead.text).trimEnd().endsWith("L2100"), JSON.stringify(S(bigRead.text).slice(-24)));
  check("read 也报 truncated=true", bigRead.truncated === true);
  check("dropped_lines > 0", Number(bigRead.dropped_lines) > 0, "dropped=" + S(bigRead.dropped_lines));

  // ── 12. close：进程组真的没了 ────────────────────────
  section("12. TerminalClose：等到进程真的消失才返回（ESRCH）");
  const closed = await run(TerminalCloseTool, { session_id: mainId });
  check("close 返回 closed=true", closed.closed === true, S(closed.note));
  check("close 之后 pid 立刻就是 ESRCH", !alive(mainPid), "pid=" + mainPid);
  check("close 之后整个进程组没有活口（无孤儿）", !groupAlive(mainPid), "pgid=" + mainPid);
  const listAfter = await run(TerminalListTool, {});
  check("close 之后 list 里没有它了", !(listAfter.sessions as Record<string, unknown>[]).some((x) => S(x.session_id) === mainId));
  const closedAgain = await run(TerminalCloseTool, { session_id: mainId });
  check("重复 close 是结构化错误（不是崩溃）", typeof closedAgain.error === "string", S(closedAgain.error).slice(0, 40));

  // ── 13. 强制管道模式 ─────────────────────────────────
  section("13. DOVE_TERMINAL_NO_PTY=1：强制纯管道模式也要能干活");
  process.env.DOVE_TERMINAL_NO_PTY = "1";
  try {
    const open3 = await run(TerminalOpenTool, { cwd: tmpdir(), name: "管道会话" });
    pipeId = S(open3.session_id); pipePid = Number(open3.pid);
    check("强制管道模式起来了", pipeId.startsWith("term_") && alive(pipePid), "pid=" + pipePid);
    check("note 如实说明是强制管道", S(open3.note).includes("DOVE_TERMINAL_NO_PTY"), S(open3.note).slice(0, 60));
    check("pty 字段=false", open3.pty === false, S(open3.pty));
    await run(TerminalSendTool, { session_id: pipeId, command: "cd /tmp" });
    const p3 = await run(TerminalSendTool, { session_id: pipeId, command: "pwd" });
    check("管道模式同样保持状态（cd 后 pwd=/tmp）", S(p3.output).trim() === "/tmp", JSON.stringify(S(p3.output)));
    const c3 = await run(TerminalCloseTool, { session_id: pipeId });
    check("管道会话关干净", c3.closed === true && !alive(pipePid), S(c3.note));
    pipeId = "";
  } finally {
    delete process.env.DOVE_TERMINAL_NO_PTY;
  }
  // ── 14. 审批闸门：为 TerminalSend 打开（字段名必须叫 command） ──
  // 为什么这条必须真测：loop/tool-exec.ts 的启发式**只读 args.command / args.cmd**，
  // 字段名取错 = 这个工具永远不触发审批（这个项目为此栽过）。这里走真实执行管线验一遍。
  section("14. 审批闸门：TerminalSend 的危险命令真的会被拦（走 executeOne 真实管线）");
  const gate = await run(TerminalOpenTool, { cwd: workdir, name: "审批会话" });
  const gateId = S(gate.session_id);
  let asked = 0, askedMsg = "";
  const canary = join(workdir, "canary-不要删.txt");
  writeFileSync(canary, "still here");
  const call = {
    id: "smoke-call-1", type: "function",
    function: { name: "TerminalSend", arguments: JSON.stringify({ session_id: gateId, command: "rm -f " + canary }) },
  } as unknown as ToolCallPayload;
  const outcome = await executeOne(call, {
    tools: new Map([["TerminalSend", TerminalSendTool]]),
    ctxBase: { threadId: THREAD, workdir: process.cwd(), outputsDir: tmpdir(), emit: () => {}, services: {} },
    resolveApproval: async (req) => { asked++; askedMsg = req.message; return { approved: false, reason: "user" }; },
  } as never);
  check("危险命令触发了审批（弹窗被问了 1 次）", asked === 1, "asked=" + asked);
  check("审批请求里带的就是那条命令", askedMsg.includes("rm -f " + canary), askedMsg.slice(0, 60));
  check("用户拒绝后工具被拦下（ok=false / denied=true）", outcome.ok === false && outcome.denied === true, "ok=" + outcome.ok + " denied=" + S(outcome.denied));
  check("金丝雀文件还在（命令真的没执行）", existsSync(canary), canary);
  // 只读命令不该弹窗（否则模型每跑一条 pwd 都要点一次）
  asked = 0;
  const pwdCall = {
    id: "smoke-call-2", type: "function",
    function: { name: "TerminalSend", arguments: JSON.stringify({ session_id: gateId, command: "pwd" }) },
  } as unknown as ToolCallPayload;
  const pwdOutcome = await executeOne(pwdCall, {
    tools: new Map([["TerminalSend", TerminalSendTool]]),
    ctxBase: { threadId: THREAD, workdir: process.cwd(), outputsDir: tmpdir(), emit: () => {}, services: {} },
    resolveApproval: async () => { asked++; return { approved: false, reason: "user" }; },
  } as never);
  check("pwd 这种只读命令不弹窗（asked=0）", asked === 0 && pwdOutcome.ok === true, "asked=" + asked);
  check("pwd 真的执行了（走完真实管线）", S((pwdOutcome.output as Record<string, unknown>)?.output).includes(workdir));
  await run(TerminalCloseTool, { session_id: gateId });
  check("审批会话已关干净", !alive(Number(gate.pid)), "pid=" + S(gate.pid));

  // ── 15. 注册表接线（registry.ts 是别人维护的文件，这里只读着验） ──
  section("15. 注册表接线：工具真的在目录里、审批档位对、字段名对");
  const reg = await import("../packages/core/src/tools/registry.ts");
  const names = ["TerminalOpen", "TerminalSend", "TerminalRead", "TerminalClose", "TerminalList"];
  const missing = names.filter((n) => !reg.getTool(n));
  check("五个工具都在工具目录里", missing.length === 0, missing.join(",") || "全在");
  check("TerminalSend.approval=heuristic", reg.getTool("TerminalSend")?.approval === "heuristic", S(reg.getTool("TerminalSend")?.approval));
  check("其余四个 approval=never", ["TerminalOpen", "TerminalRead", "TerminalClose", "TerminalList"].every((n) => reg.getTool(n)?.approval === "never"));
  const schema = reg.getTool("TerminalSend")?.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  check("TerminalSend 的参数名是 command 且在 required 里", !!schema?.properties?.command && !!schema?.required?.includes("command"));
  check("都写了 discoverable（core.test 对按需工具的硬要求）", names.every((n) => !!reg.getTool(n)?.discoverable));
  check("ToolSearch 搜「终端」能搜到它们", reg.searchTools("终端").some((t) => t.name.startsWith("Terminal")));
  reg.deactivateAll();   // activateTools 是幂等的：不清空的话第二次调用会返回空数组（第一次调用已经激活过）
  const activatedNow = reg.activateTools(["TerminalSend"]);
  check("激活 TerminalSend 会带上 open/read/close/list", ["TerminalOpen", "TerminalRead", "TerminalClose", "TerminalList"].every((n) => activatedNow.includes(n)), activatedNow.join(","));
  reg.deactivateAll();

  // ── 16. 空闲自动回收（把 30 分钟阈值缩短到 700ms 真验一遍） ──
  section("16. 空闲自动回收：阈值可缩短，回收必须真杀进程");
  process.env.DOVE_TERMINAL_IDLE_MS = "700";
  try {
    const openIdle = await run(TerminalOpenTool, { cwd: tmpdir(), name: "空闲会话" });
    const idlePid = Number(openIdle.pid);
    check("空闲会话先起来了", alive(idlePid), "pid=" + idlePid);
    await sleep(2600);
    check("超时后被自动关掉（进程真没了）", !alive(idlePid), "pid=" + idlePid);
    check("进程组也没活口", !groupAlive(idlePid));
    const listIdle = await run(TerminalListTool, {});
    check("注册表里也清掉了", !(listIdle.sessions as Record<string, unknown>[]).some((x) => S(x.session_id) === S(openIdle.session_id)));
  } finally {
    delete process.env.DOVE_TERMINAL_IDLE_MS;
  }
} catch (e) {
  failed++;
  console.log("  ❌ 冒烟脚本自己抛了（这就是 bug）：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  // 兜底收尾：绝不能因为断言失败就留下孤儿进程
  const n = await closeAllSessions();
  if (n > 0) console.log("\n（收尾：额外关掉了 " + n + " 个残留会话）");
  rmSync(workdir, { recursive: true, force: true });
}

section("结果");
console.log("  通过 " + passed + " / 失败 " + failed + " / 降级跳过 " + degraded);
console.log(failed === 0 ? "✅ 持久终端全部通过" : "❌ 有失败项，见上面");
process.exit(failed === 0 ? 0 : 1);
