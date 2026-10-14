"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  Code, Eye, FileWarning, ImageOff, Loader2, Maximize2, RotateCcw, TriangleAlert, X, ZoomIn, ZoomOut,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { ensureLocalToken, formatBytes, getLocalTokenCached, readProjectFile, statProjectFile } from "@/lib/api";
import { normalizeLanguage, usePrismTheme } from "@/lib/highlight";
import { projectAssetUrl, projectFileUrl } from "@/lib/preview-url";
import {
  SAMPLE_LIMIT_BYTES, SERVER_READ_LIMIT_BYTES, TABLE_MAX_COLS, TABLE_MAX_ROWS,
  codeLanguage, fileGlyphFor, fileKind, glyphToneFor, isAudio, isSvg, isTextual,
  kindLabel, type FileKind,
} from "@/lib/file-kinds";
import { parseDelimited } from "@/lib/parse-delimited";
import { FileOpenMenu, useFileActionRunner } from "@/components/file-open-menu";
import { OpenInAppButton } from "@/components/open-in-app-button";
import { openWithSystemApp } from "@/lib/file-actions";
import { Hint } from "@/components/ui/tooltip";

/**
 * FileViewer —— 右侧「文件」模块里**一个文件**的查看器（每个 tab 一个）。
 *
 * 类型分工（每种格式怎么渲染、做不到的说清楚，见 lib/file-kinds.ts 顶部表）：
 *   markdown  富文本（可切源码）          code/text  等宽 + Prism 高亮 + 行号
 *   html      iframe **带 sandbox** 渲染  image      <img>（适应宽度 / 缩放；svg 可切源码）
 *   pdf       内嵌 iframe（差别见下）     table      csv/tsv 解析成表格
 *   media     <video> / <audio>           office/archive/binary → 文件信息 + 打开方式
 *
 * 内嵌 PDF 的平台差异（用户一定会遇到，所以写在界面上）：
 *   Chromium 系（Chrome / Edge / Electron）自带 PDF 阅读器，iframe 直接能看；
 *   WKWebView（macOS 桌面版）**不内置** PDF 阅读器 —— 桌面版里这块可能是空白。
 *   所以 PDF 一律同时给「用系统默认应用打开」（macOS 上是预览.app）这条明路。
 *
 * 超大文本：先 stat 再决定读法 —— ≤512KB 整读；>512KB 只读前 256KB 并明确提示
 * （一次性把几十兆日志塞进 DOM 会直接卡死面板）。未知类型（扩展名不在 lib/file-kinds.ts
 * 的任何表里，含 .gitignore / LICENSE / Makefile）先读 32KB 嗅探：像文本再按大小补读 ——
 *  ≤512KB 补一次**整读**，>512KB 读前 256KB，两种情况都不会把「只读了一小样」当成结论。
 *
 * 两份 URL 的分工（为什么不能合成一份，见 lib/preview-url.ts 的 projectFileUrl / projectAssetUrl）：
 *   · html  → 面板同源的 `/api/preview/project/{port}/<rel>`：它自己的 ./style.css 是相对 URL，
 *     子资源不继承查询串，只有同源才带得动；
 *   · 其它  → 8008 的 `/preview/{port}/<rel>?token=`：没有相对子资源，留在跨源那一侧。
 *
 * iframe sandbox 的取舍：`allow-scripts allow-forms allow-popups allow-modals allow-downloads`，
 * **不给** `allow-same-origin`，也不给 `allow-top-navigation`。理由：
 *   · 少了 allow-scripts，模型产出的 demo（数据看板 / 小游戏）就是一张静态图，等于没渲染；
 *   · 少了 allow-same-origin，文档落进 opaque origin —— 这份 html 走的是**面板同源**的
 *     `/api/preview/project/…`（相对子资源要求同源），带上 allow-same-origin 就等于
 *     把面板的 DOM / localStorage / 同源 API 交给**模型写出来的页面**：`fetch('/api/local-token')`
 *     同源读取不受 CORS 约束，令牌到手 ≈ 内核到手（改模型 base URL / 开回合 / 批工具调用）。
 *   · 代价（明说）：opaque origin 下**CORS 模式**的加载会失败 —— 相对路径的 fetch / XHR、
 *     `<script type="module">`、`@font-face` 的本地字体；`<img>` / CSS / 经典 `<script src>`
 *     不受影响（它们是 no-CORS 加载）。要完整跑这类页面，用「运行开发服务器」
 *     （那是项目自己的源，不受这套沙箱影响）。
 *   · ⚠️ 真正兜底的不是这个属性，而是**服务端响应头**：`preview-path.ts` 的 PREVIEW_DOC_CSP。
 *     顶层文档（「在新窗口打开」/ 直接粘 URL）没有 iframe 属性可依靠，只有响应头管得住；
 *     改这里之前先改那里，两边必须逐字同口径。
 *   · 不给 allow-top-navigation：项目页面不该把整个面板导航走。
 */
