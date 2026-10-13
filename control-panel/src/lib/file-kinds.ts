/**
 * 文件类型清单 —— **一份**，给「每轮文件卡片」「文件 tab」「文件查看器」共用。
 *
 * 为什么单独拉出来：同一个扩展名判三次（卡片选图标、tab 选标签、查看器选渲染器）
 * 必然漂移 —— 界面上的表现就是「卡片说这是图片，点开却说打不开」。
 *
 * 每种类型怎么显示（与 `file-viewer.tsx` 一一对应）：
 *   markdown  ReactMarkdown 富文本（可切源码）
 *   html      同源 /preview 路由 + iframe sandbox 直接渲染（可切源码）
 *   image     <img> 预览（适应宽度 / 缩放），svg 额外可切源码
 *   pdf       浏览器内置 PDF 阅读器（iframe）；WKWebView 与 Chromium 的差异见 file-viewer 顶部
 *   table     csv / tsv 解析成表格（引号 / 换行的处理边界见 parse-delimited 注释）
 *   code/.text 等宽 + Prism 高亮 + 行号（超限只读前 N KB）
 *   media     <video> / <audio>
 *   office    **网页里渲染不了** → 文件信息 + 「打开方式」菜单
 *   archive   同上（网页里解不开）
 *   binary    同上（未知类型先嗅探：像文本就按 text 显示）
 */
import {
  FileArchive, FileAudio, FileCode2, FileImage, FileJson, FileSpreadsheet,
  FileText, FileType2, FileVideo, type LucideIcon,
} from "lucide-react";

export type FileKind =
  | "markdown" | "html" | "image" | "pdf" | "table" | "code" | "text" | "media" | "office" | "archive" | "binary";

/** 文件名的扩展名（小写，不含点）；没有则空串 */
export function extensionOf(name: string): string {
  const base = String(name ?? "").split(/[?#]/)[0]!.split("/").pop() ?? "";
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index + 1).toLowerCase() : "";
}

const MARKDOWN_EXT = new Set(["md", "mdx", "markdown", "mkd", "mdown"]);
const HTML_EXT = new Set(["html", "htm", "xhtml"]);
/** svg 两边都算：它既是图片（<img> 能显示），也是文本（可以看 / 改源码）——按 image 处理并给源码开关 */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "ico"]);
const SVG_EXT = new Set(["svg"]);
const PDF_EXT = new Set(["pdf"]);
const TABLE_EXT = new Set(["csv", "tsv"]);
const OFFICE_EXT = new Set([
  "doc", "docx", "rtf", "odt", "pages",
  "xls", "xlsx", "xlsm", "ods", "numbers",
  "ppt", "pptx", "odp", "key",
]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z", "dmg", "pkg", "iso"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus", "weba"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v", "ogv", "avi", "mkv"]);
const PLAIN_TEXT_EXT = new Set([
  "txt", "log", "ini", "conf", "cfg", "env", "properties", "lock", "gitignore", "npmrc",
  "editorconfig", "dockerignore", "text",
]);

/** 高亮语言表：键是扩展名，值是 Prism 的语言 id（写错语言只会退化成无高亮，不会炸） */
const LANGUAGE_BY_EXT: Record<string, string> = {
  py: "python", pyi: "python", ipynb: "json",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", vue: "markup", svelte: "markup",
  json: "json", jsonc: "json", json5: "json", map: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", conf: "ini", cfg: "ini", env: "bash",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell", bat: "batch",
  css: "css", scss: "scss", sass: "scss", less: "less", styl: "stylus",
  html: "markup", htm: "markup", xhtml: "markup", xml: "markup", svg: "markup", xsl: "markup",
  md: "markdown", mdx: "markdown",
  sql: "sql", graphql: "graphql", gql: "graphql", prisma: "graphql", proto: "protobuf",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", lua: "lua", r: "r", pl: "perl", dart: "dart", scala: "scala",
  dockerfile: "docker", makefile: "makefile", gradle: "groovy", cmake: "cmake",
  txt: "text", log: "text", diff: "diff", patch: "diff", gitignore: "text",
};

/** 明确当文本读的扩展名（不在表里的文件会先 stat + 嗅探，二进制不会被当源码打开） */
export const TEXT_EXT = new Set([
  ...MARKDOWN_EXT, ...HTML_EXT, ...SVG_EXT, ...TABLE_EXT,
  ...PLAIN_TEXT_EXT, ...Object.keys(LANGUAGE_BY_EXT),
]);

export function fileKind(pathOrName: string): FileKind {
  const ext = extensionOf(pathOrName);
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (HTML_EXT.has(ext)) return "html";
  if (IMAGE_EXT.has(ext)) return "image";
  if (SVG_EXT.has(ext)) return "image";
  if (PDF_EXT.has(ext)) return "pdf";
  if (TABLE_EXT.has(ext)) return "table";
  if (OFFICE_EXT.has(ext)) return "office";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext)) return "media";
  if (PLAIN_TEXT_EXT.has(ext)) return "text";
  if (LANGUAGE_BY_EXT[ext]) return "code";
  return "binary";
}

