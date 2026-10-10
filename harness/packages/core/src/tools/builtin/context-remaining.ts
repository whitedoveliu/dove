/**
 * GetContextRemaining —— 我还剩多少上下文
 *
 * 数据来自运行时注入的 contextStats：优先用 provider 上报的真实 usage，
 * 拿不到就用最近一次装配的本地估算 —— **输出里必须注明是估算**，别让模型当成精确值。
 */
import { defineTool, S } from "../types.ts";
import { guarded } from "./util.ts";

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(Math.round(n));
}

export const GetContextRemainingTool = defineTool({
  name: "GetContextRemaining",
  discoverable: "查看自己还剩多少上下文（已用 / 上限 / 离自动压缩还有多远）",
  description: [
    "查一下自己当前的上下文用量：还剩多少、离自动压缩（AutoCompact）的触发线还有多远。",
    "",
    "什么时候用：任务很长、你怀疑快被压缩了；或者要决定「继续深挖」还是「先把结论写给用户」。",
    "返回里会注明 used 是**真实用量**还是**本地估算**（估算值只是量级，别当精确数）。",
    "接近压缩线时：先把重要结论写进回复或文件 —— 压缩之后细节就没了。",
  ].join("\n"),
  parameters: S.obj({}, []),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (_input, ctx) => guarded(async () => {
    const svc = ctx.services?.contextStats;
    if (!svc) {
      return {
        error: "CONTEXT_STATS_UNAVAILABLE",
        note: "上下文统计没接上（ctx.services.contextStats 为空）—— 我不知道还剩多少。保守起见，重要结论先写下来。",
      };
    }
    const s = svc();
    const remainingToCompact = Math.max(0, s.compactAt - s.used);
    const remainingToWindow = Math.max(0, s.contextWindow - s.used);
    return {
      model: s.model,
      context_window: s.contextWindow,
      compact_at: s.compactAt,
      used: s.used,
      used_source: s.source === "usage" ? "provider 上报的真实用量" : "本地估算（拿不到本轮真实 usage）",
      percent_of_window: Math.round(s.percent * 10) / 10,
      percent_of_compact_line: Math.round(s.compactPercent * 10) / 10,
      remaining_to_compact: remainingToCompact,
      remaining_to_window: remainingToWindow,
      near_compact: s.nearCompact,
      would_compact_now: s.wouldCompactNow,
      messages: s.messages,
      note: [
        "上限 " + fmtTokens(s.contextWindow) + " tokens；自动压缩在 " + fmtTokens(s.compactAt) + " 触发（窗口的阈值线）。",
        s.source === "estimate" ? "⚠️ used 是**估算**（按字符数折算），只反映量级。" : "",
        s.wouldCompactNow
          ? "已经在压缩线之上 —— 下一步/下一次装配很可能触发压缩：现在就把关键结论写进回复或文件。"
          : s.nearCompact
            ? "已接近压缩线：优先把重要结论落下来，再继续深挖。"
            : "还有余量，可以继续当前任务。",
        s.note ?? "",
      ].filter(Boolean).join(" "),
    };
  }),
});
