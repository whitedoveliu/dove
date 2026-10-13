/**
 * tailState 工厂 —— 「每轮都变」的 mt 内容装配（情绪 / 疲劳 / todo）。
 * 从 bootstrap.ts 里搬出来：那个文件贴着 400 行硬上限，再往里加就违规。
 *
 * 纪律：
 * - 逐块 try/catch：任何一块坏掉只丢自己，装配整体不许失败；
 * - 注入只发生在内存里 —— 不落库、不写事件日志。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TailContext, TailTask } from "../../core/src/context/tail-context.ts";

export interface TailStateDeps {
  configDir: string;
  emotion?: (threadId: string) => string | undefined;
  fatigue?: () => string | undefined;
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
    return out;
  };
}
