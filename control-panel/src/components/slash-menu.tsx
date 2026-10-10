import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 斜杠命令菜单（Composer 用）
 *
 * 只有「第一行、以 / 开头、还没打空格」时才进入命令模式 ——
 * 一旦用户开始写正文（出现空格/换行），菜单就该消失，否则会挡着正常输入。
 * 这里只做「匹配 + 展示 + 键盘导航」，命令具体干什么由调用方决定。
 */
export interface SlashCommand {
  /** 命令名，不含斜杠，如 "plan" */
  name: string;
  /** 菜单里的标题 */
  title: string;
  /** 一行说明 */
  description?: string;
  /** 右侧灰字（可选，比如「Enter 执行」） */
  hint?: string;
  /** 关键字，用于额外匹配（拼音/英文别名） */
  keywords?: string[];
  /**
   * 选中后填进输入框的内容；默认空串（清空）。
   * 需要继续输入参数的命令写 "/goal "。
   */
  insert?: string;
}

/** 判断当前输入是否处于命令模式，并取出查询词 */
export function slashQuery(value: string): { open: boolean; query: string } {
  const m = /^\/([^\s/]*)$/.exec(value);
  if (!m) return { open: false, query: "" };
  return { open: true, query: (m[1] ?? "").toLowerCase() };
}

/** 过滤 + 排序：名字前缀命中优先，其次关键字/说明包含 */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands;
  const scored: { c: SlashCommand; s: number }[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    let s = 0;
    if (name === query) s = 100;
    else if (name.startsWith(query)) s = 60;
    else if (name.includes(query)) s = 30;
    else if ((c.keywords ?? []).some((k) => k.toLowerCase().includes(query))) s = 20;
    else if (c.title.toLowerCase().includes(query) || (c.description ?? "").toLowerCase().includes(query)) s = 10;
    if (s > 0) scored.push({ c, s });
  }
  return scored.sort((a, b) => b.s - a.s).map((x) => x.c);
}

export function SlashMenu({
  commands, activeIndex, onHover, onPick, className,
}: {
  commands: SlashCommand[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (cmd: SlashCommand) => void;
  className?: string;
}) {
  if (commands.length === 0) return null;
  return (
    <div
      role="listbox"
      className={cn(
        "absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-xl",
        "border border-border-default bg-surface-raised p-1 shadow-lg",
        className,
      )}
    >
      <div className="px-2 py-1 text-2xs text-text-tertiary">命令</div>
      <div className="max-h-64 overflow-y-auto">
        {commands.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(c); }}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
              i === activeIndex ? "bg-surface-hover" : "hover:bg-surface-hover",
            )}
          >
            <span className="mt-px shrink-0 font-mono text-xs text-accent">/{c.name}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-text-primary">{c.title}</span>
              {c.description && (
                <span className="block truncate text-2xs text-text-tertiary">{c.description}</span>
              )}
            </span>
            {c.hint && <span className="mt-px shrink-0 text-2xs text-text-tertiary">{c.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
