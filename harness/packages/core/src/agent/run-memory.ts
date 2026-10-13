/**
 * 回合结束的记忆写入（从 agent/runtime.ts 抽出来）
 *
 * 为什么单独放一个文件：runtime.ts 已经贴着 400 行上限，
 * 而这两段是「收尾副作用」，与主流程无关、失败也不该影响对话 —— 正好是适合搬走的边界。
 * 两处都刻意做成 `catch(() => {})`：记忆是增强，不是对话的前置条件。
 *
 * ⚠️ 历史教训（保留在 runtime 的调用点注释里）：`captureDaily` 曾经**从没被调用过**
 *    —— 声明了、实现了、就是没人点它。所以这里的调用点是必须存在的接线，不是可选优化。
 */
import type { Part } from "../session/types.ts";

/** 只声明用到的那几个方法（**不 import runtime.ts**，否则两边循环依赖） */
export interface TurnMemoryPort {
  summarizeTurn?(threadId: string, projectId: string | null, text: string): Promise<void>;
  captureDiary?(exchange: string): Promise<void>;
}

/** 把这一轮的「用户说了什么 / Dove 回了什么」写进记忆；没有记忆服务时安静跳过 */
export function persistTurnMemory(opts: {
  memory?: TurnMemoryPort;
  threadId: string;
  projectId: string | null;
  userText: string;
  parts: Part[];
}): void {
  const m = opts.memory;
  if (!m) return;
  const reply = opts.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");
  const exchange = `用户：${opts.userText}\n\nDove：${reply}`;

  if (m.summarizeTurn) m.summarizeTurn(opts.threadId, opts.projectId, exchange).catch(() => { /* 失败不影响对话 */ });
  // 日记（系统提示词 S11 槽位）：每轮 LLM 浓缩一行
  if (m.captureDiary && reply.trim()) m.captureDiary(exchange).catch(() => { /* 同上 */ });
}

/** 老化只需要这一个方法（**不 import store.ts**，避免把 session 整层拖进这个收尾模块） */
export interface AgingPort {
  ageToolParts(threadId: string, workdir: string): Promise<{ aged: number }>;
}

/**
 * 回合收尾的副作用一口气做完：记忆写入 + 工具结果老化。
 *
 * 为什么合并成一个入口：`agent/runtime.ts` 贴着 400 行上限，而这三件事都是「跑完之后的收尾」，
 * 与主流程无关、失败也都不该影响这一轮 —— 正好是适合一起搬走的边界。
 * 老化**必须落库**（改的是库里的 part），否则下一轮重建又变回全文，前缀缓存会在那一点反复断（铁律二）。
 */
export async function persistTurnEnd(opts: {
  memory?: TurnMemoryPort;
  store: AgingPort;
  threadId: string;
  projectId: string | null;
  userText: string;
  parts: Part[];
  workdir: string;
}): Promise<void> {
  persistTurnMemory(opts);
  await opts.store.ageToolParts(opts.threadId, opts.workdir).catch(() => { /* 老化失败不影响对话 */ });
}
