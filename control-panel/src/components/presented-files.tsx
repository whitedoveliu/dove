"use client";

import * as React from "react";
import {
  Braces,
  ChevronDown,
  ChevronUp,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  FileType2,
  Files,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { Message } from "@/lib/api";
import {
  basenameOf,
  extractPresentedFiles,
  fileDescription,
  type PresentedFile,
} from "@/lib/presented-files";

/** 超过这个数量先折叠（内核侧一次 Present 最多 4 个，多轮加起来才会超） */
const COLLAPSED_LIMIT = 4;

/** 图标桶：和 shell/file-tree.tsx 的 FileGlyph 保持同一套字形与色调 */
function glyphFor(path: string): React.ComponentType<{ className?: string }> {
  const name = basenameOf(path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "bmp"].includes(ext)) return FileImage;
  if (ext === "json" || ext === "jsonc" || ext === "json5") return FileJson;
  if (["md", "mdx", "markdown", "txt", "log", "pdf", "doc", "docx"].includes(ext)) return FileText;
  if (["css", "scss", "sass", "less", "html", "htm", "xml", "yml", "yaml"].includes(ext)) return Braces;
  if ([
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte",
    "py", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs",
    "sh", "bash", "zsh", "sql", "toml", "ini",
  ].includes(ext)) return FileCode2;
  return FileType2;
}

export interface PresentedFilesProps {
  /** 该条 assistant 消息的事件流（从 tool_params / tool_info 里解析 Present 的参数） */
  events?: Message["events"] | null;
  /** 点开某个交付物（接到右侧预览面板）；不传时卡片只读、不可点 */
  onOpenFile?: (path: string) => void;
  className?: string;
}

/**
 * PresentedFiles —— 交付物卡片。
 *
 * 内核的 Present 工具只「宣告已存在的文件是交付物」，不复制内容。这里把
 * 本轮声明的文件渲染成消息流里的卡片，点一下在右侧预览面板打开
 * （复用 FilePeek / readProjectFile 那条链）。
 *
 * 位置：跟在同一条消息的工具活动块之后（见 MessageList 的 events 区块）。
 * 数据：extractPresentedFiles(message.events)，不依赖任何新增事件类型，
 *       所以刷新 / 回放时只要有工具事件就能重建。
 * 解析不到任何文件时返回 null —— 不显示空卡片，也不抛错。
 */
export function PresentedFiles({ events, onOpenFile, className }: PresentedFilesProps) {
  const files = React.useMemo(() => extractPresentedFiles(events), [events]);
  const [expanded, setExpanded] = React.useState(false);

  if (files.length === 0) return null;

  const collapsible = files.length > COLLAPSED_LIMIT;
  const visible = collapsible && !expanded ? files.slice(0, COLLAPSED_LIMIT) : files;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5 px-0.5 text-2xs text-text-tertiary">
        <Files className="size-3.5" />
        <span className="font-medium text-text-secondary">交付物</span>
        <span>· {files.length} 个文件</span>
      </div>

      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {visible.map((file) => (
          <PresentedFileCard key={file.path} file={file} onOpen={onOpenFile} />
        ))}
      </div>

      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex h-7 items-center justify-center gap-1 self-start rounded-lg border border-border-default px-2.5 text-2xs text-text-secondary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
        >
          {expanded ? "收起" : `全部 ${files.length} 个文件`}
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      )}
    </div>
  );
}

interface PresentedFileCardProps {
  file: PresentedFile;
  onOpen?: (path: string) => void;
}

function PresentedFileCard({ file, onOpen }: PresentedFileCardProps) {
  const Glyph = glyphFor(file.path);
  const name = basenameOf(file.path);
  const hint = fileDescription(file);

  const body = (
    <>
      <Glyph className="size-4 shrink-0 text-text-tertiary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-text-primary">{name}</span>
        <span className="truncate text-2xs text-text-tertiary">{hint}</span>
      </span>
    </>
  );

  const base =
    "flex min-w-0 items-center gap-2 rounded-lg border border-border-default bg-surface-inset px-2.5 py-2 text-left";

  if (!onOpen) {
    return (
      <div className={base} title={file.path}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      title={file.path}
      aria-label={`预览 ${file.path}`}
      onClick={() => onOpen(file.path)}
      className={cn(
        base,
        "cursor-pointer transition-colors duration-fast hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      )}
    >
      {body}
    </button>
  );
}

export default PresentedFiles;
