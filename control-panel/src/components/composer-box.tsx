import * as React from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2, Square, Shield, ShieldOff, Eye, ChevronDown, Check } from "lucide-react";
import { SlashMenu, filterSlashCommands, slashQuery, type SlashCommand } from "@/components/slash-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PERM_COPY, usePermissionPresets, presetOf, type PermissionMode, type PermissionPreset } from "@/lib/permission";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * 输入框（Composer）—— **全应用只有一个实现**
 *
 * 以前新会话页和项目页各写了一份输入框：结构像、样式像、但改动要改两处，
 * 很快就漂移了（发送按钮长得不一样、提示文案一个在占位符里一个在外面）。
 * 现在两处都用这个组件，差异只通过 props 表达。
 *
 * 插槽：
 *   topLeft      左上角（新会话页放「选择项目」）
 *   leftActions  左下角按钮组（附件 / 权限 / 设置）
 *   hint         左下角提示文字
 */
export interface ComposerBoxProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** 占位符。定位是「通用 agent」——见下面的默认文案 */
  placeholder?: string;
  /** 左下角提示（默认 Enter 发送 / Shift+Enter 换行） */
  hint?: string;
  /** 左上角插槽 */
  topLeft?: React.ReactNode;
  /** 左下角按钮组 */
  leftActions?: React.ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
  /** 发送中（按钮变成「停止」） */
  sending?: boolean;
  onStop?: () => void;
  /** 外层宽度类（新会话页窄、项目页宽） */
  className?: string;
  textareaClassName?: string;
  /** 允许输入但禁止发送（比如没选项目） */
  sendDisabled?: boolean;
  sendTitle?: string;
  /** 斜杠命令表；不传则输入框没有 / 菜单 */
  commands?: SlashCommand[];
  /** 选中某条斜杠命令（输入框内容已按 command.insert 替换过） */
  onSlashCommand?: (cmd: SlashCommand) => void;
}

export function ComposerBox({
  value, onChange, onSubmit,
  placeholder = "交给我一件事：查资料、写代码、做分析、跑命令都行…",
  hint = "Enter 发送 · Shift+Enter 换行",
  topLeft, leftActions,
  autoFocus, disabled, sending, onStop,
  className, textareaClassName, sendDisabled, sendTitle = "发送",
  commands, onSlashCommand,
}: ComposerBoxProps) {
  const canSend = !sendDisabled && !disabled && value.trim().length > 0;

  // ── 输入框高度：默认**一行**，内容换行时往上长（对齐 DSH / codex）──────
  // textarea 自己不会长高，只会内部滚动；这里每轮先把 height 归零再按
  // scrollHeight 设回去（归零是为了让删字时也能缩回来），到 MAX 就交给内部滚动。
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const MAX = 220;                  // 和 className 里的 max-h-[220px] 对齐
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX) + "px";
  }, [value]);

  // ── 斜杠命令 ────────────────────────────────────────────
  // 只在「第一行、/ 开头、还没打空格」时进入命令模式（见 slashQuery）。
  const sq = useMemo(() => slashQuery(value), [value]);
  const matches = useMemo(
    () => (sq.open && commands ? filterSlashCommands(commands, sq.query) : []),
    [sq.open, sq.query, commands],
  );
  const menuOpen = sq.open && matches.length > 0 && !disabled;
  const [activeIndex, setActiveIndex] = useState(0);
  // 查询词变了就把高亮拉回第一条（否则会出现"高亮停在越界位置"）
  useEffect(() => { setActiveIndex(0); }, [sq.query, menuOpen]);

  const pick = (cmd: SlashCommand) => {
    onChange(cmd.insert ?? "");
    onSlashCommand?.(cmd);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => (i + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const cmd = matches[activeIndex];
        if (cmd) { if (e.key === "Enter" && !cmd.insert) pick(cmd); else pick(cmd); }
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); onChange(""); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSubmit();
    }
  };

  return (
    <div className="relative">
      {/* 斜杠菜单浮在输入框**上方**（不把输入框挤下去）—— 对齐 DSH 的 MenuView：
          absolute + bottom:100% + 高 z-index。⚠️ 外层任何祖先都不能有 overflow-hidden，
          否则菜单会被裁成半行（新会话页那张卡片就栽过这个，已在那边去掉）。 */}
      {menuOpen && (
        <SlashMenu
          commands={matches}
          activeIndex={Math.min(activeIndex, matches.length - 1)}
          onHover={setActiveIndex}
          onPick={pick}
          className="z-[100] w-full max-w-none"
        />
      )}
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border border-border-default bg-surface-raised shadow-xs",
        "transition-[border-color,box-shadow] duration-fast ease-standard",
        "focus-within:border-accent-ring focus-within:shadow-focus",
        className,
      )}
    >
      {topLeft && <div className="flex items-center gap-1.5 px-2.5 pt-2">{topLeft}</div>}

      <Textarea
        ref={taRef}
        rows={1}
        autoFocus={autoFocus}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          // rows=1 → 空的时候就是一行（py-2 + 一行文字 ≈ 36px）；
          // 超过 max-h 之后不再长高，改为内部滚动（见上面的 useLayoutEffect）
          "min-h-9 max-h-[220px] resize-none rounded-none border-0 bg-transparent text-sm shadow-none",
          "focus-visible:border-transparent focus-visible:ring-0",
          textareaClassName,
        )}
      />

      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-1">
          {leftActions}
          <span className="truncate pl-1 text-2xs text-text-tertiary">{hint}</span>
        </div>

        <SendButton sending={sending} onSend={onSubmit} onStop={onStop} disabled={!canSend} title={sendTitle} />
      </div>
    </div>
    </div>
  );
}

