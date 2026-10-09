/**
 * AutoCompact（T2.6 / T2.7）
 * 纪律：① keepRecentMessages 的单位是「对话回合」，不是消息条数；
 *       ② 回合中压缩只活在内存，回合末才落库（防「压缩 → 再压缩」抖动）；
 *       ③ 摘要失败退化为粗暴截断并显式标记，绝不假装成功。
 */
import {
  COMPACT_DEFAULT_THRESHOLD,
  COMPACT_KEEP_RECENT_RANGE,
  COMPACT_KEEP_RECENT_TURNS,
  COMPACT_MAX_OUTPUT_FALLBACK,
  COMPACT_MIN_STEP_GAP,
  COMPACT_TARGET_MIN_FRACTION,
  COMPACT_TARGET_WINDOW_FRACTION,
  COMPACT_THRESHOLD_RANGE,
  COMPACT_WIRE_RATIO_MAX,
} from "../constants.ts";
import type { ChatMessage, ToolSchema } from "../providers/types.ts";
import type { Usage } from "../session/types.ts";
import { buildCompactPrompt, renderConversationForSummary } from "./compact-prompt.ts";
import { estimateTextTokens, estimateToolDefsTokens, findSafeSplitPoint, keepRecentTurnsStart } from "./tokens.ts";

export interface CompactConfig {
  enabled: boolean;
  /** 触发阈值：上下文窗口的百分比（夹 60–95，默认 80） */
  threshold: number;
  /** 保留最近多少「对话回合」（夹 2–20，默认 4）—— 单位是回合不是消息 */
  keepRecentMessages: number;
  /** 模型最大输出 token；判据里与 32000 取较小者做输出预留 */
  maxOutputTokens: number;
  /** 系统提示词 + 工具 schema 在 wire 上的放大幅度（夹 1–3） */
  wireRatio: number;
}

export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  enabled: true,
  threshold: COMPACT_DEFAULT_THRESHOLD,
  keepRecentMessages: COMPACT_KEEP_RECENT_TURNS,
  maxOutputTokens: COMPACT_MAX_OUTPUT_FALLBACK,
  wireRatio: 1,
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** 归一化配置：阈值夹 [60,95]，保留回合夹 [2,20]，wireRatio 夹 [1,3] */
export function normalizeCompactConfig(partial: Partial<CompactConfig> = {}): CompactConfig {
  const base = { ...DEFAULT_COMPACT_CONFIG, ...partial };
  return {
    enabled: base.enabled !== false,
    threshold: Math.round(clamp(base.threshold, COMPACT_THRESHOLD_RANGE[0], COMPACT_THRESHOLD_RANGE[1])),
    keepRecentMessages: Math.round(clamp(base.keepRecentMessages, COMPACT_KEEP_RECENT_RANGE[0], COMPACT_KEEP_RECENT_RANGE[1])),
    maxOutputTokens: Math.max(0, Math.round(Number.isFinite(base.maxOutputTokens) ? base.maxOutputTokens : COMPACT_MAX_OUTPUT_FALLBACK)),
    wireRatio: clamp(base.wireRatio, 1, COMPACT_WIRE_RATIO_MAX),
  };
}

/** wire 开销：系统提示词 + 工具定义的估算值 × wireRatio */
export function estimateWireOverhead(systemPrompt: string, toolDefs: ToolSchema[], wireRatio: number): number {
  const ratio = clamp(wireRatio, 1, COMPACT_WIRE_RATIO_MAX);
  return Math.ceil((estimateTextTokens(systemPrompt) + estimateToolDefsTokens(toolDefs)) * ratio);
}

/**
 * 超限判定：used = max(真实 usage, 估算 wire 开销) 与 limit 比较，
 * limit 取「窗口 × threshold%」与「窗口 − min(maxOutput, 32000)」中的较小者 ——
 * 前者是可调触发线（默认 80%），后者是硬上限（给输出留空间，绝不越过）。
 */
