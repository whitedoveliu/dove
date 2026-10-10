import * as React from "react";
import { Check, Pause, Play, Target, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { Goal, GoalAction } from "@/lib/api";
import { goalPhaseLabel, goalPhaseVariant } from "@/lib/goal-command";

/**
 * 目标状态条 —— 输入框内左上角那一条（ComposerBox 的 topLeft 插槽）。
 *
 * 内核在目标 active 时**每轮结束自动再开一轮**，所以这里不要"继续跑"的开关，
 * 只需要让用户一眼看到：现在是什么状态、目标是什么、能做什么。
 * 按钮的可用状态由 phase 决定（和 /goal 的子命令一一对应，走的是同一个 apply）：
 *   active         → 暂停 / 完成
 *   paused,blocked → 继续 / 完成
 *   complete       → 清除
 *
 * 刻意**不显示轮次进度**（对齐 DSH 的 GoalBar）：轮次是内核的节流阀，不是用户的进度条；
 * 想看轮次就敲裸 `/goal`，toast 里会带。
 * 颜色全部走 token（Badge 的 variant），没有写死的色值。
 */
export interface GoalBarProps {
  goal: Goal | null;
  /** 点条上的操作 → 调用方的 apply（POST /goal） */
  onAction: (action: GoalAction) => void;
  /** 请求在飞：按钮先禁掉，免得手快点两下打出一对互相打架的请求 */
  pending?: boolean;
  className?: string;
}

export function GoalBar({ goal, onAction, pending, className }: GoalBarProps) {
  if (!goal) return null;

  const reason = (goal.blocked_reason ?? "").trim();
  const tip = reason ? `${goal.objective}\n卡在：${reason}` : goal.objective;

  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md bg-surface-inset px-1.5 py-0.5",
        className,
      )}
    >
      <Target className="size-3 shrink-0 text-text-tertiary" />
      <Badge variant={goalPhaseVariant(goal.phase)} className="shrink-0">
        {goalPhaseLabel(goal.phase)}
      </Badge>
      {/* 一行，超出省略；完整目标放在 title 里（hover 可看） */}
      <span className="min-w-0 flex-1 truncate text-2xs text-text-secondary" title={tip}>
        {goal.objective}
      </span>

      <span className="flex shrink-0 items-center gap-0.5">
        {goal.phase === "active" && (
          <>
            <BarButton
              icon={Pause}
              title="暂停自动推进（已做的都在，随时能继续）"
              disabled={pending}
              onClick={() => onAction("pause")}
            />
            <BarButton
              icon={Check}
              title="标记目标已完成，停止自动推进"
              disabled={pending}
              onClick={() => onAction("complete")}
            />
          </>
        )}

        {(goal.phase === "paused" || goal.phase === "blocked") && (
          <>
            <BarButton
              icon={Play}
              title="继续自动推进（每轮结束后自动再开一轮）"
              disabled={pending}
              onClick={() => onAction("resume")}
            />
            <BarButton
              icon={Check}
              title="标记目标已完成"
              disabled={pending}
              onClick={() => onAction("complete")}
            />
          </>
        )}

        {goal.phase === "complete" && (
          <BarButton
            icon={Trash2}
            title="删掉这条目标记录（完成后再建新目标前先清掉）"
            disabled={pending}
            onClick={() => onAction("clear")}
          />
        )}
      </span>
    </div>
  );
}

/**
 * 状态条上的小按钮 —— **只留图标**（对齐 DSH 的 GoalBar：图标动作 + hover 提示）。
 * 文字标签会把这一条挤得很吵，而且「暂停/完成/继续/清除」看图标就懂；
 * 无障碍用 aria-label 保住，鼠标悬停有 title。
 */
function BarButton({
  icon: Icon, title, disabled, onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-5 items-center justify-center rounded-md text-text-tertiary",
        "transition-colors duration-fast ease-standard",
        "hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent",
      )}
    >
      <Icon className="size-3" />
    </button>
  );
}

export default GoalBar;
