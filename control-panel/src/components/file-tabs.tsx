"use client";

import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { fileGlyphFor, glyphToneFor } from "@/lib/file-kinds";

export interface FileTabsProps {
  /** 已打开的文件（项目内相对路径），顺序 = 打开顺序 */
  tabs: string[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  className?: string;
}

/**
 * FileTabs —— 右侧「文件」模块里的一排文件 tab。
 *
 * 行为定死三条（用户明确提过）：
 *  ① 点一个文件开一个 tab，点多个就多个 tab；
 *  ② 当前 tab 高亮，切换 tab 换内容；
 *  ③ 每个 tab 可关（× 按钮，或**在 tab 上**按中键 —— 中键的处理挂在整个 tab 上，
 *     不是只挂在那个 4×4 的 × 上，见下面的 onMouseDown）；
 *     关掉当前 tab 后回到**相邻** tab（右邻优先），
 *     全关完由调用方回到文件树 / 空态（本组件只管把 activePath 传回去）。
 *
 * 键盘：← → 在 tab 间移动（WAI-ARIA tabs 的最小可用集；Home/End 一并支持）。
 * 不做拖拽排序 —— 文件 tab 的生命周期就是「打开到关掉」，排序没有使用场景。
 */
export function FileTabs({ tabs, activePath, onSelect, onClose, className }: FileTabsProps) {
  const listRef = React.useRef<HTMLDivElement>(null);

  const move = (from: number, delta: number) => {
    if (tabs.length === 0) return;
    const next = (from + delta + tabs.length) % tabs.length;
    onSelect(tabs[next]!);
    // 焦点跟着走，连续按方向键才不会掉出 tab 条
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]");
    buttons?.[next]?.focus();
  };

  if (tabs.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="打开的文件"
      className={cn(
        "flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-border-subtle bg-surface-inset px-1",
        className,
      )}
    >
      {tabs.map((path, index) => {
        const active = path === activePath;
        const Glyph = fileGlyphFor(path);
        const name = path.split("/").pop() ?? path;
        return (
          <div
            key={path}
            className={cn(
              "group flex max-w-[13rem] min-w-0 shrink-0 items-center gap-1 rounded-t-sm px-2 text-2xs",
              "border-b-2 transition-colors duration-fast",
              active
                ? "border-accent bg-surface-raised text-text-primary"
                : "border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary",
            )}
            // 中键关闭挂在**整个 tab** 上（不只是那个 4×4 的 × 按钮）：浏览器标签页的
            // 肌肉记忆是整个标签可中键，挂在 × 上等于这条路径形同虚设。
            // 子元素的 mousedown 会冒泡到这里，所以点名字也能中键关。
            onMouseDown={(e) => {
              if (e.button === 1) { e.preventDefault(); onClose(path); }
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={path}
              onClick={() => onSelect(path)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") { e.preventDefault(); move(index, 1); }
                else if (e.key === "ArrowLeft") { e.preventDefault(); move(index, -1); }
                else if (e.key === "Home") { e.preventDefault(); move(0, 0); }
                else if (e.key === "End") { e.preventDefault(); move(tabs.length - 1, 0); }
              }}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 outline-none"
            >
              <Glyph className={cn("size-3.5 shrink-0", glyphToneFor(path))} />
              <span className={cn("truncate", active && "font-medium")}>{name}</span>
            </button>
            <button
              type="button"
              aria-label={`关闭 ${name}`}
              title="关闭"
              onClick={(e) => { e.stopPropagation(); onClose(path); }}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm text-text-tertiary",
                "transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary",
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default FileTabs;
