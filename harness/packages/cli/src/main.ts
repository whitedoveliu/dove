/**
 * CLI 入口：解析 → 分派 → 收尾
 *
 * 两条纪律：
 *   1. **绝不 import bootstrap**。内核是常驻服务（Alma 报告 §0.2 第 1 点：本体在主进程、
 *      CLI 是一等客户端），自己起一份会跟用户在跑的 App 抢端口、抢库、抢记忆。
 *   2. **一定要主动退出**。CLI 只连 HTTP，但 undici 的连接池、readline、定时器
 *      任何一个都可能把进程吊住 —— 历史同款事故见 scripts/smoke-cli-exit.mjs。
 *      所以 main() 的每一条返回路径最后都走 exitAfterFlush(code)。
 */
import { flagBool, flagNum, parseArgs, UsageError, type Args } from "./args.ts";
import { ApiError, NoKernelError, resolveTarget } from "./client.ts";
import { cmdHealth, cmdLogs, cmdStatus, cmdSteer, cmdStop, cmdUp, cmdUndo, cmdVersion } from "./admin.ts";
import { cmdAnswer, cmdApprove, cmdPending } from "./approvals.ts";
import { cmdChat } from "./chat.ts";
import { cmdGoal, cmdGoals, cmdSkills, cmdTools } from "./inspect.ts";
import { MAIN_HELP, helpFor } from "./help.ts";
import { dim, EXIT, exitAfterFlush, note, out, red, setColor } from "./out.ts";
import { cmdRun } from "./run.ts";
import { cmdThreads } from "./threads.ts";

const COMMANDS = new Set([
  "health", "status", "version", "up", "logs", "threads", "run", "chat",
  "stop", "steer", "approve", "pending", "answer", "tools", "skills", "goals", "goal", "undo", "help",
]);

export async function main(argv: string[]): Promise<void> {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      note(red("✗ ") + e.message);
      note(dim("dove --help 看用法"));
      return exitAfterFlush(EXIT.usage);
    }
    throw e;
  }

  // --help 要在**任何**网络请求之前处理：没起内核时 `dove run --help` 也该打得出用法
  if (a.cmd === "help" || (a.cmd !== "" && flagBool(a, "help"))) {
    const target = a.cmd === "help" ? a.sub : a.cmd;
    out(target ? helpFor(target) : MAIN_HELP);
    return exitAfterFlush(EXIT.ok);
  }
  if (a.cmd === "") {
    out(MAIN_HELP);
    return exitAfterFlush(EXIT.ok);
  }
  if (!COMMANDS.has(a.cmd)) {
    note(red("✗ ") + `不认识这个命令：${a.cmd}`);
    out(MAIN_HELP);
    return exitAfterFlush(EXIT.usage);
  }

  // 颜色必须在任何输出之前定死：--json 混进 ANSI 会让下游 jq 直接解析失败
  setColor(process.stdout.isTTY === true && !process.env.NO_COLOR && !flagBool(a, "no-color") && !a.flags.has("json"));

  try {
    return exitAfterFlush(await dispatch(a));
  } catch (e) {
    return handleError(e, flagBool(a, "verbose"));
  }
}

async function dispatch(a: Args): Promise<number> {
  // 这两条不依赖已存在的内核：version 要能离线答，up 的活就是把它起起来
  if (a.cmd === "version") return cmdVersion(a);
  if (a.cmd === "up") return cmdUp(a);

  const port = flagNum(a, "port");
  const t = await resolveTarget(port);

  switch (a.cmd) {
    case "health": return cmdHealth(t, a);
    case "status": return cmdStatus(t, a);
    case "logs": return cmdLogs(t, a);
    case "threads": return cmdThreads(t, a);
    case "run": return cmdRun(t, a);
    case "chat": return cmdChat(t, a);
    case "stop": return cmdStop(t, a);
    case "steer": return cmdSteer(t, a);
    case "undo": return cmdUndo(t, a);
    case "approve": return cmdApprove(t, a);
    case "pending": return cmdPending(t, a);
    case "answer": return cmdAnswer(t, a);
    case "tools": return cmdTools(t, a);
    case "skills": return cmdSkills(t, a);
    case "goals": return cmdGoals(t, a);
    case "goal": return cmdGoal(t, a);
    default: return EXIT.usage;
  }
}

/** 错误 → 退出码。区分「连不上内核」和「内核拒绝了」：这两类问题的下一步动作完全不同 */
function handleError(e: unknown, verbose: boolean): never {
  if (e instanceof NoKernelError) {
    note(red("✗ ") + e.message);
    for (const h of e.hints) note(dim("   " + h));
    return exitAfterFlush(EXIT.noKernel);
  }
  if (e instanceof ApiError) {
    note(red("✗ ") + e.message);
    if (e.status === 0) return exitAfterFlush(EXIT.noKernel);
    return exitAfterFlush(EXIT.api);
  }
  if (e instanceof UsageError) {
    note(red("✗ ") + e.message);
    return exitAfterFlush(EXIT.usage);
  }
  const msg = e instanceof Error ? e.message : String(e);
  note(red("✗ ") + msg);
  if (verbose && e instanceof Error && e.stack) note(dim(e.stack));
  return exitAfterFlush(EXIT.fail);
}
