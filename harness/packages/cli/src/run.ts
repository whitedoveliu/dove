/**
 * `dove run` 与流式渲染（chat 复用同一份渲染，避免两个入口的行为慢慢跑偏）
 *
 * 中断语义是这块的核心：Ctrl+C 时**先让内核停线程**，再收掉自己这条连接。
 * 顺序反了（先掐连接）会有两个后果：内核那边要等它自己的 abort 看门狗收尾，
 * 用户看到的是「我按了 Ctrl+C，但内核还在跑」。
 * 所以：SIGINT → POST /api/stop → 连接收掉 → 退出码 130。
 * 兜底：4 秒还没收利索就强退，不能因为内核不吭声把终端卡死。
 */
import { flagBool, flagStr, freeText, type Args } from "./args.ts";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { api, openSse, type Target } from "./client.ts";
import { decideApproval } from "./approvals.ts";
import { dim, cyan, green, red, yellow, EXIT, exitAfterFlush, humanMs, oneLine, out, raw, note } from "./out.ts";
import { readSse, type SseEvent } from "./sse.ts";
import { rememberQuestion } from "./state.ts";
import { resolveThread, NoThreadError } from "./threads.ts";

export interface TurnOptions {
  target: Target;
  threadId: string;
  message: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  /**
   * 审批就地在当前终端里问（只有 TTY 才允许 —— 非 TTY 问会卡住脚本和 CI）。
   * 不给「另一个终端」的提示时，用户就得自己想到开第二个终端，否则只能等 5 分钟超时被拒。
   */
  inline?: boolean;
  /** 外部中断信号（chat 用它把 SIGINT 转成“停这一回合”而不是退进程） */
  interrupt?: AbortSignal;
  /** 每条事件都回调一次（chat 需要知道有没有产生产出） */
  onEvent?: (e: SseEvent) => void;
}

export interface TurnResult {
  sawDone: boolean;
  sawError: boolean;
  aborted: boolean;
  silent: boolean;
  errorText?: string;
  /** 本轮结束原因（done 事件带的 endReason，或 interrupted 带的） */
  endReason?: string;
  text: string;
}

/** 渲染一条事件（json 模式由调用方负责原样吐出，这里只管人看的形态） */
function render(e: SseEvent, o: TurnOptions): void {
  const quiet = o.quiet === true;
  switch (e.type) {
    case "text":
      raw(String(e.content ?? ""));
      return;
    case "reasoning":
      if (o.verbose) raw(dim(String(e.content ?? "")));
      return;
    case "tool_start":
      if (!quiet) note("\n" + cyan("⚙ " + String(e.tool ?? "?")) + " " + dim(oneLine(JSON.stringify(e.input ?? {}), 160)));
      return;
    case "tool_result": {
      if (quiet) return;
      const ok = e.ok !== false;
      const mark = ok ? green("✓") : red("✗");
      const extra = ok ? "" : " " + red(oneLine(String(e.error ?? ""), 160));
      note(`  ${mark} ${String(e.tool ?? "?")}${extra} ${dim(humanMs(Number(e.durationMs ?? 0)))}`);
      return;
    }
    case "tool_approval": {
      const id = String(e.toolCallId ?? "");
      const title = String(e.title ?? "允许执行？");
      note("\n" + yellow("⏸ 需要审批") + "：" + title + "  " + dim(`[${String(e.riskLevel ?? "?")}]`));
      if (o.inline && id) void askInline(o, id, title);
      else note(dim("   另开一个终端跑：dove approve（或 dove approve --allow）"));
      return;
    }
    case "tool:ask_user": {
      const qs = Array.isArray(e.questions) ? (e.questions as Record<string, unknown>[]) : [];
      const first = qs[0] ?? {};
      const id = String(e.toolCallId ?? "");
      note("\n" + yellow("？提问") + "：" + String(first.question ?? first.header ?? ""));
      note(dim(`   回答：dove answer --id ${id} "你的回答"`));
      rememberQuestion(o.target.port, { questionId: id, brief: oneLine(String(first.question ?? ""), 80), ts: Date.now() });
      return;
    }
    case "interrupted":
      if (e.aborted) note("\n" + yellow("⏸ 这一轮被中断了"));
      return;
    case "error":
      note("\n" + red("✗ " + String(e.content ?? e.message ?? "未知错误")));
      return;
    case "stats": {
      if (quiet) return;
      const u = (e.usage ?? {}) as Record<string, unknown>;
      note("\n" + dim(
        `━━ ${String(e.steps ?? "?")} 步 · ${humanMs(Number(e.durationMs ?? 0))}` +
        ` · cache ${Number(u.cacheReadTokens ?? 0)}/${Number(u.inputTokens ?? 0)}`,
      ));
      return;
    }
    case "done":
    case "turn_start":
    case "step_start":
      return;
    default:
      // 内核会陆续加事件类型（policy / repair / task_injected …）。不认识的默认静默，
      // 只有 --verbose 才打出来 —— CLI 的输出是给人看答案的，不是事件转储。
      if (o.verbose) note(dim(`· ${e.type} ${oneLine(JSON.stringify(e), 120)}`));
      return;
  }
}