/**
 * 发送 / 停止按钮 —— **全应用唯一一份**。
 *
 * 以前两个输入框各写了一份：新会话页是圆形 accent + ArrowUp，
 * 项目页是方形 rounded-lg + Send，长得不一样。统一到这里。
 */
export function SendButton({
  sending, onSend, onStop, disabled, title,
}: {
  sending?: boolean;
  onSend: () => void;
  onStop?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  if (sending && onStop) {
    return (
      <button
        type="button"
        onClick={onStop}
        title="停止"
        className="flex size-9 shrink-0 items-center justify-center rounded-full border-0 bg-danger text-white shadow-sm transition-colors hover:bg-danger-hover"
      >
        <Square className="size-3.5" fill="currentColor" />
      </button>
    );
  }
  if (sending) {
    return (
      <button
        type="button"
        disabled
        title="生成中"
        className="flex size-9 shrink-0 items-center justify-center rounded-full border-0 bg-[rgb(var(--nb-200))] text-white shadow-sm dark:bg-[rgb(var(--nb-750))]"
      >
        <Loader2 className="size-4 animate-spin" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSend}
      disabled={disabled}
      title={title ?? "发送 (Enter)"}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full border-0 shadow-sm transition-colors",
        "bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))]",
        "disabled:bg-[rgb(var(--nb-200))] disabled:text-white dark:disabled:bg-[rgb(var(--nb-750))]",
      )}
    >
      <ArrowUp className="size-4" strokeWidth={2.5} />
    </button>
  );
}

/**
 * 权限选择器（受控组件）—— 两处输入框共用。
 *
 * 新会话页和项目页的数据来源不同（一个是「新项目的默认值」，
 * 一个是「当前项目的值」），所以这里只做受控 UI，取值/存值交给调用方。
 */
export function PermissionSelect({
  value, onChange, disabled, surface = "session",
}: {
  value: PermissionMode;
  onChange: (m: PermissionMode) => void;
  disabled?: boolean;
  /**
   * 哪个界面的选择器（B3）—— **同样的档位，不同的语义**：
   *   session  会话内：改的是「当前这次对话」
   *   defaults 新会话页：改的是「下一个项目的默认值」
   * 用同一份文案会让用户以为改的是同一个东西（上一轮就踩了这个）。
   */
  surface?: "session" | "defaults";
}) {
  const { presets } = usePermissionPresets();
  const [pending, setPending] = useState<PermissionPreset | null>(null);
  const copy = PERM_COPY[surface];
  const cur = presetOf(presets, value);
  const dangerous = value === "danger-full-access";
  const Icon = dangerous ? ShieldOff : value === "read-only" ? Eye : Shield;

  /** 要确认的预设先过闸（B2）—— 比如完全权限 */
  const choose = (p: PermissionPreset) => {
    if (p.requiresConfirm && p.value !== value) { setPending(p); return; }
    onChange(p.value);
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            title={copy.title}
            className={cn(
              "flex h-7 items-center gap-1 rounded-full px-2 text-2xs transition-colors disabled:opacity-40",
              // 颜色只用中性色（不要黄色）：危险档靠图标（ShieldOff）区分，不靠颜色喊
              dangerous
                ? "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-3" />
            <span>{cur?.label ?? value}</span>
            <ChevronDown className="size-2.5 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1">
          {/* 两组文案的差别就体现在这一行 */}
          <div className="px-2 py-1.5 text-2xs text-text-tertiary">{copy.hint}</div>
          {presets.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => choose(p)}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-hover"
            >
              <span className="mt-0.5 w-3 shrink-0">
                {value === p.value && <Check className="size-3 text-success" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-text-primary">{p.label}</span>
                  {p.experimental && (
                    <span className="rounded bg-warning/20 px-1 text-2xs font-medium text-warning">EXP</span>
                  )}
                </span>
                <span className="block text-2xs text-text-tertiary">{p.description}</span>
              </span>
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* 确认闸（B2）：切到完全权限这类档位，先让用户明确知道风险 */}
      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o) setPending(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认启用{pending?.label}？</DialogTitle>
            <DialogDescription className="space-y-2 pt-2 text-xs leading-relaxed">
              <span className="block">
                启用后，{surface === "session" ? "智能体" : "新会话"}将减少确认步骤，
                并能直接执行更多操作，包括敏感操作、文件修改或外部命令。
                仅建议在你信任{surface === "session" ? "当前任务" : "后续任务"}时使用。
              </span>
              <span className="block text-text-tertiary">{pending?.description}</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>取消</Button>
            <Button
              size="sm"
              onClick={() => { if (pending) onChange(pending.value); setPending(null); }}
            >
              我已了解风险，并愿意继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
