/**
 * 文档解析入口：任意文档 → 纯文本（补上「file/PDF 降级为文本指引」的缺口）
 *
 * 分发：
 *   .pdf                        → Swift + PDFKit 逐页提取
 *   .docx/.doc/.rtf/.rtfd/.odt… → /usr/bin/textutil 转纯文本
 *   .txt/.md/.csv/.json/…       → 直接读（带字节上限）
 *   无扩展名 / 未知扩展名        → 嗅探魔数（%PDF- / {\rtf）
 *
 * 统一约束：最多返回 MAX_TEXT_BYTES 文本，截断一定写进 note（绝不静默丢内容）。
 * 任何失败都返回结构化结果，绝不抛。
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { type PdfPage, pdfExtract } from "./pdf.ts";
import { RICH_EXTS, normalize, textutilExtract } from "./textutil.ts";

/** 单次最多返回的文本字节数（超出截断并在 note 说明） */
export const MAX_TEXT_BYTES = 400 * 1024;

export type DocKind = "pdf" | "text" | "richtext" | "unknown";

export interface DocumentExtract {
  ok: boolean;
  kind: DocKind;
  text?: string;
  pages?: PdfPage[];
  /** 原始文件字节数 */
  bytes?: number;
  error?: string;
  note?: string;
}

/** 直接当纯文本读的扩展名 */
export const TEXT_EXTS = new Set([
  ".txt", ".text", ".md", ".markdown", ".mdx", ".rst", ".org", ".tex",
  ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".log", ".yaml", ".yml",
  ".toml", ".ini", ".conf", ".env", ".xml", ".srt", ".vtt", ".sql", ".diff", ".patch",
]);

/** 需要解析器降级成文本的扩展名（PDF + 富文本） */
export const DOC_EXTS = new Set([".pdf", ...RICH_EXTS]);

export function isDocumentPath(p: string): boolean {
  return DOC_EXTS.has(extname(p).toLowerCase());
}

export function docKindOf(p: string): DocKind {
  const ext = extname(p).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (RICH_EXTS.has(ext)) return "richtext";
  if (TEXT_EXTS.has(ext)) return "text";
  return "unknown";
}

export interface ExtractOptions {
  /** PDF 页范围（1 起闭区间） */
  pages?: [number, number];
  maxBytes?: number;
}

/** 统一入口：按扩展名分发，未知类型再嗅探魔数 */
export async function extractDocument(p: string, opts: ExtractOptions = {}): Promise<DocumentExtract> {
  if (!p || !existsSync(p)) return { ok: false, kind: "unknown", error: "文件不存在：" + p };
  let bytes = 0;
  try {
    const st = statSync(p);
    if (st.isDirectory()) return { ok: false, kind: "unknown", error: "这是目录，不是文件：" + p };
    bytes = st.size;
  } catch (e) {
    return { ok: false, kind: "unknown", error: "读取文件状态失败：" + String(e) };
  }

  const maxBytes = Math.max(1_024, opts.maxBytes ?? MAX_TEXT_BYTES);
  let kind = docKindOf(p);
  if (kind === "unknown") kind = sniffKind(p);

  if (kind === "pdf") {
    const r = await pdfExtract(p, opts.pages ? { pages: opts.pages } : {});
    if (!r.ok) return { ok: false, kind: "pdf", bytes, error: r.error, ...(r.note ? { note: r.note } : {}) };
    const pages = r.pages ?? [];
    const joined = joinPages(pages);
    const cut = capText(joined, maxBytes);
    const notes = [r.note, cut.truncated ? truncateNote(bytes, maxBytes) : undefined].filter((s): s is string => !!s);
    return {
      ok: true, kind: "pdf", pages, bytes, text: cut.text,
      ...(notes.length ? { note: notes.join("；") } : {}),
    };
  }

  if (kind === "richtext") {
    const r = await textutilExtract(p);
    if (!r.ok) return { ok: false, kind: "richtext", bytes, error: r.error };
    const cut = capText(r.text ?? "", maxBytes);
    return {
      ok: true, kind: "richtext", bytes, text: cut.text,
      ...(cut.truncated ? { note: truncateNote(bytes, maxBytes) } : {}),
    };
  }

  if (kind === "text") {
    const head = readHead(p, maxBytes);
    const text = normalize(head.buf.toString("utf8"));
    return {
      ok: true, kind: "text", bytes, text,
      ...(head.truncated ? { note: truncateNote(bytes, maxBytes) } : {}),
    };
  }

  return {
    ok: false, kind: "unknown", bytes,
    error: "不支持的文件类型：" + (extname(p) || "（无扩展名）"),
    note: "可尝试：纯文本请直接读；.docx/.rtf/.odt 用 textutil；.pdf 需要 swiftc。二进制（图片/音频/压缩包）请用对应工具。",
  };
}

/** 多页拼接：单页直接给文本，多页加页码小标题（模型能引用「第 N 页」） */
export function joinPages(pages: PdfPage[]): string {
  if (pages.length === 0) return "";
  if (pages.length === 1) return pages[0].text;
  return pages.map((p) => "=== 第 " + p.page + " 页 ===\n" + p.text).join("\n\n");
}

/** 魔数嗅探：给无扩展名/未知扩展名的文件兜底（看头 4KB 里有没有 NUL 判二进制） */
export function sniffKind(p: string): DocKind {
  const head = readHead(p, 4096).buf;
  const magic = head.subarray(0, 8).toString("latin1");
  if (magic.startsWith("%PDF-")) return "pdf";
  if (magic.startsWith("{\\rtf")) return "richtext";
  if (!head.includes(0)) return "text";
  return "unknown";
}

/** 读文件头（最多 maxBytes+1 字节），避免把超大文件整个读进内存 */
export function readHead(p: string, maxBytes: number): { buf: Buffer; truncated: boolean } {
  const st = statSync(p);
  const size = Math.min(st.size, maxBytes + 1);
  const buf = Buffer.alloc(size);
  const fd = openSync(p, "r");
  try {
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { buf: buf.subarray(0, read), truncated: st.size > read };
  } finally {
    closeSync(fd);
  }
}

/** 按字节截断（不切断多字节字符；尽量落在行边界） */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let cut = buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
  const nl = cut.lastIndexOf("\n");
  if (nl > maxBytes / 2) cut = cut.slice(0, nl);
  return { text: cut, truncated: true };
}

export function truncateNote(bytes: number, maxBytes: number): string {
  return "已截断：原文 " + bytes + " 字节，最多返回 " + maxBytes + " 字节文本；" +
    "需要后面部分请用 Bash（sed -n / tail）或分批读取。";
}
