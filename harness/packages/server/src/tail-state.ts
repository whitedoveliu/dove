/**
 * tailState 工厂 —— 「每轮都变」的 mt 内容装配（情绪 / 疲劳 / todo / 运行时活动注入）。
 * 从 bootstrap.ts 里搬出来：那个文件贴着 400 行硬上限，再往里加就违规。
 *
 * 纪律：
 * - 逐块 try/catch：任何一块坏掉只丢自己，装配整体不许失败；
 * - activity 用**惰性取值**（它比装配器晚创建，直接引用会命中 TDZ）；
 * - 注入只发生在内存里 —— 不落库、不写事件日志。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRecentSummary } from "../../core/src/activity/recent.ts";
import type { ActivityStore } from "../../core/src/activity/store.ts";
import { buildActivityInjection, type ScreenEmbedder } from "../../core/src/context/activity-inject.ts";
import type { TailContext, TailTask } from "../../core/src/context/tail-context.ts";
import { ACTIVITY_INJECT } from "../../core/src/constants.ts";

/** 屏幕记忆入口：ActivityRecorder 自己**没有** searchScreen（检索在它的 store 上） */
export interface ActivityRecorderLike {
  store: ActivityStore;
}

export interface TailStateDeps {
  configDir: string;
  emotion?: (threadId: string) => string | undefined;
  fatigue?: () => string | undefined;
  /** 惰性取：activity 在 bootstrap 里比装配器晚建 */
  activity?: () => ActivityRecorderLike | null;
  /**
   * 屏幕语义的向量后端。
   * ⚠️ 只在**真向量**（ONNX）时传；resolveEmbedder 的 hash 降级别传 ——
   * 屏幕通道的 0.40 阈值是按 BGE 标定的，hash 是字面匹配，尺度完全不同。
   */
  screenEmbedder?: () => ScreenEmbedder | undefined;
}

/** 读 todos.json；文件缺失 / JSON 坏掉一律当「没有 todo」 */
function readTodos(configDir: string): TailTask[] | undefined {
  try {
    const file = join(configDir, "todos.json");
    if (!existsSync(file)) return undefined;
    const todos = JSON.parse(readFileSync(file, "utf8")) as TailTask[];
    return Array.isArray(todos) && todos.length ? todos.slice(0, 20) : undefined;
  } catch {
    return undefined;
  }
}

/** 生成 makeAssembler 需要的 tailState 钩子 */
export function makeTailState(deps: TailStateDeps) {
  return async function tailState(threadId: string, userText: string): Promise<Partial<TailContext>> {
    const out: Partial<TailContext> = {};
    // 情绪与疲劳：每轮都变 → 必须走 mt，绝不进系统提示词
    try { const v = deps.emotion?.(threadId); if (v) out.emotion = v; } catch { /* 忽略 */ }
    try { const v = deps.fatigue?.(); if (v) out.fatigue = v; } catch { /* 忽略 */ }
    try { const todos = readTodos(deps.configDir); if (todos) out.tasks = todos; } catch { /* 忽略 */ }

    // 运行时活动注入（问候 / 语义两条通道）。
    // 不在这里包超时：buildActivityInjection 自己 350ms 放弃语义通道、失败静默。
    try {
      const rec = deps.activity?.() ?? null;
      const embedder = deps.screenEmbedder?.();
      const recent = (): number => Date.now() - ACTIVITY_INJECT.semanticWindowMs;
      const inject = await buildActivityInjection({
        userText,
        searchScreen: rec ? (q, limit) => rec.store.searchScreen(q, { limit, since: recent() }) : undefined,
        embedder,
        // 向量腿要求「后端 + 候选池」同时具备，缺一个就自动走词袋腿
        listFrames: rec && embedder ? (from, limit) => rec.store.listRecentOcrFrames(from, limit) : undefined,
        recentSummary: rec
          ? () => Promise.resolve(buildRecentSummary(rec.store, { hours: ACTIVITY_INJECT.greetingWindowMs / 3_600_000 }))
          : undefined,
      });
      const block = [inject.greeting, inject.semantic].filter(Boolean).join("\n\n");
      if (block) out.activity = block;
    } catch { /* 注入失败绝不影响对话 */ }
    return out;
  };
}
