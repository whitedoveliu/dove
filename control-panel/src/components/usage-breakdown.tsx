"use client";

import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  formatCost,
  formatTokens,
  totalTokens,
  usageEntries,
  type UsageLike,
} from "@/lib/models";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-text-tertiary">{label}</span>
      <span className="font-mono tabular">{value}</span>
    </div>
  );
}

/**
 * UsageBreakdown — 按模型展示 token 与费用。
 *
 * 兼容两代数据：新的 breakdown（按真实模型计费）与旧的 sonnet/opus 两桶。
 * 未收录价格的模型会显式提示，而不是拿别的模型的价格顶上。
 */
export function UsageBreakdown({
  usage,
  showTotal = true,
  className,
}: {
  usage?: UsageLike | null;
  showTotal?: boolean;
  className?: string;
}) {
  const entries = usageEntries(usage);

  if (!entries.length) {
    return <div className={cn("text-2xs text-text-tertiary", className)}>暂无用量数据</div>;
  }

  const total = entries.reduce((sum, e) => sum + e.cost, 0);
  const unknown = entries.filter((e) => !e.pricing_found);

  return (
    <div className={cn("min-w-[13rem] space-y-2", className)}>
      {entries.map((entry, index) => (
        <div key={entry.model} className="space-y-1">
          <div
            className={cn(
              "flex items-center justify-between gap-4 border-b border-border-subtle pb-1",
              index > 0 && "pt-1"
            )}
          >
            <span className="font-medium text-text-primary">{entry.display}</span>
            <span className="font-mono tabular text-text-secondary">
              {entry.pricing_found ? formatCost(entry.cost) : "—"}
            </span>
          </div>
          <Row label="Input" value={formatTokens(entry.input_tokens)} />
          <Row label="Output" value={formatTokens(entry.output_tokens)} />
          <Row
            label="Cache R/W"
            value={`${formatTokens(entry.cache_read_tokens)} / ${formatTokens(entry.cache_creation_tokens)}`}
          />
        </div>
      ))}

      {showTotal && (
        <div className="flex items-center justify-between gap-4 border-t border-border-subtle pt-1.5 font-medium">
          <span className="text-text-secondary">{formatTokens(totalTokens(entries))} tokens</span>
          <span className="font-mono tabular text-text-primary">{formatCost(total)}</span>
        </div>
      )}

      {unknown.length > 0 && (
        <div className="flex items-start gap-1.5 pt-0.5 text-2xs text-warning-fg">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span>{unknown.map((e) => e.display).join("、")} 未收录价格，费用未计入</span>
        </div>
      )}
    </div>
  );
}
