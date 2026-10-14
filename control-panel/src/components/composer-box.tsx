import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { ArrowUp, Loader2, Square, Shield, ShieldOff, Eye, ChevronDown, Check } from "lucide-react";
import { SlashMenu, filterSlashCommands, slashQuery, type SlashCommand } from "@/components/slash-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PERM_COPY, usePermissionPresets, presetOf, sandboxOfPreset, useWritableRoots, type PermissionMode, type PermissionPreset } from "@/lib/permission";
import { chooseFolder } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ComposerInput, type ComposerHandle } from "@/components/composer-input";
import { cn } from "@/lib/utils";

/**
 * 输入框（Composer）—— **全应用只有一个实现**
 *
 * 以前新会话页和项目页各写了一份输入框：结构像、样式像、但改动要改两处，
 * 很快就漂移了（发送按钮长得不一样、提示文案一个在占位符里一个在外面）。
 * 现在两处都用这个组件，差异只通过 props 表达。
 *
 * 正文是 `ComposerInput`（contenteditable）而不是 `<textarea>` —— 原因写在
 * composer-input.tsx 顶部：要在文字中间画「引用 chip」，textarea 里放不下任何元素。
 * 这里只留卡片的几何、斜杠菜单和插槽；输入、换行、粘贴、长高都在那边。
 *
 * 插槽：
 *   topLeft      左上角（新会话页放「选择项目」）
 *   leftActions  左下角按钮组（附件 / 权限 / 设置）
 *   chips        左下角状态药丸（已装备的模式，如 Swarm；见 mode-chip.tsx）
 *   hint         左下角提示文字
 *   rightActions 右下角（发送按钮**左边**那块，模型 chip 就在这儿；见 model-chip.tsx）
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
  /** 左下角状态药丸 —— 排在 leftActions **之后**（按钮组保持原位，药丸跟在末尾，像 mnemo 的 progress-chip） */
  chips?: React.ReactNode;
  /** 右下角，发送按钮**左边**（模型 chip）。两个输入框都挂它 */
  rightActions?: React.ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
  /** 发送中（按钮变成「停止」） */
  sending?: boolean;
  onStop?: () => void;
  /** 外层宽度类（新会话页窄、项目页宽） */
  className?: string;
  /** 正文输入区（contenteditable）的额外类 —— 紧凑模式用它把正文撑开 */
  textareaClassName?: string;
  /** 允许输入但禁止发送（比如没选项目） */
  sendDisabled?: boolean;
  sendTitle?: string;
  /** 斜杠命令表；不传则输入框没有 / 菜单 */
  commands?: SlashCommand[];
  /** 选中某条斜杠命令（输入框内容已按 command.insert 替换过） */
  onSlashCommand?: (cmd: SlashCommand) => void;
  /** 剪贴板里贴进来的文件（Cmd+V 一张截图）—— 接到上传通道 */
  onPasteFiles?: (files: File[]) => void;
  /** 给外面用的把手：插入引用 chip（「添加到评论」）、聚焦（React 19 的 ref 就是个普通 prop） */
  ref?: React.Ref<ComposerHandle>;
}

