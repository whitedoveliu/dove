/**
 * 运行时对外的**端口**（从 agent/runtime.ts 抽出来，理由见下）
 *
 * 为什么单独一个文件：runtime.ts 贴着 400 行上限，而这些只是「入参/出参/依赖」的形状，
 * 不含任何行为。搬走它们一次省下十几行，接线时才有地方写新代码。
 *
 * 兼容：runtime.ts 仍然**转出**这几个类型（`export type { ... } from "./runtime-ports.ts"`），
 * 所以既有调用方（server/bootstrap.ts 等）的 import 路径一个字都不用改。
 */
import type { Thread } from "../session/types.ts";

export interface AssembleInput {
  thread: Thread; projectId?: string | null; userText: string;
  workdir: string; outputsDir: string;
}
export interface AssembleOutput {
  systemPrompt: string; tailContext: string; memoriesBlock: string; dualSystem?: boolean;
  /** 本轮的项目指令（AGENTS.md）正文与上一轮**逐字节不同** —— 即系统提示词在这一轮真的变了 */
  instructionsChanged?: boolean;
}
export interface MemoryPort {
  retrieveForContext(query: string, projectId?: string | null): Promise<{ context: string; usedMemories: { id: string; content: string }[] }>;
  remember(content: string, kind?: string, scope?: string): Promise<string>;
  captureDaily(content: string): Promise<void>;
  /** 把一轮对话浓缩成一行日记（LLM 总结后写进 memory/YYYY-MM-DD.md） */
  captureDiary?(exchange: string): Promise<void>;
  summarizeTurn?(threadId: string, projectId: string | null, text: string): Promise<void>;
}