/**
 * 渲染 markdown 时的元素定制。
 *
 * 为什么必须定制 `pre` / `code`：@tailwindcss/typography 的默认配色假设代码块**自带深色底**
 * （`--tw-prose-pre-code` 是很浅的灰），而面板是浅色底 → 代码块里的字几乎看不见（实测）。
 * 这里给代码块显式的底色与前景色，行内代码则用一枚浅底胶囊，不再靠 prose 的默认值。
 */
const MARKDOWN_COMPONENTS = {
  pre: ({ node: _node, ...props }: React.ComponentPropsWithoutRef<"pre"> & { node?: unknown }) => (
    <pre
      {...props}
      className="my-2 overflow-x-auto rounded-lg border border-border-subtle bg-surface-inset p-3 font-mono text-xs leading-relaxed text-text-primary"
    />
  ),
  code: ({ node: _node, className, ...props }: React.ComponentPropsWithoutRef<"code"> & { node?: unknown }) => (
    <code
      {...props}
      className={cn(
        "font-mono text-text-primary",
        /language-/.test(className ?? "") ? className : "rounded bg-surface-hover px-1 py-0.5 text-[0.85em]",
      )}
    />
  ),
};

export interface FileViewerProps {
  /** 项目端口；为空时只显示信息，不读内容 */
  port: string | null;
  /** 项目内相对路径（POSIX 风格） */
  path: string;
  /** 关掉当前文件（tab 提供）；不传则工具栏不显示关闭按钮 */
  onClose?: () => void;
  className?: string;
}

type StatState =
  | { status: "loading" }
  | { status: "ready"; size: number; modified: number }
  | { status: "error"; message: string };

/**
 * 未知扩展名（`fileKind` 判成 binary 的那些）先读这么多字节嗅探是不是文本。
 * 服务端的 `limit` 单位就是字节（见 legacy/routes-project-files.ts）。
 */
const SNIFF_LIMIT_BYTES = 32 * 1024;

type TextState =
  | { status: "idle" }
  | { status: "loading" }
  /**
   * `truncated` **只认服务端的标记**：本地算（size > 上限）会把「这次请求带了多小的 limit」
   * 误当成文件的属性 —— 拿 32KB 嗅探时说「没截断」，界面就会假装整份文件都在这儿。
   * `limitBytes` 是这一次**实际要了多少字节**（0 = 整读），提示条按它显示。
   */
  | { status: "ready"; content: string; truncated: boolean; size: number; limitBytes: number }
  | { status: "error"; message: string };

/** 读一次正文（带 limit 时服务端会回 `truncated`），把「要了多少字节」一起带回来 */
async function readText(port: string, path: string, limit?: number) {
  const res = await readProjectFile(port, path, limit ? { limit } : {});
  return {
    content: res.content,
    size: res.size,
    truncated: res.truncated === true,
    limitBytes: limit ?? 0,
  };
}

