/**
 * 长期目标（Goal）—— 面板侧的状态。
 *
 * 内核在目标 active 时**每轮结束自动再开一轮**（受 max_rounds 限制），所以面板不需要
 * "继续跑"的按钮，只需要展示 + 人类操作入口：状态条（components/goal-bar.tsx）
 * 和 /goal 命令（lib/goal-command.ts 负责解析）走的是**同一个 apply()**。
 *
 * 和 usePlanMode 的差别：计划模式是布尔开关、服务端不回状态，只能乐观更新；
 * 目标有**状态机**（active → paused/blocked → …），POST 的返回值就是权威状态 ——
 * 所以这里以响应为准，只有 pending 是本地状态（防止手快点两下打出一对互相打架的请求：
 * 一个 pause 一个 resume，谁最后到谁赢，和用户看到的顺序可能相反）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  getGoal, postGoal, GoalApiError,
  type Goal, type GoalPostBody,
} from "@/lib/api";

export interface GoalResult {
  ok: boolean;
  /** 成功时的当前目标；没有目标就是 null */
  goal: Goal | null;
  /** 失败时的内核错误码（404 = 没有目标，409 = 已有未完成目标，400 = 状态不允许） */
  code?: string;
  message?: string;
}

function fail(e: unknown): GoalResult {
  if (e instanceof GoalApiError) return { ok: false, goal: null, code: e.code, message: e.message };
  return { ok: false, goal: null, message: e instanceof Error ? e.message : String(e) };
}

const DRAFT_GOAL_KEY = "dove_new_goal";

/**
 * 新会话页写的**长期目标草稿**。
 *
 * 为什么需要：目标在内核里是**线程级**的（goals 表按 thread 存），而新会话页还没有线程。
 * 与其拒绝用户（"先建任务再设目标"），不如先把目标记下来，建任务时由 App 落地 ——
 * 和「计划模式草稿」「权限草稿」完全同一个套路（见 lib/permission.ts 的 draft 系列）。
 */
export function readDraftGoal(): string | null {
  try {
    const t = localStorage.getItem(DRAFT_GOAL_KEY);
    return t && t.trim() ? t : null;
  } catch { return null; }
}

export function writeDraftGoal(text: string): void {
  try { localStorage.setItem(DRAFT_GOAL_KEY, text); } catch { /* 隐私模式等，忽略 */ }
}

export function clearDraftGoal(): void {
  try { localStorage.removeItem(DRAFT_GOAL_KEY); } catch { /* 同上 */ }
}

/**
 * key 为空（还没进任务）时不做任何请求：目标是**线程级**的，没有线程就没有它。
 */
export function useGoal(key: string | null | undefined) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!key) { setGoal(null); return; }
    let alive = true;
    getGoal(key)
      .then((p) => { if (alive) setGoal(p.goal); })
      // 读不到就保持现值：可能是任务刚建好、内核还没落库
      .catch(() => { /* noop */ });
    return () => { alive = false; };
  }, [key]);

  /**
   * 重读。**一轮跑完后必须重读**：目标可能是模型自己标完成 / 标阻塞的
   * （UpdateGoal 是它的工具），面板本地不知道那一刻。
   */
  const refresh = useCallback(async (): Promise<GoalResult> => {
    if (!key) { setGoal(null); return { ok: true, goal: null }; }
    try {
      const p = await getGoal(key);
      setGoal(p.goal);
      return { ok: true, goal: p.goal };
    } catch (e) {
      return fail(e);   // 读不到就保持现值，不清空
    }
  }, [key]);

  /** 建 / 暂停 / 继续 / 完成 / 标阻塞 / 清除 —— 命令和状态条按钮共用的唯一入口 */
  const apply = useCallback(async (body: GoalPostBody): Promise<GoalResult> => {
    if (!key) return { ok: false, goal: null, message: "还没有任务，目标要先有一个会话" };
    setPending(true);
    try {
      const p = await postGoal(key, body);
      setGoal(p.goal);
      return { ok: true, goal: p.goal };
    } catch (e) {
      return fail(e);
    } finally {
      setPending(false);
    }
  }, [key]);

  return { goal, pending, apply, refresh };
}