export function shouldCompact(
  usage: Usage,
  systemPrompt: string,
  toolDefs: ToolSchema[] | undefined,
  cfg: CompactConfig,
  contextWindow: number,
): boolean {
  if (!cfg.enabled) return false;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  const c = normalizeCompactConfig(cfg);
  const reserve = Math.min(c.maxOutputTokens, COMPACT_MAX_OUTPUT_FALLBACK);
  const limit = Math.min(contextWindow - reserve, Math.floor((contextWindow * c.threshold) / 100));
  const real = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens) + Math.max(0, usage.cacheReadTokens);
  const used = Math.max(real, estimateWireOverhead(systemPrompt, toolDefs ?? [], c.wireRatio));
  return used > limit;
}

/** 去抖：距上次压缩 step 不足 COMPACT_MIN_STEP_GAP 就不许再压（防抖动） */
export function shouldSkipForDebounce(lastCompactStep: number | undefined, currentStep: number): boolean {
  if (lastCompactStep === undefined || lastCompactStep < 0) return false;
  return currentStep - lastCompactStep < COMPACT_MIN_STEP_GAP;
}

export interface CompactOptions {
  /** 摘要器：调用方用 COMPACT_SYSTEM_PROMPT + buildCompactPrompt(transcript) 调模型 */
  summarize: (text: string) => Promise<string>;
  cfg: CompactConfig;
  contextWindow: number;
}

export interface CompactResult {
  messages: ChatMessage[];
  /** 摘要正文；退化为截断时为空串 */
  summary: string;
  /** true = 走了粗暴截断（日志里标记 Fallback: truncated） */
  fallback: boolean;
  /** 被移出上下文的消息条数 */
  droppedMessages: number;
}

/** 摘要消息：以 user 身份承载（不塞回 system，避免破坏前缀缓存） */
export function summaryMessage(summary: string): ChatMessage {
  return {
    role: "user",
    content: `[Context: 更早的对话已被压缩（原文已移出上下文以节省空间）。以下是继续工作所需的结构化摘要：]\n\n${summary}`,
  };
}

/** 退化消息：明确标记，不假装摘要成功 */
export function fallbackMessage(dropped: number): ChatMessage {
  return {
    role: "user",
    content: `[Context: 更早的 ${dropped} 条消息已从上下文移除。Fallback: truncated —— 摘要步骤失败，这些内容的细节已不可用；需要时请让用户重述，或重新读相关文件确认。]`,
  };
}

/** 压缩主流程：摘要早期对话，保留最近若干回合 */
export async function compact(msgs: ChatMessage[], opts: CompactOptions): Promise<CompactResult> {
  const cfg = normalizeCompactConfig(opts.cfg);
  const window = Number.isFinite(opts.contextWindow) && opts.contextWindow > 0 ? opts.contextWindow : 0;

  const turnStart = keepRecentTurnsStart(msgs, cfg.keepRecentMessages);
  // 保留段还要受预算约束（窗口的 60%），否则压缩完仍然超限，会陷入「压缩 → 再压缩」
  const keepBudget = window > 0 ? Math.floor(window * COMPACT_TARGET_WINDOW_FRACTION) : Number.MAX_SAFE_INTEGER;
  const keep = findSafeSplitPoint(msgs, turnStart, keepBudget);
  if (keep <= 0) return { messages: msgs.slice(), summary: "", fallback: false, droppedMessages: 0 };

  const head = msgs.slice(0, keep);
  const tail = msgs.slice(keep);
  // 摘要输入预算：窗口的 15%（下限 1000 token）；中文约 2 字符/token
  const inputTokens = window > 0 ? Math.max(1000, Math.floor(window * COMPACT_TARGET_MIN_FRACTION)) : 8000;
  const transcript = renderConversationForSummary(head, inputTokens * 2);

  try {
    const summary = (await opts.summarize(buildCompactPrompt(transcript))).trim();
    if (summary.length > 0) {
      return { messages: [summaryMessage(summary), ...tail], summary, fallback: false, droppedMessages: head.length };
    }
  } catch {
    // 落到下面的粗暴截断
  }
  return { messages: [fallbackMessage(head.length), ...tail], summary: "", fallback: true, droppedMessages: head.length };
}
