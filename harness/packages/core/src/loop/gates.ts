/**
 * 闸门（T1.3；答疑 P2-12 第 4 条）
 * ① 四道回合闸门：顺序 = 优先级：人（steering） > 自救（完成守卫/权限续跑） > 补跑（自动续跑）
 *    纪律：②③④ **互斥**，不能同时开火，否则「双恢复打架」或「无限续跑」。
 *          三个计数器按回合重置。
 * ② 工具调用前的护栏预判（planToolCalls）：hook veto + 重复断路器。放在同一个文件是因为
 *    它们是同一件事的两种粒度 —— 「跑不跑 / 还要不要继续跑」的决策，纯决策、不碰 wire。
 */
import type { ChatMessage, ToolCallPayload } from "../providers/types.ts";
import type { ExecOutcome } from "./tool-exec.ts";
import type { HookRegistry } from "./hooks.ts";
import type { RepeatBreaker } from "./repeat-breaker.ts";
import { MAX_AUTO_CONTINUE, COMPLETION_GUARD_RETRIES, PERMISSION_CONTINUE_RETRIES } from "../constants.ts";

export type GateId = "steering" | "completion-guard" | "permission-continue" | "auto-continue";

export interface GateCounters {
  autoContinue: number;
  completionGuard: number;
  permissionContinue: number;
}

export function newCounters(): GateCounters {
  return { autoContinue: 0, completionGuard: 0, permissionContinue: 0 };
}

export interface GateInput {
  /** 用户插话队列非空 */
  steerPending: boolean;
  /** 这一 pass 是否调用了 AttemptCompletion */
  sawAttemptCompletion: boolean;
  /** 这一 pass 是否有工具被权限拒绝 */
  sawPermissionDenied: boolean;
  /** 流结束原因 */
  finishReason: string;
  /** 模型给出的工具调用数 */
  toolCallCount: number;
  /** 实际拿到结果的工具数 */
  toolResultCount: number;
  /** 整轮是否有可见输出 */
  sawVisibleOutput: boolean;
  /** 这一 pass 是否真的调用过工具（用来区分「任务」与「纯聊天」） */
  hadToolCalls: boolean;
  /** 是否被用户中止 */
  aborted: boolean;
  /**
   * 跳过完成守卫（② 心跳回合用）。
   * 心跳的契约是「没事就只回 HEARTBEAT_OK」——本来就没有"完成任务"这回事。
   * 守卫在这里只会强行再开一轮，于是模型把 OK 又说一遍、或补一句"自检完成"，
   * 结果是**明明没事却打扰用户**（实测复现：输出 "HEARTBEAT_OK心跳自检完成，没有需要打扰你的事。"）。
   */
  skipCompletionGuard?: boolean;
}

export interface GateDecision {
  gate: GateId | null;
  /** 追加到 messages 的系统提醒（续跑用） */
  reminder?: string;
  /** 是否把 steering 折叠进 messages */
  foldSteering?: boolean;
}

/**
 * 数一条消息序列里的 tool_call / tool 结果条数 —— evaluateGates 的入参就是这两个数，所以与判据同源
 * （少一条配对 = 铁律一破了，闸门④据此补跑）。为什么住在这里：loop/turn.ts 的行数上限已满，
 * 而这里本来就是它唯一的消费者。
 */
export function countToolPairs(messages: ChatMessage[]): { calls: number; results: number } {
  let calls = 0, results = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) calls += m.tool_calls.length;
    if (m.role === "tool") results++;
  }
  return { calls, results };
}

/**
 * 返回第一个命中的闸门。全不中 → { gate: null }，回合结束。
 * 互斥：steering 命中时不再评估其他；completion-guard 命中时不再评估 permission/auto。
 */
export function evaluateGates(input: GateInput, c: GateCounters): GateDecision {
  // ① steering —— 用户插话，最高优先级
  if (input.steerPending) {
    return { gate: "steering", foldSteering: true };
  }

  // ② 完成守卫：干过活的回合必须明确声明完成
  //    ⚠️ 只在 hadToolCalls 时触发 —— 纯聊天回合强制声明完成毫无意义，
  //       而且会诱发模型把刚说过的话再说一遍（实测过的事故）。
  if (!input.skipCompletionGuard
      && input.hadToolCalls && !input.sawAttemptCompletion
      && input.finishReason === "stop" && input.sawVisibleOutput
      && c.completionGuard < COMPLETION_GUARD_RETRIES) {
    return {
      gate: "completion-guard",
      reminder: [
        "<system-reminder>",
        "你刚才结束了回复，但没有调用 AttemptCompletion 声明任务完成。",
        "",
        "如果任务确实做完了：**只调用一次 AttemptCompletion**（summary 写一句话即可）。",
        "**绝对不要重复、复述或改写你上一条回复的内容** —— 用户已经看到了。",
        "如果还没做完：继续做，不要调用 AttemptCompletion。",
        "</system-reminder>",
      ].join("\n"),
    };
  }

  // ③ 权限续跑：工具被拒后自动补跑
  if (input.sawPermissionDenied && c.permissionContinue < PERMISSION_CONTINUE_RETRIES) {
    return {
      gate: "permission-continue",
      reminder: "<system-reminder>刚才有一个工具调用被用户拒绝了。请不要重复请求同一个操作 —— 换一个不需要权限的方式完成用户的目标，或者直接询问用户希望怎么做。</system-reminder>",
    };
  }

  // ④ 自动续跑：流被截断 / 停在工具调用上
  const truncated = input.finishReason === "length";
  const dangling = input.toolCallCount > input.toolResultCount;
  const toolCalls = input.finishReason === "tool_calls" || input.finishReason === "tool_use";
  if ((toolCalls || truncated || dangling) && c.autoContinue < MAX_AUTO_CONTINUE) {
    return {
      gate: "auto-continue",
      reminder: truncated
        ? "<system-reminder>你上一条回复被长度限制截断了。请从断点继续，**不要重复已经说过的内容**。</system-reminder>"
        : "<system-reminder>请继续完成用户的任务。</system-reminder>",
    };
  }

  return { gate: null };
}

