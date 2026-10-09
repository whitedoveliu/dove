/**
 * 四道闸门（T1.3；答疑 P2-12 第 4 条）
 * 顺序 = 优先级：人（steering） > 自救（完成守卫/权限续跑） > 补跑（自动续跑）
 * 纪律：②③④ **互斥**，不能同时开火，否则「双恢复打架」或「无限续跑」。
 *       三个计数器按回合重置。
 */
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
}

export interface GateDecision {
  gate: GateId | null;
  /** 追加到 messages 的系统提醒（续跑用） */
  reminder?: string;
  /** 是否把 steering 折叠进 messages */
  foldSteering?: boolean;
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
  if (input.hadToolCalls && !input.sawAttemptCompletion
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
