/**
 * 上下文统计（GetContextRemaining 的数据源）
 *
 * 口径与 context/compact.ts 的 shouldCompact **保持一致**（否则模型看到的
 * 「离压缩还有多远」和实际触发点会对不上，属于典型的静默错位）：
 *   limit = min(窗口 − min(maxOutput, 32000), 窗口 × 阈值%)
 *   used  = max(真实 usage, 装配估算)
 * 真实 usage 来自 provider 每个 step 上报的用量（最后一次 = 当前上下文大小）；
 * 拿不到时退回本地估算，并在结果里标 source="estimate"。
 */
import { COMPACT_MAX_OUTPUT_FALLBACK, CONTEXT_NEAR_COMPACT_FRACTION } from "../constants.ts";
import { normalizeCompactConfig } from "../context/compact.ts";
import { estimateMessagesTokens, estimateTextTokens, estimateToolDefsTokens } from "../context/tokens.ts";
import { getModelInfo } from "../providers/index.ts";
import type { ChatMessage, ToolSchema } from "../providers/types.ts";
import type { ContextStats } from "../tools/types.ts";

export interface ContextStatsSource {
  model: string;
  systemPrompt: string;
  /** 当前上 wire 的工具定义（函数：中途激活的工具要算进去） */
  toolDefs: () => ToolSchema[];
  /** 最近一次 provider 上报的用量（每个 step 覆盖） */
  usage: () => { inputTokens: number; outputTokens: number; cacheReadTokens: number } | undefined;
  /** 当前 live 消息（不含 system） */
  messages: () => ChatMessage[];
}

/** 压缩触发线；阈值缺省与 makeCompactor 的默认配置一致（80%） */
export function compactThresholdFor(contextWindow: number, thresholdPercent?: number): number {
  const cfg = normalizeCompactConfig(thresholdPercent === undefined ? {} : { threshold: thresholdPercent });
  const reserve = Math.min(cfg.maxOutputTokens, COMPACT_MAX_OUTPUT_FALLBACK);
  return Math.min(contextWindow - reserve, Math.floor((contextWindow * cfg.threshold) / 100));
}

export function makeContextStats(src: ContextStatsSource): () => ContextStats {
  return () => {
    const window = getModelInfo(src.model).contextWindow;
    const compactAt = compactThresholdFor(window);
    const cfg = normalizeCompactConfig();
    const usage = src.usage();
    const real = usage
      ? Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens) + Math.max(0, usage.cacheReadTokens)
      : 0;
    const defs = (() => { try { return src.toolDefs(); } catch { return []; } })();
    const msgs = (() => { try { return src.messages(); } catch { return []; } })();
    const wire = Math.ceil(
      (estimateTextTokens(src.systemPrompt) + estimateToolDefsTokens(defs)) * Math.max(1, cfg.wireRatio),
    );
    const estimate = wire + estimateMessagesTokens(msgs);
    const used = Math.max(real, estimate);
    const source: ContextStats["source"] = real > 0 && real >= estimate ? "usage" : "estimate";
    return {
      model: src.model,
      contextWindow: window,
      compactAt,
      used,
      percent: window > 0 ? (used / window) * 100 : 0,
      compactPercent: compactAt > 0 ? (used / compactAt) * 100 : 0,
      nearCompact: compactAt > 0 && used >= compactAt * CONTEXT_NEAR_COMPACT_FRACTION,
      wouldCompactNow: compactAt > 0 && used > compactAt,
      source,
      messages: msgs.length,
      note: source === "usage"
        ? "used 取「最近一次真实用量」与「本轮装配估算」的较大者。"
        : "还没有真实用量，used 是本地估算（system 提示词 + " + defs.length + " 个工具 schema + " + msgs.length + " 条消息）。",
    };
  };
}
