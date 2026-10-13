import * as React from "react";
import { contextWindowOf, formatTokens } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * 输入框下方的细状态行 —— 一行小字交代「刚刚这一轮花了多少」。
 *
 * 形态照 mnemo / DSH：12px、灰、单行、窄窗口直接截断（不换行、不抢输入框的视线）。
 * 三段，竖线隔开：
 *   N 轮 · M 步 · X tok/s     内核 stats 报的 rounds + 面板数到的工具调用 + 输出速度
 *   T tok · 缓存命中 P%       跨轮累计的 token + 缓存命中率
 *   C%                        上下文占用
 *
 * ── 公式（**只在这里定义一份**；别处要算就调这里，别再抄一遍）───────────────
 *   · 提示侧   = input_tokens + cache_read_tokens + cache_creation_tokens
 *   · tok/s    = 最近一轮的 output_tokens ÷ 最近一轮的墙钟秒数
 *   · T tok    = 各轮「提示侧 + 输出侧」累计
 *   · 缓存命中  = cache_read ÷ (cache_read + input + cache_creation) = cache_read ÷ 提示侧
 *                ← DSH 的口径。拿真实的 stats 载荷核对过：sse-compat 出的
 *                  breakdown 里 cache_creation_tokens 恒为 0，所以实际退化成
 *                  cache_read ÷ (cache_read + input)，与 DSH 的定义不冲突。
 *   · C%       = 最近一轮的**提示侧 token** ÷ 当前模型的 contextWindow（1_048_576）。
 *                ⚠️ 是「提示 token ÷ 窗口」，**不是缓存**占比 —— 别看见 cache 两个字就往缓存上想。
 *
 * 还没拿到的格子写「—」（第一轮跑着的时候 rounds / usage 都还没到，这是正常的，不是坏了）；
 * data 为 null（这轮之前没有任何数据）时整条不渲染 —— 新线程本来就该是干净的。
 */
export interface ComposerStatusData {
  /** 内核 stats 报的 rounds；null = 还没有跑完过任何一轮 */
  rounds: number | null;
  /** 数到的工具调用次数（跑着的时候是当前轮的实时值） */
  steps: number;
  /** 最近一轮的输出 token —— tok/s 的分子；null = 还不知道 */
  outputTokens: number | null;
  /** 最近一轮的提示侧 token —— 缓存命中与 C% 的分母；null = 还不知道 */
  promptTokens: number | null;
  /** 最近一轮的 cache_read token —— 缓存命中的分子；null = 还不知道 */
  cacheReadTokens: number | null;
  /** 最近一轮的墙钟时长（毫秒）—— tok/s 的分母；null = 还不知道 */
  durationMs: number | null;
  /** 跨轮累计的 token（提示侧 + 输出侧） */
  totalTokens: number;
}

/** 段间那条竖线：比正文更淡，别让它抢戏 */
function Sep() {
  return <span aria-hidden className="shrink-0 select-none text-text-disabled">|</span>;
}

/** 数字比标签亮一档（一行里能扫出数就行），等宽数字防跳动 */
function Num({ children }: { children: React.ReactNode }) {
  return <span className="tabular text-text-secondary">{children}</span>;
}

export function ComposerStatusLine({
  data, model, className,
}: {
  data: ComposerStatusData | null;
  /** 当前模型 —— 只用来取 C% 的分母（上下文窗口），没别的用途 */
  model?: string;
  className?: string;
}) {
  if (!data) return null;

  const dash = "—";
  const contextWindow = contextWindowOf(model);

  const tokPerSec =
    data.outputTokens != null && data.durationMs != null && data.durationMs > 0
      ? `${Math.round(data.outputTokens / (data.durationMs / 1000))} tok/s`
      : `${dash} tok/s`;
  const cacheHit =
    data.cacheReadTokens != null && data.promptTokens != null && data.promptTokens > 0
      ? `${Math.round((data.cacheReadTokens / data.promptTokens) * 100)}%`
      : dash;
  const contextPct =
    data.promptTokens != null && contextWindow > 0
      ? `${Math.round((data.promptTokens / contextWindow) * 100)}%`
      : dash;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-text-tertiary",
        className,
      )}
    >
      <span className="truncate">
        <Num>{data.rounds ?? dash}</Num> 轮 · <Num>{data.steps}</Num> 步 · <Num>{tokPerSec}</Num>
      </span>
      <Sep />
      <span className="truncate">
        {/* 累计还是 0（第一轮跑着的时候）= 还没有数，写 — 而不是 0 —— 别让人以为"一分没花"，
            0 在 stats 里根本不会出现（零用量的条目会被 usageEntries 过滤掉） */}
        <Num>{data.totalTokens > 0 ? formatTokens(data.totalTokens) : dash}</Num> tok · 缓存命中 <Num>{cacheHit}</Num>
      </span>
      <Sep />
      <span className="shrink-0">上下文 <Num>{contextPct}</Num></span>
    </div>
  );
}
