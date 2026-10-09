/**
 * PDF 文本提取：Swift + PDFKit（同目录 pdf-extract.swift，运行时编译缓存）
 * - 产物缓存 ~/.dove/cache/pdf-extract-<hash>，首次数秒编译，之后直接复用
 * - 无 swiftc / 编译失败 / 打不开 PDF → { ok:false, error } + 明确降级说明，绝不抛
 * - 输出按页返回，可指定页范围（1 起、闭区间）
 */
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SWIFTC_MISSING_HINT, ensureSwiftHelper, run, type HelperResult } from "./swift.ts";

export const PDF_RUN_TIMEOUT_MS = 120_000;
/** 单次最多提取多少页（防超长 PDF 拖垮内存；超出部分在 note 里说明） */
export const MAX_PAGES_PER_CALL = 500;

export interface PdfPage { page: number; text: string }
export interface PdfExtractResult {
  ok: boolean;
  pages?: PdfPage[];
  totalPages?: number;
  error?: string;
  note?: string;
}

export function pdfHelperSource(): string {
  return fileURLToPath(new URL("./pdf-extract.swift", import.meta.url));
}

/** 确保 PDF helper 可用（必要时编译） */
export function ensurePdfHelper(): Promise<HelperResult> {
  return ensureSwiftHelper({ source: pdfHelperSource(), prefix: "pdf-extract", frameworks: ["PDFKit"] });
}

/** 页范围归一化：1 起闭区间，非法值一律回落到「全部」 */
export function normalizeRange(pages?: [number, number]): { from: number; to: number | null; note?: string } {
  if (!pages) return { from: 1, to: null };
  const from = Math.max(1, Math.floor(Number(pages[0]) || 1));
  const rawTo = Math.floor(Number(pages[1]));
  let to = Number.isFinite(rawTo) && rawTo >= from ? rawTo : from;
  let note: string | undefined;
  if (to - from + 1 > MAX_PAGES_PER_CALL) {
    to = from + MAX_PAGES_PER_CALL - 1;
    note = "页数过多：本次只提取第 " + from + "–" + to + " 页（单次上限 " + MAX_PAGES_PER_CALL + " 页）";
  }
  return { from, to, ...(note ? { note } : {}) };
}

/** 逐页提取文本；opts.pages 为 1 起闭区间 [起, 止] */
export async function pdfExtract(path: string, opts: { pages?: [number, number] } = {}): Promise<PdfExtractResult> {
  if (!path || !existsSync(path)) return { ok: false, error: "文件不存在：" + path };
  try { if (statSync(path).isDirectory()) return { ok: false, error: "这是目录，不是文件：" + path }; }
  catch (e) { return { ok: false, error: "读取文件状态失败：" + String(e) }; }

  const helper = await ensurePdfHelper();
  if (!helper.ok || !helper.bin) {
    return {
      ok: false,
      error: helper.error ?? "PDF helper 不可用",
      note: "PDF 解析需要 Xcode Command Line Tools 里的 swiftc 现场编译 PDFKit helper；" +
        "当前不可用，只能按文件名/大小描述该 PDF，或让用户先转成文本。" + SWIFTC_MISSING_HINT,
    };
  }

  const range = normalizeRange(opts.pages);
  const args = range.to === null ? [path, String(range.from)] : [path, String(range.from), String(range.to)];
  const r = await run(helper.bin, args, { timeoutMs: PDF_RUN_TIMEOUT_MS });
  if (r.code !== 0) {
    const detail = (r.stderr || r.error || "").trim().split("\n").slice(0, 4).join(" / ").slice(0, 300);
    return { ok: false, error: "PDF 提取失败（code=" + r.code + "）：" + detail };
  }

  const parsed = parseNdjson(r.stdout);
  if (parsed.pages.length === 0) return { ok: false, error: "PDF 没有可提取的文本页：" + path };
  const notes = [range.note, parsed.totalPages > parsed.pages.length ? "PDF 共 " + parsed.totalPages + " 页，本次取了第 " + parsed.pages[0].page + "–" + parsed.pages[parsed.pages.length - 1].page + " 页" : undefined];
  return {
    ok: true,
    pages: parsed.pages,
    totalPages: parsed.totalPages,
    ...(notes.filter(Boolean).length ? { note: notes.filter(Boolean).join("；") } : {}),
  };
}

/** 解析 helper 的 NDJSON：{"pages":N} 元信息 + {"page":i,"text":"…"} 每页一行 */
export function parseNdjson(stdout: string): { pages: PdfPage[]; totalPages: number } {
  const pages: PdfPage[] = [];
  let totalPages = 0;
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    if (typeof obj.pages === "number") { totalPages = obj.pages; continue; }
    if (typeof obj.page === "number") pages.push({ page: obj.page, text: String(obj.text ?? "") });
  }
  if (totalPages === 0) totalPages = pages.length;
  return { pages, totalPages };
}
