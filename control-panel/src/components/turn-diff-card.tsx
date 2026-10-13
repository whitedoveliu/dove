"use client";

import * as React from "react";
import { FileText, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";
import type { TurnDiff } from "@/lib/api";

/** diff 正文展开后的最大高度（内部滚动 —— 20k 字符铺开会把消息流顶下去） */
const DIFF_MAX_HEIGHT = "max-h-[320px]";

export interface TurnDiffCardProps {
  /** 内核 turn_diff 事件（本轮净 diff）——由 ChatPanel 挂在 assistant 消息上 */
  turnDiff: TurnDiff;
  className?: string;
}

/**
 * TurnDiffCard —— 本轮改动的 **diff 正文**（可展开）。
 *
 * 职责分工（两块都挂在同一条消息下，用户说过「同一份清单渲染两遍」）：
 *   · **清单归 TurnFilesCard**（`turn-files-card.tsx`）：路径、新建/删除、增删行数，
 *     可点开右侧文件模块，刷新后靠持久化的 turn_files 还在；
 *   · **正文归本组件**：只画这团 diff 文本。
 * 所以这里**不再重复列一遍文件**，没有 diff 正文时直接返回 null ——
 * 内核只发文件条目、没发正文的那种帧就只剩 TurnFilesCard 那一块。
 *
 * 数据边界（写在界面上也说清楚）：只覆盖工具**自报**的写操作（Write/Edit），
 * Bash 里的 `> f` / `sed -i` 之类看不见 —— 见内核 tools/turn-diff.ts。
 *
 * diff 正文默认收起（20k 字符铺满屏没有意义）：先给出「有正文」这个事实，
 * 要点开逐行看再展开。
 */
export function TurnDiffCard({ turnDiff, className }: TurnDiffCardProps) {
  const [expanded, setExpanded] = React.useState(false);

  const diffText = (turnDiff.diff ?? "").trim();
  if (diffText.length === 0) return null;

  return (
    <div className={cn("mt-2 flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5 px-0.5 text-2xs text-text-tertiary">
        <FileText className="size-3.5 shrink-0 text-accent" />
        <span className="shrink-0 font-medium text-text-secondary">改动正文</span>
        {turnDiff.truncated && <span className="shrink-0">· 内容被截断</span>}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="ml-auto flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-2xs text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
        >
          {expanded ? "收起 diff" : "展开 diff"}
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      </div>

      {expanded && (
        <div className={cn("overflow-auto rounded-lg border border-border-default bg-surface-inset px-2.5 py-2", DIFF_MAX_HEIGHT)}>
          {/* 近似统一 diff —— 保留换行的等宽正文（不渲染 markdown：那是 diff，不是 markdown） */}
          <pre className="whitespace-pre font-mono text-2xs leading-relaxed text-text-secondary">{diffText}</pre>
        </div>
      )}
    </div>
  );
}

export default TurnDiffCard;