export function FileViewer({ port, path, onClose, className }: FileViewerProps) {
  const kind = React.useMemo(() => fileKind(path), [path]);
  const Glyph = React.useMemo(() => fileGlyphFor(path), [path]);
  const [stat, setStat] = React.useState<StatState>({ status: "loading" });
  const [text, setText] = React.useState<TextState>({ status: "idle" });
  const [view, setView] = React.useState<"preview" | "source">("preview");
  const [zoom, setZoom] = React.useState<number | null>(null);   // null = 适应宽度
  const [nonce, setNonce] = React.useState(0);                   // 重新加载 iframe / 图片
  const [detected, setDetected] = React.useState<FileKind>(kind);

  /**
   * 8008 的 `/preview` 要令牌（只能走查询串：<img>/<video> 发不了自定义头）——
   * 而令牌是**异步**取的，渲染里不能发请求。这里订阅 App 启动时那同一个 promise：
   * 落地后重渲染一次，src 这才带上 `?token=`（在此之前是 401，提示条已在说「没取到令牌」）。
   */
  const [token, setToken] = React.useState(getLocalTokenCached);
  React.useEffect(() => {
    let alive = true;
    void ensureLocalToken().then((t) => { if (alive) setToken(t); });
    return () => { alive = false; };
  }, []);

  // html 走面板同源的项目路由（相对子资源），其余走 8008 的跨源资源路由（带令牌）
  const htmlUrl = port ? projectFileUrl(port, path) : "";
  const assetUrl = port ? projectAssetUrl(port, path, token) : "";

  React.useEffect(() => {
    setView("preview");
    setZoom(null);
    setDetected(kind);
  }, [path, kind]);

  // ① 元信息：永远先问（决定要不要读正文、怎么读，以及信息卡要显示的大小 / 时间）
  React.useEffect(() => {
    if (!port) { setStat({ status: "error", message: "还没有选中任务" }); return; }
    let alive = true;
    setStat({ status: "loading" });
    (async () => {
      try {
        const s = await statProjectFile(port, path);
        if (alive) setStat({ status: "ready", size: s.size, modified: s.modified });
      } catch (e) {
        if (alive) setStat({ status: "error", message: e instanceof Error ? e.message : "读取文件信息失败" });
      }
    })();
    return () => { alive = false; };
  }, [port, path]);

  // ② 正文：文本类才读；未知类型先小样嗅探（是文本就按文本显示）
  const knownSize = stat.status === "ready" ? stat.size : -1;
  React.useEffect(() => {
    if (!port || knownSize < 0) { setText({ status: "idle" }); return; }
    if (!isTextual(kind) && kind !== "binary" && !isSvg(path)) { setText({ status: "idle" }); return; }
    let alive = true;
    setText({ status: "loading" });
    (async () => {
      try {
        if (kind === "binary") {
          const sample = await readText(port, path, SNIFF_LIMIT_BYTES);
          if (!alive) return;
          if (looksBinary(sample.content)) { setDetected("binary"); setText({ status: "idle" }); return; }
          setDetected("text");
          // 嗅探说「是文本」之后必须再读一次：32KB 那次的 `truncated` 是真话但对这份文件没用 ——
          // ≤512KB 的文件完整内容放得下，就该整读；超了才按 256KB 采样（提示条按实际值说话）。
          const res = sample.truncated
            ? await readText(port, path, knownSize > SERVER_READ_LIMIT_BYTES ? SAMPLE_LIMIT_BYTES : undefined)
            : sample;
          if (!alive) return;
          setText({ status: "ready", ...res });
          return;
        }
        const res = await readText(port, path, knownSize > SERVER_READ_LIMIT_BYTES ? SAMPLE_LIMIT_BYTES : undefined);
        if (!alive) return;
        setText({ status: "ready", ...res });
      } catch (e) {
        if (!alive) return;
        const message = e instanceof Error ? e.message : "读取失败";
        // 竞态：stat 时还没超、读的瞬间超了 → 退一步只读前 256KB，而不是把 413 甩给用户
        if (/512KB/.test(message)) {
          try {
            const res = await readText(port, path, SAMPLE_LIMIT_BYTES);
            if (alive) setText({ status: "ready", ...res });
            return;
          } catch { /* 落到下面的错误态 */ }
        }
        setText({ status: "error", message });
      }
    })();
    return () => { alive = false; };
  }, [port, path, kind, knownSize]);

  const effectiveKind = detected;
  const size = stat.status === "ready" ? stat.size : undefined;
  const modified = stat.status === "ready" ? stat.modified : undefined;
  const canToggleSource = effectiveKind === "html" || effectiveKind === "markdown" || isSvg(path);
  const canReload = effectiveKind === "html" || effectiveKind === "pdf" || effectiveKind === "image";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-surface-raised", className)}>
      {/* ── 工具栏：文件身份 + 视图切换 + 打开方式 ── */}
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2.5">
        <Glyph className={cn("size-4 shrink-0", glyphToneFor(path))} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-medium text-text-primary" title={path}>
            {path.split("/").pop()}
          </p>
          <p className="flex items-center gap-1.5 truncate text-2xs text-text-tertiary">
            <span className="shrink-0">{kindLabel(effectiveKind)}</span>
            {size !== undefined && <span className="shrink-0">· {formatBytes(size)}</span>}
            {modified !== undefined && (
              <span className="shrink-0">· {new Date(modified * 1000).toLocaleString()}</span>
            )}
          </p>
        </div>

        {canToggleSource && (
          <Hint label={view === "preview" ? "看源码" : "看渲染效果"}>
            <button
              type="button"
              aria-label="切换预览 / 源码"
              onClick={() => setView((v) => (v === "preview" ? "source" : "preview"))}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
            >
              {view === "preview" ? <Code className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </Hint>
        )}

        {view === "preview" && effectiveKind === "image" && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Hint label="缩小">
              <button type="button" aria-label="缩小" onClick={() => setZoom((z) => Math.max(0.25, (z ?? 1) * 0.8))} className="flex size-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary"><ZoomOut className="size-3.5" /></button>
            </Hint>
            <Hint label="放大">
              <button type="button" aria-label="放大" onClick={() => setZoom((z) => Math.min(8, (z ?? 1) * 1.25))} className="flex size-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary"><ZoomIn className="size-3.5" /></button>
            </Hint>
            <Hint label="适应宽度 / 原始大小">
              <button type="button" aria-label="适应宽度" onClick={() => setZoom(null)} className={cn("flex size-6 items-center justify-center rounded-md hover:bg-surface-hover hover:text-text-primary", zoom === null ? "text-accent" : "text-text-tertiary")}><Maximize2 className="size-3.5" /></button>
            </Hint>
          </div>
        )}

        {view === "preview" && canReload && (
          <Hint label="重新加载">
            <button
              type="button"
              aria-label="重新加载"
              onClick={() => setNonce((n) => n + 1)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
            >
              <RotateCcw className="size-3.5" />
            </button>
          </Hint>
        )}

        {/* 右上角：「打开方式」分体按钮 —— 左半用记住的 App 打开，右半挑 App。
            本机一个可探测的 App 都没有 / 探测失败时，它自己退回原来的 FileOpenMenu（不变砖）。 */}
        <OpenInAppButton port={port} path={path} kind={effectiveKind} inPane />

        {onClose && (
          <Hint label="关闭">
            <button
              type="button"
              aria-label="关闭文件"
              onClick={onClose}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
            >
              <X className="size-3.5" />
            </button>
          </Hint>
        )}
      </header>

      {/* ── 截断提示：只读了一部分必须说出来 ── */}
      {text.status === "ready" && text.truncated && (
        <div className="flex items-center gap-1.5 border-b border-border-subtle bg-warning-subtle px-2.5 py-1 text-2xs text-warning-fg">
          <TriangleAlert className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">
            文件较大（{formatBytes(text.size)}），只显示前{" "}
            {formatBytes(text.limitBytes > 0 ? text.limitBytes : SAMPLE_LIMIT_BYTES)} —— 完整内容用「打开方式 → 用系统默认应用打开」。
          </span>
        </div>
      )}
      {effectiveKind === "pdf" && view === "preview" && (
        <div className="border-b border-border-subtle bg-surface-inset px-2.5 py-1 text-2xs text-text-tertiary">
          内嵌预览依赖浏览器自带 PDF 阅读器；桌面版（WKWebView）可能显示空白 —— 那种情况用工具栏的「打开方式」。
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        <FileBody
          port={port}
          path={path}
          kind={effectiveKind}
          view={view}
          zoom={zoom}
          nonce={nonce}
          stat={stat}
          text={text}
          assetUrl={assetUrl}
          htmlUrl={htmlUrl}
        />
      </div>
    </div>
  );
}

/** 后端按 UTF-8 读任意文件：二进制会出现 NUL 或大量替换符 */
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

interface FileBodyProps {
  port: string | null;
  path: string;
  kind: FileKind;
  view: "preview" | "source";
  zoom: number | null;
  nonce: number;
  stat: StatState;
  text: TextState;
  /** 8008 跨源资源 URL（图片 / PDF / 音视频；已带查询串令牌） */
  assetUrl: string;
  /** 面板同源的项目 URL（html 用；相对子资源靠它才解析得对） */
  htmlUrl: string;
}

function FileBody({ port, path, kind, view, zoom, nonce, stat, text, assetUrl, htmlUrl }: FileBodyProps) {
  if (stat.status === "loading") return <Centered><Loader2 className="size-4 animate-spin" />读取文件信息…</Centered>;
  if (stat.status === "error") {
    return (
      <Centered>
        <FileWarning className="size-5 text-warning" />
        <span className="max-w-md break-words">{stat.message}</span>
      </Centered>
    );
  }

  // 预览视图：各类型的主渲染器（源码视图则落到下面的文本分支）
  if (view === "preview") {
    if (kind === "image") return <ImagePreview url={assetUrl} name={path} zoom={zoom} nonce={nonce} />;
    if (kind === "html") {
      return (
        <iframe
          key={`${htmlUrl}#${nonce}`}
          src={htmlUrl}
          title={path}
          className="h-full w-full border-0 bg-white"
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
        />
      );
    }
    if (kind === "pdf") {
      return <iframe key={`${assetUrl}#${nonce}`} src={assetUrl} title={path} className="h-full w-full border-0" />;
    }
    if (kind === "media") {
      return isAudio(path) ? (
        <div className="flex h-full items-center justify-center p-6">
          <audio controls src={assetUrl} className="w-full max-w-md" />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center bg-surface-inset p-2">
          <video controls src={assetUrl} className="max-h-full max-w-full rounded-sm" />
        </div>
      );
    }
  }

  // 文本分支：code / text / markdown / table，以及 html 与 svg 的**源码**
  if (isTextual(kind) || kind === "image") return <TextBody path={path} kind={kind} view={view} text={text} />;

  // office / archive / binary / 未知 —— 渲染不了就说清楚，并给全套打开方式
  return <FileInfoCard kind={kind} path={path} size={stat.size} modified={stat.modified} port={port} />;
}

function TextBody({ path, kind, view, text }: { path: string; kind: FileKind; view: "preview" | "source"; text: TextState }) {
  if (text.status === "loading") return <Centered><Loader2 className="size-4 animate-spin" />读取文件…</Centered>;
  if (text.status === "error") {
    return (
      <Centered>
        <FileWarning className="size-5 text-warning" />
        <span className="max-w-md break-words">{text.message}</span>
      </Centered>
    );
  }
  if (text.status !== "ready") return <Centered>没有内容</Centered>;
  const { content } = text;
  if (content.length === 0) return <div className="px-4 py-3 text-xs text-text-tertiary">空文件</div>;
  if (kind === "markdown" && view === "preview") {
    return (
      <div className="h-full overflow-auto">
        <div className="prose prose-pre:bg-surface-inset px-4 py-3">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    );
  }
  if (kind === "table") return <TableView path={path} content={content} />;
  return <CodeView path={path} content={content} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-text-secondary">
      {children}
    </div>
  );
}

/** 代码 / 文本：等宽 + Prism 高亮 + 行号（语言认不出来就退化成纯等宽，不吞内容） */
function CodeView({ path, content }: { path: string; content: string }) {
  const theme = usePrismTheme();
  const language = normalizeLanguage(codeLanguage(path) ?? undefined) ?? "text";
  return (
    <div className="h-full overflow-auto">
      <SyntaxHighlighter
        language={language}
        style={theme}
        showLineNumbers
        customStyle={{
          margin: 0,
          padding: "0.75rem 0.5rem",
          background: "transparent",
          fontSize: "12px",
          lineHeight: "18px",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-mono)", background: "transparent", fontSize: "12px" } }}
        lineNumberStyle={{ minWidth: "2.5em", opacity: 0.45, userSelect: "none" }}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
}

/** csv / tsv → 表格（解析边界见 lib/parse-delimited.ts 顶部） */
function TableView({ path, content }: { path: string; content: string }) {
  const delimiter = path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const table = React.useMemo(
    () => parseDelimited(content, delimiter, TABLE_MAX_ROWS, TABLE_MAX_COLS),
    [content, delimiter],
  );
  if (table.rows.length === 0) return <div className="px-4 py-3 text-xs text-text-tertiary">表格是空的</div>;
  const [head, ...body] = table.rows;
  return (
    <div className="h-full overflow-auto">
      {table.truncated && (
        <div className="sticky top-0 z-10 bg-warning-subtle px-2.5 py-1 text-2xs text-warning-fg">
          只显示前 {TABLE_MAX_ROWS} 行 × {TABLE_MAX_COLS} 列
        </div>
      )}
      <table className="w-full border-collapse text-2xs">
        <thead className="sticky top-0 bg-surface-inset">
          <tr>
            <th className="border border-border-subtle px-2 py-1 text-right font-mono text-text-tertiary">#</th>
            {(head ?? []).map((cell, i) => (
              <th key={i} className="border border-border-subtle px-2 py-1 text-left font-medium text-text-secondary">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="hover:bg-surface-hover">
              <td className="border border-border-subtle px-2 py-0.5 text-right font-mono text-text-tertiary">{r + 1}</td>
              {Array.from({ length: table.columns }).map((_, c) => (
                <td key={c} className="max-w-[28rem] truncate border border-border-subtle px-2 py-0.5 text-text-primary" title={row[c] ?? ""}>
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 图片：适应宽度（默认）/ 缩放；加载失败给明确原因而不是一个破图图标 */
function ImagePreview({ url, name, zoom, nonce }: { url: string; name: string; zoom: number | null; nonce: number }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => { setFailed(false); }, [url, nonce]);
  if (failed) {
    return (
      <Centered>
        <ImageOff className="size-5 text-text-tertiary" />
        <span className="max-w-md break-words">图片加载失败：{name}</span>
        <span className="text-text-tertiary">文件可能已被删除，或不是浏览器认识的图片格式（旧 WebKit 对 avif 支持不全）。</span>
      </Centered>
    );
  }
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-surface-inset p-4">
      <img
        key={`${url}#${nonce}`}
        src={url}
        alt={name}
        onError={() => setFailed(true)}
        className={cn("rounded-sm", zoom === null ? "max-h-full max-w-full object-contain" : "max-w-none")}
        style={zoom === null ? undefined : { width: `${zoom * 100}%` }}
      />
    </div>
  );
}

/** office / archive / binary —— 渲染不了就说清楚，并给全套打开方式 */
function FileInfoCard({
  kind, path, size, modified, port,
}: { kind: FileKind; path: string; size: number; modified: number; port: string | null }) {
  const Glyph = fileGlyphFor(path);
  const run = useFileActionRunner();
  const why =
    kind === "office"
      ? "网页里没有 Office 引擎，.docx / .xlsx / .pptx 渲染不了（纯文本的 .csv 能直接看，见表格类型）。"
      : kind === "archive"
        ? "压缩包在网页里解不开。"
        : "这个类型浏览器不认识，按二进制处理（不把乱码塞进界面）。";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <Glyph className={cn("size-8", glyphToneFor(path))} />
      <div className="space-y-1">
        <p className="text-xs font-medium text-text-primary">{path.split("/").pop()}</p>
        <p className="break-all font-mono text-2xs text-text-tertiary">{path}</p>
        <p className="text-2xs text-text-secondary">
          {kindLabel(kind)} · {formatBytes(size)} · {new Date(modified * 1000).toLocaleString()}
        </p>
      </div>
      <p className="max-w-sm text-2xs leading-relaxed text-text-tertiary">{why}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run(() => openWithSystemApp(port, path))}
          className="rounded-md border border-border-default px-2 py-1 text-2xs text-text-secondary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
        >
          用系统默认应用打开
        </button>
        <FileOpenMenu port={port} path={path} kind={kind} inPane trigger="text" label="打开方式" className="border border-border-default px-2 py-1" />
      </div>
    </div>
  );
}

export default FileViewer;
