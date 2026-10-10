/**
 * exitPlanMode 服务 —— 计划批准后把线程从计划模式里放出来
 *
 * 为什么单独一个文件：工具（ExitPlanMode）只负责"要用户批准"，批准之后**谁来改线程状态**
 * 是内核的事 —— 工具不碰 metadata（避免"工具偷偷切模式"）。这里是那一步的实现，
 * 由运行时装配时注入到 ctx.services.exitPlanMode。
 *
 * 失败一律返回 { ok:false, error }，不抛 —— 工具那边要把它变成给模型的说明。
 */
import type { Store } from "../../core/src/session/store.ts";

export interface ExitPlanModeDeps {
  store: Store;
  /** 事件出口（SSE）。批准这件事要让前端知道，好把计划渲染出来 */
  sink?: (e: { type: string; [k: string]: unknown }) => void;
  /** 计划正文往事件里塞多少字符（默认 6000，够一整份计划） */
  planChars?: number;
}

export type ExitPlanModeResult = { ok: true } | { ok: false; error: string };

export function makeExitPlanMode(deps: ExitPlanModeDeps): (threadId: string, plan: string) => Promise<ExitPlanModeResult> {
  const limit = deps.planChars ?? 6_000;
  return async (threadId: string, plan: string): Promise<ExitPlanModeResult> => {
    try {
      const t = deps.store.getThread(threadId);
      if (!t) return { ok: false, error: "线程不存在：" + threadId };
      const meta = { ...t.metadata, planMode: false, planApprovedAt: Date.now() };
      deps.store.updateThread(threadId, { metadata: meta });
      deps.sink?.({ type: "plan_approved", threadId, plan: plan.slice(0, limit) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