export function bumpCounter(c: GateCounters, gate: GateId): void {
  if (gate === "auto-continue") c.autoContinue++;
  else if (gate === "completion-guard") c.completionGuard++;
  else if (gate === "permission-continue") c.permissionContinue++;
}

// ── 工具调用前的护栏预判 ────────────────────────────────

export interface CallPlan {
  /** 与入参**同序**：被拦下的位置直接是合成结果，该真跑的位置是 undefined（由调用方执行完填回） */
  pre: (ExecOutcome | undefined)[];
  /** 该真跑的调用（有序子序列） */
  runnable: ToolCallPayload[];
  /** 要注入给模型的提醒（走既有 injection 通道，位置由调用方定 = 这一步的工具结果之后） */
  reminders: string[];
  /** 断路器第 12 档：这一轮直接结束 */
  fail: boolean;
}

/**
 * 执行前的预判：hook veto（beforeToolExecute）+ 重复断路器的分级干预。
 *
 * ⚠️ 被拦下的调用**必须**合成一条工具结果，理由有两条，缺一条就是事故：
 *    ① assistant 那条消息已经把 tool_calls 全声明了，少一条结果就是配对断裂
 *       （agent/wire-history.ts 铁律一 —— provider 直接拒绝整条请求）；
 *    ② 合成的结果要和真结果一样**走 onToolResult**（runtime 靠它把 tool part 落成
 *       output-error + errorText）。少了这一步，下一轮重建出来的是「该动作未完成，结果未知」，
 *       与实时上过 wire 的那条差一个字节 —— 前缀缓存从这一步起整段作废（铁律二）。
 *
 * 顺序：先 `note`（断路器按 (工具 + 规范化参数) 计数）→ 再问 hook。
 * 停批/终止之后**仍然要 note 剩下的调用**：模型确实又要求了它们，不数的话一批里的
 * 12 档就永远踩不到（护栏的最后一档在单批内也必须能生效）。
 */
export async function planToolCalls(o: {
  calls: ToolCallPayload[];
  breaker: RepeatBreaker;
  hookRegistry?: HookRegistry;
  turn: number;
  step: number;
}): Promise<CallPlan> {
  const pre: (ExecOutcome | undefined)[] = new Array(o.calls.length);
  const runnable: ToolCallPayload[] = [];
  const reminders: string[] = [];
  let halted = false;   // 停批 / 终止之后，本批剩余调用一律不执行
  let fail = false;

  for (let i = 0; i < o.calls.length; i++) {
    const c = o.calls[i]!;
    const bd = o.breaker.note({ id: c.id, name: c.function.name, arguments: c.function.arguments });
    if (bd.reminder) reminders.push(bd.reminder);
    if (bd.fail || halted) {
      if (bd.fail) fail = true;
      halted = true;
      pre[i] = blockedOutcome(c, REPEAT_BLOCKED_TEXT);
      continue;
    }
    if (bd.stopBatch) { halted = true; pre[i] = blockedOutcome(c, REPEAT_BLOCKED_TEXT); continue; }
    const veto = await o.hookRegistry?.fire("beforeToolExecute", {
      turn: o.turn, step: o.step, call: c, toolName: c.function.name, args: parseToolArgs(c.function.arguments),
    });
    if (veto?.vetoed) { pre[i] = blockedOutcome(c, hookBlockedText(veto.vetoed)); continue; }
    runnable.push(c);
  }
  return { pre, runnable, reminders, fail };
}

/** 工具参数串 → 对象（给 hook payload 用）；解析失败给 undefined，绝不抛错 */
function parseToolArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

/**
 * 被拦下的调用合成一条工具结果：形状照抄 tool-exec.ts 里「用户拒绝」那条（ok:false + errorText）。
 *
 * ⚠️ 唯一**不**照抄的是 `denied`：它不是布尔装饰品 —— turn.ts 拿它喂闸门③（权限续跑），
 *    而那两条提醒说的是「被用户拒绝了」。hook 拦下的调用跟用户没关系，这么说会误导模型
 *    （它可能反过来问用户为什么拒绝）；更糟的是闸门③会把断路器刚刚终止的那一轮**重新拉起来**，
 *    「12 档终止」当场失效。所以这里只留 ok:false + 措辞清楚的 errorText。
 */
function blockedOutcome(c: ToolCallPayload, text: string): ExecOutcome {
  return {
    toolCallId: c.id, toolName: c.function.name, input: parseToolArgs(c.function.arguments) ?? {},
    ok: false, errorText: text, durationMs: 0,
  };
}

/** 重复断路器的停批/终止文案（模型看到的解释，必须说清「不是失败、是你不该再试了」） */
const REPEAT_BLOCKED_TEXT =
  "[重复护栏] 同一个工具 + 同一份参数已经重复太多次了，这次调用**没有执行**。" +
  "不要再用同样的参数重试 —— 换参数、换工具，或者把卡住的点直接告诉用户。";

function hookBlockedText(reason: string): string {
  return `[钩子] 这次调用被内部 hook 拦下，**没有执行**：${reason}。请不要重复同一次调用。`;
}
