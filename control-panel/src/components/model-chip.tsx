import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { modelChoices, modelDisplay } from "@/lib/models";

/**
 * 模型 chip —— 输入框**右下角**那颗（发送按钮左边），全应用只有一个实现。
 *
 * 以前模型藏在左下角的设置浮层里：要用一次得先点齿轮、再点模型，而且那颗齿轮
 * 还兼着一堆别的开关。现在它回到「发送前最后一眼会看的地方」——
 * 显示名 + 一个 chevron，点开就是模型表（形态照 DSH / codex 的 composer 右下角 chip）。
 *
 * 纪律：**不持有状态**。当前模型由调用方给（ChatPanel 的 settings.model），
 * 选中后由调用方负责持久化（内核 /api/settings/model）—— chip 自己只画不记，
 * 否则界面和内核会出现两份「当前模型」。
 */
export interface ModelChipProps {
  /** 内核认的模型 id（原样进 POST /api/chat 的 body.model） */
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** 正在写设置（保存到内核）：把 chevron 换成转圈 */
  saving?: boolean;
  className?: string;
}

export function ModelChip({ value, onChange, disabled, saving, className }: ModelChipProps) {
  const [open, setOpen] = React.useState(false);
  const options = modelChoices(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="选择模型"
          title={`模型：${modelDisplay(value)}（点击切换）`}
          className={cn(
            // 和左下角的权限药丸同一档几何（h-7 / 圆角 / 描边），一左一右看着是一套
            "flex h-7 max-w-[13rem] items-center gap-1 rounded-full border border-border-default bg-surface-inset px-2.5 text-2xs",
            "text-text-secondary transition-colors duration-fast",
            "hover:bg-surface-hover hover:text-text-primary disabled:opacity-40",
            open && "bg-surface-hover text-text-primary",
            className,
          )}
        >
          <span className="truncate">{modelDisplay(value)}</span>
          {saving ? <Spinner size={11} className="shrink-0" label="保存模型" /> : <ChevronDown className="size-3 shrink-0 opacity-60" />}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" side="top" className="w-56 rounded-[14px] border-border-strong p-1.5">
        {options.map((id) => {
          const current = id === value;
          return (
            <button
              key={id}
              type="button"
              title={id}
              onClick={() => {
                setOpen(false);
                if (!current) onChange(id);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-[10px] px-2.5 py-[7px] text-left text-xs transition-colors duration-fast hover:bg-surface-hover",
                current ? "text-text-primary" : "text-text-secondary",
              )}
            >
              {/* 勾位**所有项都占**（不画勾也留格），否则标题列会随选中项左右跳 */}
              <span className="flex size-3.5 shrink-0 items-center justify-center text-[rgb(var(--accent))]">
                {current && <Check className="size-3.5" strokeWidth={2.5} />}
              </span>
              <span className="truncate">{modelDisplay(id)}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
