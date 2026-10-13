"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Files } from "lucide-react";

import { cn } from "@/lib/utils";
import type { TurnDiff, TurnDiffFile } from "@/lib/api";
import { fileGlyphFor, glyphToneFor, kindLabel, fileKind } from "@/lib/file-kinds";
import { FileOpenMenu } from "@/components/file-open-menu";

/** 超过这个数量先折叠（一轮改十几个文件时不要把消息流顶走） */
const COLLAPSED_LIMIT = 6;

export interface TurnFilesCardProps {
  /**
   * 本轮的**文件清单**。取值顺序（前者优先）：
   *   ① `turnFiles` —— 从 /api/history 回填的持久化数据（刷新后还在的那份）；
   *   ② `turnDiff.files` —— 实时 SSE 的 turn_diff。
   */
  turnFiles?: TurnDiffFile[] | null;
  turnDiff?: TurnDiff | null;
  /** 点文件 → 在右侧「文件」模块以 tab 打开（不传 = 整行只读、不可点） */
  onOpenFile?: (path: string) => void;
  /** 项目端口（行尾「打开方式」菜单用；不传就只有「在右侧打开」这一条路） */
  port?: string | null;
  className?: string;
}

/** 从一条消息上取出「这一轮的文件」，两个来源都认（没有则空数组） */
export function turnFilesOf(message: { turn_files?: TurnDiffFile[]; turn_diff?: TurnDiff }): TurnDiffFile[] {
  if (message.turn_files && message.turn_files.length > 0) return message.turn_files;
  return message.turn_diff?.files ?? [];
}

/**
 * TurnFilesCard —— 「这一轮创建/修改了哪些文件」，渲染在助手消息下方（回末）。
 *
 * 数据来源两条（面板侧的统一口径，见 lib/api.ts 的 Message.turn_files 注释）：
 *   实时：SSE 的 turn_diff 事件（ChatPanel 落到 message.turn_diff / turn_files）
 *   刷新后：/api/history 回填的 `turn_files`（兼容层把 turn_diff 按消息 id 落盘了，
 *           见 harness/packages/server/src/legacy/turn-files-store.ts）
 * 两条都没有 = 这一轮**没有自报的文件改动**（只读一轮）→ 组件返回 null，不渲染空块。
 *
 * 每行：类型图标 + 文件名 + 类型标签 + 新建/修改/删除 + 增删行数；
 * 点击整行 = 在右侧文件模块打开（用户明确要求的默认行为，不弹任何对话框）。
 * 行尾「…」是统一的那套打开方式（系统应用 / 文件管理器 / 复制路径 / 下载 / 新窗口）。
 *
 * ⚠️ 数据边界照抄内核：只覆盖 Write/Edit **自报**的改动，
 * Bash 里的 `> f` / `sed -i` 看不见（见 core/tools/turn-diff.ts）。
 */
export function TurnFilesCard({ turnFiles, turnDiff, onOpenFile, port, className }: TurnFilesCardProps) {
  const [expanded, setExpanded] = React.useState(false);

  const files = React.useMemo<TurnDiffFile[]>(
    () => (turnFiles && turnFiles.length > 0 ? turnFiles : (turnDiff?.files ?? [])),
    [turnFiles, turnDiff],
  );

  if (files.length === 0) return null;

  const created = files.filter((f) => f.created && !f.deleted).length;
  const deleted = files.filter((f) => f.deleted).length;
  const modified = files.length - created - deleted;
  const added = files.reduce((n, f) => n + (f.added || 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
  const collapsible = files.length > COLLAPSED_LIMIT;
  const visible = collapsible && !expanded ? files.slice(0, COLLAPSED_LIMIT) : files;

  return (
    <div className={cn("mt-2 flex flex-col gap-1", className)}>
      <div className="flex items-center gap-1.5 px-0.5 text-2xs text-text-tertiary">
        <Files className="size-3.5 shrink-0 text-accent" />
        <span className="shrink-0 font-medium text-text-secondary">本轮文件</span>
        <span className="shrink-0">· {files.length} 个</span>
        {created > 0 && <span className="shrink-0 text-success">新建 {created}</span>}
        {modified > 0 && <span className="shrink-0">修改 {modified}</span>}
        {deleted > 0 && <span className="shrink-0 text-danger">删除 {deleted}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span className="text-success">+{added}</span>
          <span className="text-danger">−{removed}</span>
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-border-default bg-surface-inset">
        {visible.map((file) => (
          <TurnFileRow key={file.path} file={file} onOpenFile={onOpenFile} port={port} />
        ))}
      </div>

      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex h-6 items-center justify-center gap-1 self-start rounded-md border border-border-default px-2 text-2xs text-text-secondary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
        >
          {expanded ? "收起" : `其余 ${files.length - COLLAPSED_LIMIT} 个文件`}
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      )}
    </div>
  );
}

function TurnFileRow({
  file, onOpenFile, port,
}: { file: TurnDiffFile; onOpenFile?: (path: string) => void; port?: string | null }) {
  const Glyph = fileGlyphFor(file.path);
  const kind = fileKind(file.path);
  // 已删除的文件没有内容可开 —— 行不可点，说清为什么
  const openable = !file.deleted && !!onOpenFile;
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, Math.max(0, file.path.length - name.length - 1));

  const body = (
    <>
      <Glyph className={cn("size-3.5 shrink-0", glyphToneFor(file.path))} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className={cn("truncate text-xs", file.deleted ? "text-text-tertiary line-through" : "text-text-primary")}>
          {name}
        </span>
        {dir && <span className="hidden min-w-0 truncate font-mono text-2xs text-text-tertiary sm:inline">{dir}/</span>}
      </span>
      <span className="shrink-0 text-2xs text-text-tertiary">{kindLabel(kind)}</span>
      {file.created && !file.deleted && <span className="shrink-0 rounded bg-success-subtle px-1 text-2xs text-success-fg">新建</span>}
      {file.deleted && <span className="shrink-0 rounded bg-danger-subtle px-1 text-2xs text-danger-fg">删除</span>}
      {!file.created && !file.deleted && <span className="shrink-0 rounded bg-surface-hover px-1 text-2xs text-text-tertiary">修改</span>}
      {file.added > 0 && <span className="shrink-0 font-mono text-2xs text-success">+{file.added}</span>}
      {file.removed > 0 && <span className="shrink-0 font-mono text-2xs text-danger">−{file.removed}</span>}
    </>
  );

  return (
    <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-1.5 last:border-b-0 hover:bg-surface-hover">
      {openable ? (
        <button
          type="button"
          onClick={() => onOpenFile!(file.path)}
          title={`${file.path} —— 点击在右侧文件模块打开`}
          aria-label={`在右侧打开 ${file.path}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2" title={file.deleted ? `${file.path}（已删除，没有内容可打开）` : file.path}>
          {body}
        </div>
      )}
      {!file.deleted && <FileOpenMenu port={port ?? null} path={file.path} kind={kind} onPreview={onOpenFile} />}
    </div>
  );
}

export default TurnFilesCard;