export function ComposerBox({
  value, onChange, onSubmit,
  placeholder = "交给我一件事：查资料、写代码、做分析、跑命令都行…",
  hint = "Enter 发送 · Shift+Enter 换行",
  topLeft, leftActions, chips, rightActions,
  autoFocus, disabled, sending, onStop,
  className, textareaClassName, sendDisabled, sendTitle = "发送",
  commands, onSlashCommand, onPasteFiles, ref,
}: ComposerBoxProps) {
  const canSend = !sendDisabled && !disabled && value.trim().length > 0;

  // ── 输入框高度由 ComposerInput 自己管（它拥有那个 DOM 节点）──
  // （原来是 textarea + 这里的 useLayoutEffect 手动量 scrollHeight，见 composer-input.tsx）

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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // 输入法拼字中：Enter 是确认候选词，不能当成"发送"或"选中菜单项"
    // （ComposerInput 已经先挡了一道，这里再挡一道，防止别处直接调这个 handler）
    if (e.nativeEvent.isComposing) return;
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
        // 输入卡片几何照 mnemo 的 composer-card：22px 圆角 + 看得见的描边 + 15/16/12 内边距
        "flex flex-col overflow-hidden rounded-[22px] border border-border-strong bg-surface-raised px-4 pt-3.5 pb-3 shadow-xs",
        "transition-[border-color,box-shadow] duration-fast ease-standard",
        // 聚焦时**只给描边染一点主题色，不加光圈**（mnemo 就是 `color-mix(accent 45%, line-strong)`）：
        // 之前那圈 4px 的 --shadow-focus 太抢眼，用户明确要求去掉。
        "focus-within:border-[rgb(var(--accent-ring)/0.45)]",
        className,
      )}
    >
      {topLeft && <div className="flex items-center gap-1.5 pb-2.5">{topLeft}</div>}

      <ComposerInput
        ref={ref}
        autoFocus={autoFocus}
        value={value}
        disabled={disabled}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        onPasteFiles={onPasteFiles}
        placeholder={placeholder}
        className={cn(
          // 内边距/高度上限归卡片和组件自己；这里只留插槽调用方能改的部分
          "resize-none rounded-none border-0 bg-transparent shadow-none",
          textareaClassName,
        )}
      />

      <div className="mt-2 flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-1">
          {leftActions}
          {chips}
          <span className="truncate pl-1 text-2xs text-text-tertiary">{hint}</span>
        </div>

        {/* 右下角：模型 chip 紧挨在发送按钮左边（贴右边沿，和发送按钮同一档高度）。
            左边那组是 min-w-0 + 提示文字 truncate，所以窗口窄时先挤提示，chip 不会被压没。 */}
        <div className="flex shrink-0 items-center gap-2">
          {rightActions}
          <SendButton sending={sending} onSend={onSubmit} onStop={onStop} disabled={!canSend} title={sendTitle} />
        </div>
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
        className="flex size-[38px] shrink-0 items-center justify-center rounded-full border-0 bg-danger text-white shadow-sm transition-colors hover:bg-danger-hover"
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
        className="flex size-[38px] shrink-0 items-center justify-center rounded-full border-0 bg-[rgb(var(--nb-200))] text-white shadow-sm dark:bg-[rgb(var(--nb-750))]"
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
        "flex size-[38px] shrink-0 items-center justify-center rounded-full border-0 shadow-sm transition-colors",
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
  value, onChange, disabled, surface = "session", projectKey,
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
  /**
   * 当前项目（端口 / id / 目录名）—— 给了才会显示「额外可写目录」那一节。
   * 它写的是**线程 metadata**，所以没有线程（新会话页）时不给这个 prop。
   */
  projectKey?: string | null;
}) {
  const { presets } = usePermissionPresets();
  const [pending, setPending] = useState<PermissionPreset | null>(null);
  const copy = PERM_COPY[surface];
  const cur = presetOf(presets, value);
  const dangerous = value === "danger-full-access";
  const Icon = dangerous ? ShieldOff : value === "read-only" ? Eye : Shield;
  const sandbox = sandboxOfPreset(cur, value);
  const writable = useWritableRoots(projectKey);

  /** 要确认的预设先过闸（B2）—— 比如完全权限 */
  const choose = (p: PermissionPreset) => {
    if (p.requiresConfirm && p.value !== value) { setPending(p); return; }
    onChange(p.value);
  };

  /** 加一个可写目录：走系统原生选择框（内核侧 /api/projects/pick-folder） */
  const pickRoot = async () => {
    const picked = await chooseFolder();
    if (picked?.success && picked.path) await writable.add(picked.path);
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
              "flex h-7 items-center gap-1 rounded-full border border-border-default bg-surface-inset px-2.5 text-2xs transition-colors disabled:opacity-40",
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
          {/* 额外可写目录（沙箱轴的一部分）—— 只在「工作区内修改」下有意义：
              写这些目录不再弹审批；完全权限下本来就全放行，显示它只会让人误以为还有边界。 */}
          {projectKey && sandbox === "workspace-write" && (
            <div className="mt-1 border-t border-border-default px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs text-text-tertiary">额外可写目录（工作区之外）</span>
                <button
                  type="button"
                  onClick={() => void pickRoot()}
                  className="rounded px-1.5 py-0.5 text-2xs text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                >
                  + 添加文件夹
                </button>
              </div>
              {writable.roots.length === 0 ? (
                <div className="mt-1 text-2xs text-text-tertiary">没有。写工作区外的文件会先问你一次。</div>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {writable.roots.map((r) => (
                    <li key={r} className="flex items-center gap-1 text-2xs text-text-secondary">
                      <span className="min-w-0 flex-1 truncate" title={r}>{r}</span>
                      <button
                        type="button"
                        aria-label={"移除 " + r}
                        onClick={() => void writable.remove(r)}
                        className="rounded px-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
