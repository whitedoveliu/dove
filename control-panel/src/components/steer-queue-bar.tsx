"use client";

import { CornerDownRight, ListTodo, Loader2, Trash2 } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import type { QueuedMessage } from "@/lib/steer-queue";

/**
 * 运行中的待发送队列 —— 输入框**上方**那一小条（对齐 DSH / Codex 的待办列表观感：
 * 紧凑行、正文单行截断、右侧两个图标按钮）。
 *
 * 每行两个动作，语义刻意分开：
 *   删除(Trash2)      只从队列里拿掉，什么都不发
 *   插话(CornerDownRight) 不等回合结束，下一步就折进当前回合（steerMessage）
 *
 * canSteer=false（当前没有在跑的回合）时插话按钮禁用 —— 那种情况下内核的
 * steering 队列没人读，消息会一直躺在里面。
 */
export interface SteerQueueBarProps {
  items: QueuedMessage[];
  onRemove: (id: string) => void;
  onSteer: (item: QueuedMessage) => void;
  /** 有回合在跑才允许插话 */
  canSteer: boolean;
  /** 正在插话的那条：显示 spinner，并挡住重复点击 */
  steeringId?: string | null;
  className?: string;
}

export function SteerQueueBar({ items, onRemove, onSteer, canSteer, steeringId, className }: SteerQueueBarProps) {
  // 空队列不占位置（调用方不用自己判断）
  if (items.length === 0) return null;

  return (
    <div className={cn("mb-1.5 overflow-hidden rounded-xl border border-border-default bg-surface-raised", className)}>
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-2xs text-text-tertiary">
        <ListTodo className="size-3" />
        <span>待发送 {items.length} 条</span>
        <span className="min-w-0 flex-1 truncate text-right">回合结束后自动发下一条</span>
      </div>

      {/* 超过 3 条就滚动（按每行 ~28px 算），再多也不会把输入框顶出屏幕 */}
      <div className={cn("px-1 pb-1", items.length > 3 && "max-h-[104px] overflow-y-auto")}>
        {items.map((item) => {
          const steering = steeringId === item.id;
          return (
            <div
              key={item.id}
              className="group flex items-center gap-1 rounded-lg px-1.5 py-0.5 hover:bg-surface-hover"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={item.text}>
                {item.text}
              </span>
              <IconButton
                size="xs"
                tone="neutral"
                aria-label="从队列删除"
                title="从队列删除"
                disabled={steering}
                onClick={() => onRemove(item.id)}
                className="opacity-60 group-hover:opacity-100"
              >
                <Trash2 />
              </IconButton>
              <IconButton
                size="xs"
                tone="accent"
                aria-label="插话（下一步生效）"
                title={canSteer ? "插话：下一步生效，不用等回合结束" : "当前没有在跑的回合"}
                disabled={!canSteer || steering}
                onClick={() => onSteer(item)}
                className="opacity-60 group-hover:opacity-100"
              >
                {steering ? <Loader2 className="animate-spin" /> : <CornerDownRight />}
              </IconButton>
            </div>
          );
        })}
      </div>
    </div>
  );
}
