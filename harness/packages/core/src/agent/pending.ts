/**
 * 人机交互等待器（审批 / 提问）
 * 纪律：拒绝 / 超时 / 无窗口 **一律按拒绝处理**（答疑 p07 §6）
 */
import type { ApprovalRequest, ApprovalResponse } from "../tools/types.ts";
import { approvalTimeoutMs } from "../constants.ts";

interface Pending<T> {
  resolve: (v: T) => void;
  timer: ReturnType<typeof setTimeout>;
  payload: unknown;
}

export class PendingRegistry {
  #approvals = new Map<string, Pending<ApprovalResponse>>();
  #questions = new Map<string, Pending<string>>();

  /** 请求审批；超时或没有窗口 → 拒绝。等待上限默认取 DOVE_APPROVAL_TIMEOUT_MS（缺省 5 分钟） */
  requestApproval(toolCallId: string, req: ApprovalRequest, timeoutMs = approvalTimeoutMs(), hasWindow = true): Promise<ApprovalResponse> {
    if (!hasWindow) return Promise.resolve({ approved: false, reason: "no-window", decision: "deny" });
    return new Promise<ApprovalResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.#approvals.delete(toolCallId);
        // ⚠️ 超时不能是「静默失败」：把等了多久一起带回去，
        //    调用方（loop/tool-exec.ts）会把它写进工具错误、并发一条 tool:approval_timeout 事件。
        //    用户回来看到的是「等了 5 分钟没人处理，已自动拒绝」，而不是一句没头没尾的失败。
        resolve({ approved: false, reason: "timeout", decision: "deny", timeoutMs });
      }, timeoutMs);
      this.#approvals.set(toolCallId, { resolve, timer, payload: req });
    });
  }

  resolveApproval(toolCallId: string, approved: boolean, denyReason?: string): boolean {
    const p = this.#approvals.get(toolCallId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.#approvals.delete(toolCallId);
    p.resolve({ approved, decision: approved ? "allow" : "deny", reason: "user", denyReason });
    return true;
  }

  listPendingApprovals(): { toolCallId: string; request: unknown }[] {
    return [...this.#approvals.entries()].map(([k, v]) => ({ toolCallId: k, request: v.payload }));
  }

  /**
   * 当前等待用户回答的问题。
   * 老契约（control-panel）的 /api/user-input 只带项目 id、不带问题 id，
   * 所以兼容层靠「该项目此刻在等哪个问题」来配平 —— 这里就是那个查询口。
   */
  listPendingQuestions(): { questionId: string }[] {
    return [...this.#questions.keys()].map((questionId) => ({ questionId }));
  }

  /**
   * 反问用户；超时返回空串。
   * 等待上限同样跟 DOVE_APPROVAL_TIMEOUT_MS 走 —— 「等用户回话」和「等用户点允许」
   * 是同一类等待，两个超时用两个数只会让人调错一个。
   * （注意：AskUserQuestion 工具走的是自己的 waitForAnswers，见 tools/builtin/ask-user.ts。）
   */
  ask(questionId: string, timeoutMs = approvalTimeoutMs()): Promise<string> {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => { this.#questions.delete(questionId); resolve(""); }, timeoutMs);
      this.#questions.set(questionId, { resolve, timer, payload: null });
    });
  }

  answer(questionId: string, text: string): boolean {
    const p = this.#questions.get(questionId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.#questions.delete(questionId);
    p.resolve(text);
    return true;
  }
}
