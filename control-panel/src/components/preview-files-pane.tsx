"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Check, Copy, FileWarning, FolderTree, ImageOff, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatBytes, readProjectFile, type ProjectFileEntry } from "@/lib/api";
import { FileTree } from "@/components/shell/file-tree";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Hint } from "@/components/ui/tooltip";

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "bmp",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

/** 明确按文本渲染的扩展名；不在表里的文件会先读一次再嗅探是否为二进制。 */
const TEXT_EXTENSIONS = new Set([
  "txt", "log", "csv", "tsv", "json", "jsonc", "json5", "yml", "yaml", "toml", "ini", "conf", "cfg", "env",
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
  "css", "scss", "sass", "less", "styl", "html", "htm", "xml", "xsl", "svgz",
  "py", "pyi", "rb", "php", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "sql", "graphql", "gql", "prisma", "proto",
  "lock", "gitignore", "npmrc", "editorconfig", "dockerfile", "makefile", "gradle", "properties",
]);

type FileKind = "image" | "markdown" | "code";

type ViewState =
  | { status: "loading" }
  | { status: "ready"; kind: FileKind; content?: string; size?: number; language?: string | null }
  | { status: "unsupported"; size?: number }
  | { status: "error"; message: string };

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

/** 后端按 UTF-8 读取任意文件，二进制内容会出现大量替换符或 NUL。 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4000);
  if (!sample.length) return false;
  let broken = 0;
  for (const char of sample) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0) return true;
    if (code === 0xfffd) broken += 1;
  }
  return broken / sample.length > 0.02;
}

export interface PreviewFilesPaneProps {
  /** 项目端口；为空时展示空态 */
  port: string | null;
  /** 开发服务器端口（图片资源优先走它） */
  devServerPort?: string | null;
  className?: string;
}

/**
 * PreviewFilesPane — 预览面板的「文件」标签。
 *
 * 上方是项目文件树（只有行尾箭头能展开目录），点击文件后在下方展示内容：
 * 代码用等宽代码块、.md 渲染 markdown、图片直接显示、其余类型给出体积提示。
 */
