/**
 * 系统提示词装配（T2.1 / T2.5 / T2.9）
 * 铁律：系统提示词只放稳定内容 —— block1 是永不变化的冻结前缀；
 *       所有每轮都变的内容走 mt（tail-context.ts）prepend 到最后一条 user 消息。
 */
import type { Thread } from "../session/types.ts";
import type { Usage } from "../session/types.ts";
import type { MemorySlice } from "./memories-block.ts";
import {
  SEGMENTS,
  assertSegmentDiscipline,
  buildSegmentContext,
  type ContextState,
  type ProjectContext,
} from "./segments.ts";

/** provider 拆分标记：默认「以 SYSTEM INFO 开头的行」（可用 providerSplitMarker 覆盖） */
export const DEFAULT_SPLIT_MARKER = "SYSTEM INFO";

export interface AssembleInput {
  thread: Thread;
  projectContext?: ProjectContext;
  /** 记忆切片：只用于段落的适配判断，实际注入走 mt（injectIntoLastUser） */
  memories?: MemorySlice[];
  state?: ContextState;
  /** 本轮用户原文：只给 tailState 之类的运行时钩子用，绝不进系统提示词（前缀缓存纪律） */
  userText?: string;
  providerSplitMarker?: string;
}

/** 按序装配系统提示词，并按拆分标记切成 provider 需要的两段 */
export async function assembleSystemPrompt(input: AssembleInput): Promise<{ block1: string; block2: string | null }> {
  assertSegmentDiscipline();
  const ctx = buildSegmentContext(input);
  const marker = input.providerSplitMarker ?? DEFAULT_SPLIT_MARKER;
  // 切点选在「最后一个前导静态段」之后：block1 尽量长，且永远完全静态（前缀缓存纪律）
  const firstNonStatic = SEGMENTS.findIndex((s) => s.kind !== "static");

  const chunks: string[] = [];
  for (let i = 0; i < SEGMENTS.length; i++) {
    if (marker && i > 0 && i === firstNonStatic) chunks.push(marker);
    const text = (await SEGMENTS[i]!.render(ctx)).trim();
    if (text.length > 0) chunks.push(text);
  }
  return splitForProvider(chunks.join("\n\n"), marker);
}

/**
 * 按标记行切分：block1 = 标记行之前的全部内容，block2 = 从标记行开始到结尾。
 * 找不到标记 → block2 = null（provider 用单 system 块）。标记行保留在 block2 开头当标题。
 */
export function splitForProvider(prompt: string, marker: string = DEFAULT_SPLIT_MARKER): { block1: string; block2: string | null } {
  const lines = prompt.split("\n");
  const at = marker ? lines.findIndex((line) => line.trimStart().startsWith(marker)) : -1;
  if (at < 0) return { block1: prompt.trim(), block2: null };
  const block1 = lines.slice(0, at).join("\n").trim();
  const block2 = lines.slice(at).join("\n").trim();
  return { block1, block2: block2.length > 0 ? block2 : null };
}

/** 缓存命中率度量（T2.9）：每次请求记录 input / cacheRead / cacheWrite */
export interface CacheMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 命中率 = cacheRead / (input + cacheRead) */
  cacheHitRate: number;
}

export function cacheMetrics(usage: Usage): CacheMetrics {
  const input = Math.max(0, usage.inputTokens);
  const cacheRead = Math.max(0, usage.cacheReadTokens);
  const total = input + cacheRead;
  return {
    inputTokens: input,
    outputTokens: Math.max(0, usage.outputTokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: Math.max(0, usage.cacheWriteTokens),
    cacheHitRate: total > 0 ? cacheRead / total : 0,
  };
}