/** Prism 语言 id；没有映射就返回 null（无高亮的纯等宽） */
export function codeLanguage(pathOrName: string): string | null {
  return LANGUAGE_BY_EXT[extensionOf(pathOrName)] ?? null;
}

export function isAudio(pathOrName: string): boolean { return AUDIO_EXT.has(extensionOf(pathOrName)); }
export function isVideo(pathOrName: string): boolean { return VIDEO_EXT.has(extensionOf(pathOrName)); }
export function isSvg(pathOrName: string): boolean { return SVG_EXT.has(extensionOf(pathOrName)); }
/** 是不是本来就以文本形态存在（可以给「源码」开关） */
export function isTextual(kind: FileKind): boolean {
  return kind === "markdown" || kind === "html" || kind === "code" || kind === "text" || kind === "table";
}
/** 「新窗口打开」只对这些类型有意义：能在浏览器里独立渲染成页面 */
export function canOpenInNewWindow(kind: FileKind): boolean {
  return kind === "html" || kind === "image" || kind === "pdf" || kind === "media";
}

/** 类型标签（卡片 / tab 上的一句话） */
const KIND_LABEL: Record<FileKind, string> = {
  markdown: "Markdown", html: "网页", image: "图片", pdf: "PDF",
  table: "表格", code: "代码", text: "文本", media: "音视频",
  office: "Office 文档", archive: "压缩包", binary: "二进制",
};
export function kindLabel(kind: FileKind): string { return KIND_LABEL[kind]; }

/** 类型图标（色调跟着 shell/file-tree.tsx 的 FileGlyph 走，界面里是同一套字形） */
export function fileGlyphFor(pathOrName: string): LucideIcon {
  const ext = extensionOf(pathOrName);
  const kind = fileKind(pathOrName);
  if (kind === "image") return FileImage;
  if (kind === "pdf" || kind === "office") return ext === "pdf" ? FileText : FileSpreadsheet;
  if (kind === "table") return FileSpreadsheet;
  if (kind === "media") return AUDIO_EXT.has(ext) ? FileAudio : FileVideo;
  if (kind === "archive") return FileArchive;
  if (ext === "json" || ext === "jsonc" || ext === "json5") return FileJson;
  if (kind === "markdown" || kind === "text") return FileText;
  if (kind === "code") return FileCode2;
  return FileType2;
}

/** 图标色调 class（与文件树一致） */
export function glyphToneFor(pathOrName: string): string {
  const kind = fileKind(pathOrName);
  if (kind === "image") return "text-[oklch(0.62_0.15_320)]";
  if (kind === "table") return "text-success";
  if (kind === "markdown" || kind === "text") return "text-text-tertiary";
  if (kind === "code" || kind === "html") return "text-info";
  if (kind === "media") return "text-warning";
  return "text-text-tertiary";
}

/** 服务端 `/file` 不带 limit 时的上限 —— 超过它必须带 limit 请求（否则 413） */
export const SERVER_READ_LIMIT_BYTES = 512 * 1024;
/** 超大文本只读这么多（「只显示前 256KB + 提示」）—— 一次性塞进 DOM 会把面板拖死 */
export const SAMPLE_LIMIT_BYTES = 256 * 1024;
/** 表格只解析前这么多行（再多也没人看，DOM 先撑不住了） */
export const TABLE_MAX_ROWS = 500;
export const TABLE_MAX_COLS = 60;
