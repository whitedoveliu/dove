"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, ClipboardList } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Message } from "@/lib/api";
import { extractSubmittedPlan, planTitle } from "@/lib/plan-mode";

/** 超过这个长度默认折叠（计划通常上千字，全铺开会把消息流顶下去） */
const AUTO_COLLAPSE_LENGTH = 1200;

/** 正文最长高度（展开时内部滚动，避免一份长计划占满整屏） */
const EXPANDED_MAX_HEIGHT = "max-h-[420px]";

export interface PlanCardProps {
  /** 该条 assistant 消息的事件流（从 tool_params / tool_info 里解析 ExitPlanMode 的 plan） */
  events?: Message["events"] | null;
  className?: string;
}

/**
 * PlanCard —— 计划卡片（ExitPlanMode 提交的那份计划）。
 *
 * 内核侧：计划模式下模型不能写任何东西，调研完只能调 ExitPlanMode 把计划交上来，
 * 用户批准后它才开始执行。这张卡把那份计划留在消息流里 —— 标题一眼可见、正文保留换行、
 * 长了能折叠，和交付物卡片（presented-files.tsx）同一个位置、同一套样式。
 *
 * 数据：extractSubmittedPlan(message.events)，不依赖任何新增事件类型，刷新后靠
 * tool_info 还能重建（正文会被截到 300 字符 —— 已知降级，卡片上会标出来）。
 * 解析不到计划时返回 null —— 不显示空卡片，也不抛错。
 */
export function PlanCard({ events, className }: PlanCardProps) {
  const submitted = React.useMemo(() => extractSubmittedPlan(events), [events]);
  /** 用户手动点过就用他的选择；没点过则按长度自动决定 */
  const [override, setOverride] = React.useState<boolean | null>(null);

  if (!submitted) return null;

  const { plan, source } = submitted;
  const expanded = override ?? plan.length <= AUTO_COLLAPSE_LENGTH;
  const title = planTitle(plan);

  return (
    <div className={cn("mt-2 flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5 px-0.5 text-2xs text-text-tertiary">
        <ClipboardList className="size-3.5 shrink-0 text-warning" />
        <span className="shrink-0 font-medium text-text-secondary">计划</span>
        <span className="truncate" title={title}>
          · {title}
        </span>
        <span className="ml-auto shrink-0">
          {source === "info" ? "历史回放 · 可能截断" : `${plan.length} 字`}
        </span>
        <button
          type="button"
          onClick={() => setOverride(!expanded)}
          aria-expanded={expanded}
          className="flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-2xs text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
        >
          {expanded ? "收起" : "展开"}
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      </div>

      {expanded && (
        <div
          className={cn(
            "overflow-y-auto rounded-lg border border-border-default bg-surface-inset px-2.5 py-2",
            EXPANDED_MAX_HEIGHT,
          )}
        >
          {/* 计划是 markdown，但这里不渲染 —— 保留换行的等宽正文，读得清、也不会被
              半成品 markdown 解析搞坏（标题 / 列表 / 代码块都能一眼看懂）。 */}
          <div className="whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-text-secondary">
            {plan}
          </div>
        </div>
      )}
    </div>
  );
}

export default PlanCard;