/**
 * 一行回答 → 决定。抽成纯函数是为了能测：pTY 里的按键时序不适合放进 CI 冒烟，
 * 但「哪些输入算同意」必须可断言（误判一次就是一条命令被悄悄放行）。
 */
export function parseApprovalAnswer(line: string): "allow" | "deny" {
  return /^(y|yes|allow|1|是|好|允许|同意)$/i.test(line.trim()) ? "allow" : "deny";
}

/** 当前正在等的交互提示。一轮结束时必须收掉：stdin 吊着 = 进程退不出去（见 smoke-cli-exit.mjs） */
let activePrompt: ReadlineInterface | null = null;

function closePrompt(): void {
  if (!activePrompt) return;
  activePrompt.close();
  activePrompt = null;
}

/**
 * 就地审批：在当前终端问 y/N，再投 /api/approve。
 *
 * 为什么必须补这一条：原来只打印「另开一个终端跑 dove approve」——
 * 用户盯着这个流式输出时不会想到要开第二个终端，于是审批干等到
 * DOVE_APPROVAL_TIMEOUT_MS（5 分钟）被自动拒绝，模型看到的是
 * 「用户拒绝了这次操作」，表现成「工具莫名失败」。实测踩过。
 * 只有 TTY 才问；非 TTY / --json 仍然只给提示（脚本和 CI 不许被交互卡住）。
 */
async function askInline(o: TurnOptions, id: string, title: string): Promise<void> {
  if (activePrompt) return;                        // 一次只问一个：后面的审批排在它后面
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  activePrompt = rl;
  let ok = false;
  try {
    const ans = await new Promise<string>((resolve) => rl.question(yellow("   允许？") + dim(" (y/N) "), resolve));
    const verdict = parseApprovalAnswer(ans);
    ok = await decideApproval(o.target, id, verdict === "allow").catch(() => false);
    if (verdict === "deny") note(dim("✗ 已拒绝 —— 模型会收到「用户拒绝了这次操作」"));
    else if (ok) note(dim("✓ 已允许"));
    else note(red("✗ 放行失败") + dim("：这条审批已经不在等待表里了（超时或已被处理）"));
  } catch {
    // 问不出来（stdin 关了 / 终端异常）不是错误：回到「另开终端」那条路
    note(dim("   问不到回答，改在别的终端跑：dove approve --allow"));
  } finally {
    closePrompt();
  }
  void title;
}

/** 跑一轮：POST /api/chat 并把 SSE 事件流出来。返回结构化结局，退出码由调用方定 */
export async function streamTurn(o: TurnOptions): Promise<TurnResult> {
  const r: TurnResult = { sawDone: false, sawError: false, aborted: false, silent: false, text: "" };
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  o.interrupt?.addEventListener("abort", onAbort, { once: true });
  if (o.interrupt?.aborted) ac.abort();

  try {
    const res = await openSse(o.target, "/api/chat", { threadId: o.threadId, message: o.message }, ac.signal);
    let streamed = false;
    for await (const e of readSse(res)) {
      o.onEvent?.(e);
      if (o.json) out(JSON.stringify(e));
      else render(e, o);
      if (e.type === "text") { r.text += String(e.content ?? ""); streamed = true; }
      if (e.type === "interrupted") { r.aborted = Boolean(e.aborted); r.silent = true; r.endReason = String(e.endReason ?? ""); }
      if (e.type === "error") { r.sawError = true; r.errorText = String(e.content ?? e.message ?? "未知错误"); }
      if (e.type === "done") {
        r.sawDone = true;
        if (e.endReason) r.endReason = String(e.endReason);
        break;
      }
    }
    if (!o.json && streamed && !r.text.endsWith("\n")) note("");
    return r;
  } catch (e) {
    // 自己掐的连接（SIGINT / chat 的 /stop）：不是错误，是一次「被中断的回合」
    if (ac.signal.aborted && !r.sawDone) { r.aborted = true; return r; }
    throw e;
  } finally {
    closePrompt();
    o.interrupt?.removeEventListener("abort", onAbort);
  }
}

