import * as React from "react";
import { useState } from "react";
import { Plus, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * 输入框的「+」菜单 —— **全应用只有一个实现**（起始页 / 项目页共用）。
 *
 * 定位：`/` 斜杠菜单是**全集**（所有能力都能唤醒），`+` 是**精选**——
 * 只放「这次要往消息里加什么」那几件：文件 / 截屏 / 目标 / 计划 / Swarm。
 *
 * 几何与排版照 mnemo 的 composer plus-menu：288px 宽、6px 内边距、
 * item 9·10 内边距 + 10px 圆角、标题 13px、说明 12px 灰、勾用主题色。
 *
 * 纪律：这里**只做入口，不持有状态**。`on` 由调用方从真实状态派生
 * （计划模式在线程 metadata 上、目标在 goal 表里），不另开一份本地变量 ——
 * mnemo 那个「模型已经退出计划模式、勾还亮着」的坑就是这么来的。
 */
export interface PlusMenuItem {
  key: string;
  /** 主文案，如「文件」 */
  label: string;
  /** 一行说明，如「上传图片（进对话）或文本（作为引用）」 */
  hint: string;
  icon: React.ReactNode;
  /** 勾选态。只有 toggle 类项传；undefined = 纯动作项，不渲染勾位 */
  on?: boolean;
  onSelect: () => void;
}

export interface ComposerPlusMenuProps {
  items: PlusMenuItem[];
  disabled?: boolean;
  /** 打开菜单时的无障碍名 */
  title?: string;
}

export function ComposerPlusMenu({ items, disabled, title = "更多" }: ComposerPlusMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={title}
          aria-label={title}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong",
            "text-text-secondary transition-colors duration-fast",
            "hover:bg-surface-hover hover:text-text-primary disabled:opacity-40",
            open && "bg-surface-hover text-text-primary",
          )}
        >
          <Plus className="size-4" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        className="w-72 rounded-[14px] border-border-strong p-1.5 shadow-[0_12px_32px_rgba(18,20,26,0.14)]"
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              setOpen(false);
              item.onSelect();
            }}
            className="flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-[9px] text-left transition-colors duration-fast hover:bg-surface-hover"
          >
            {/* 勾位：**所有项都留这一格**（14px）——只有 toggle 项会画勾，
                但纯动作项也占位，否则标题/说明会左移、整列对不齐（真机截图里就是这个毛病） */}
            <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center text-[rgb(var(--accent))]">
              {item.on === true && <Check className="size-3.5" strokeWidth={2.5} />}
            </span>

            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-text-tertiary">
              {item.icon}
            </span>

            <span className="flex min-w-0 flex-col gap-0.5">
              <b className="text-[13px] font-semibold text-text-primary">{item.label}</b>
              <i className="text-xs not-italic text-text-tertiary">{item.hint}</i>
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