export function PreviewFilesPane({ port, devServerPort, className }: PreviewFilesPaneProps) {
  const [selected, setSelected] = React.useState<ProjectFileEntry | null>(null);

  // 切换任务时清掉已选文件，避免看到上一个任务的内容
  React.useEffect(() => {
    setSelected(null);
  }, [port]);

  if (!port) {
    return (
      <EmptyState
        className={className}
        icon={<FolderTree />}
        title="尚未选择任务"
        description="在左侧目录面板选择或新建一个任务，这里会显示它的文件。"
      />
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div
        className={cn(
          "min-h-0 overflow-y-auto px-1.5 py-1",
          selected ? "max-h-[42%] shrink-0" : "flex-1"
        )}
      >
        <FileTree
          port={port}
          expandTrigger="chevron"
          activePath={selected?.path ?? null}
          onSelectFile={(entry) => setSelected(entry)}
          emptyState={
            <EmptyState
              compact
              icon={<FolderTree />}
              title="这里还是空的"
              description="让 AI 先生成代码，或新建文件后再回来看看。"
            />
          }
        />
      </div>

      {selected && (
        <>
          <div className="hairline" />
          <FileContentView
            port={port}
            devServerPort={devServerPort}
            entry={selected}
            onClose={() => setSelected(null)}
          />
        </>
      )}
    </div>
  );
}

interface FileContentViewProps {
  port: string;
  devServerPort?: string | null;
  entry: ProjectFileEntry;
  onClose: () => void;
}

function FileContentView({ port, devServerPort, entry, onClose }: FileContentViewProps) {
  const [state, setState] = React.useState<ViewState>({ status: "loading" });
  const [copied, setCopied] = React.useState(false);
  const [imageFailed, setImageFailed] = React.useState(false);

  const ext = extensionOf(entry.name);
  const isImage = IMAGE_EXTENSIONS.has(ext);

  React.useEffect(() => {
    setCopied(false);
    setImageFailed(false);

    if (isImage) {
      setState({ status: "ready", kind: "image", size: entry.size });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await readProjectFile(port, entry.path);
        if (cancelled) return;
        if (!TEXT_EXTENSIONS.has(ext) && !MARKDOWN_EXTENSIONS.has(ext) && looksBinary(res.content)) {
          setState({ status: "unsupported", size: res.size });
          return;
        }
        setState({
          status: "ready",
          kind: MARKDOWN_EXTENSIONS.has(ext) ? "markdown" : "code",
          content: res.content,
          size: res.size,
          language: res.language,
        });
      } catch (e) {
        if (!cancelled) {
          setState({ status: "error", message: e instanceof Error ? e.message : "读取失败" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, entry.path, entry.size, entry.name, ext, isImage]);

  const imageSrc = React.useMemo(() => {
    if (!isImage) return "";
    const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
    if (devServerPort) return `http://${host}:${devServerPort}/${entry.path}`;
    return `http://${host}:8008/preview/${port}/${entry.path}`;
  }, [isImage, devServerPort, entry.path, port]);

  const lineCount = React.useMemo(() => {
    if (state.status !== "ready" || state.kind !== "code" || !state.content) return 0;
    return state.content.split("\n").length;
  }, [state]);

  const copy = async () => {
    if (state.status !== "ready" || state.content === undefined) return;
    await navigator.clipboard?.writeText(state.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const size = state.status === "ready" || state.status === "unsupported" ? state.size : entry.size;
  const copyable = state.status === "ready" && state.content !== undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-raised">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-medium text-text-primary" title={entry.path}>
            {entry.name}
          </p>
          <p className="flex items-center gap-1.5 text-2xs text-text-tertiary">
            <span className="truncate">{entry.path}</span>
            {state.status === "ready" && state.kind === "code" && lineCount > 0 && (
              <span className="shrink-0">· {lineCount} 行</span>
            )}
            {size !== undefined && <span className="shrink-0">· {formatBytes(size)}</span>}
          </p>
        </div>

        <Hint label={copied ? "已复制" : "复制内容"}>
          <IconButton size="sm" aria-label="复制内容" onClick={copy} disabled={!copyable}>
            {copied ? <Check className="text-success" /> : <Copy />}
          </IconButton>
        </Hint>
        <Hint label="关闭">
          <IconButton size="sm" aria-label="关闭文件预览" onClick={onClose}>
            <X />
          </IconButton>
        </Hint>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-text-tertiary">
            <Loader2 className="size-3.5 animate-spin" />
            读取文件…
          </div>
        ) : state.status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-text-secondary">
            <FileWarning className="size-5 text-warning" />
            {state.message}
          </div>
        ) : state.status === "unsupported" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <FileWarning className="size-5 text-text-tertiary" />
            <p className="text-xs font-medium text-text-primary">暂不支持预览这种文件</p>
            <p className="text-2xs text-text-tertiary">
              {entry.name}
              {state.size !== undefined && ` · ${formatBytes(state.size)}`}
            </p>
          </div>
        ) : state.kind === "image" ? (
          <div className="flex h-full items-center justify-center p-4">
            {imageFailed ? (
              <div className="flex flex-col items-center gap-2 text-center">
                <ImageOff className="size-5 text-text-tertiary" />
                <p className="text-xs font-medium text-text-primary">图片暂时无法显示</p>
                <p className="text-2xs text-text-tertiary">
                  {entry.path}
                  {size !== undefined && ` · ${formatBytes(size)}`}
                </p>
              </div>
            ) : (
              <img
                src={imageSrc}
                alt={entry.name}
                onError={() => setImageFailed(true)}
                className="max-h-full max-w-full rounded-sm object-contain"
              />
            )}
          </div>
        ) : state.kind === "markdown" ? (
          <div className="prose px-4 py-3">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
              {state.content ?? ""}
            </ReactMarkdown>
          </div>
        ) : (state.content ?? "").length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary">空文件</div>
        ) : (
          <pre className="whitespace-pre p-3 font-mono text-xs leading-relaxed text-text-primary">
            <code>{state.content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