/**
 * 这一轮的退出码。
 *   内核报错 / 流断了 / 被中断 -> 非 0；只有真拿到 done 才算成功。
 *   中断固定用 130（和 shell 里 Ctrl+C 的惯例一致），脚本据此区分「我按的」和「它挂了」。
 */
export function turnCode(r: TurnResult, userAborted: boolean): number {
  if (userAborted) return EXIT.interrupted;
  if (r.sawError) return EXIT.fail;
  if (!r.sawDone) return EXIT.fail;
  if (r.aborted) return EXIT.interrupted;
  return EXIT.ok;
}

/**
 * 把 SIGINT 接成「停线程」。
 * 连按两次 / 4 秒兜底 -> 直接退，别让用户觉得终端卡死了。
 */
function armInterrupt(onStop: () => Promise<unknown>, abort: () => void, onFirst: () => void): () => void {
  let fired = false;
  const handler = (): void => {
    if (fired) exitAfterFlush(EXIT.interrupted);
    fired = true;
    onFirst();
    void Promise.resolve(onStop()).catch(() => { /* 停不掉也得退 */ }).then(() => abort());
    setTimeout(() => exitAfterFlush(EXIT.interrupted), 4_000).unref?.();
  };
  process.on("SIGINT", handler);
  return () => process.removeListener("SIGINT", handler);
}

/**
 * 就地审批只在「人在终端前」时才允许：非 TTY（管道 / CI / 定时任务）问了没人答，
 * 反而会把调用方卡到审批超时；--json 更不能问（stdout 必须是一行一个 JSON）。
 */
export function inlineAllowed(a: Args): boolean {
  if (flagBool(a, "no-inline-approve")) return false;
  if (a.flags.has("json")) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function cmdRun(t: Target, a: Args): Promise<number> {
  const message = flagStr(a, "text") ?? freeText(a);
  if (!message) {
    note("用法：dove run [--thread <id> | --new | --home] \"消息\"");
    return EXIT.usage;
  }

  let threadId: string;
  let created = false;
  try {
    const th = await resolveThread(t, a, message.slice(0, 24));
    threadId = th.id;
    created = flagBool(a, "new");
  } catch (e) {
    if (e instanceof NoThreadError) {
      note(red("✗ ") + e.message);
      for (const h of e.hints) note(dim("   " + h));
      return EXIT.fail;
    }
    throw e;
  }

  if (a.flags.has("json")) {
    // json 模式必须一行一个 JSON —— 建线程这件事也得让脚本看得见
    out(JSON.stringify({ type: "thread", threadId, created }));
  } else if (!flagBool(a, "quiet")) {
    note(dim(`→ ${threadId}`));
  }

  const ac = new AbortController();
  let userAborted = false;
  const disarm = armInterrupt(
    () => api(t, "/api/stop", { body: { threadId }, timeoutMs: 3_000 }),
    () => ac.abort(),
    () => { userAborted = true; note("\n" + dim("正在停止这一轮…")); },
  );

  let result: TurnResult;
  try {
    result = await streamTurn({
      target: t, threadId, message,
      json: a.flags.has("json"), quiet: flagBool(a, "quiet"), verbose: flagBool(a, "verbose"),
      inline: inlineAllowed(a),
      interrupt: ac.signal,
    });
  } finally {
    disarm();
  }

  if (userAborted) {
    await api(t, "/api/stop", { body: { threadId }, timeoutMs: 3_000 }).catch(() => { /* ignore */ });
    note(dim("已停止"));
  }
  if (result.sawError) note(red("✗ ") + (result.errorText ?? "回合失败"));
  if (!result.sawDone && !userAborted) note(red("✗ ") + "连接在 done 之前就断了（内核可能崩了，看 dove logs）");
  return turnCode(result, userAborted);
}
