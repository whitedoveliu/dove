/**
 * Read —— 读文件（带行号）/ 列目录（T3.13）
 * 输出档 exact：结构原样，只裁长度；真正的预算与落盘交给 budget.ts。
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { defineTool, S } from "../types.ts";
import { extractDocument, isDocumentPath } from "../../docs/index.ts";
import { guarded, resolvePath, relPath, str, optNum, readTextFile, humanBytes } from "./util.ts";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;

/** 目录 → 列表文本 */
async function listDir(abs: string, workdir: string): Promise<Record<string, unknown>> {
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const rows: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const st = await fsp.stat(path.join(abs, e.name)).catch(() => null);
    const kind = e.isDirectory() ? "DIR " : "FILE";
    const size = st ? humanBytes(st.size).padStart(9) : "        ?";
    rows.push(kind + "  " + size + "  " + e.name + (e.isDirectory() ? "/" : ""));
  }
  return {
    file_path: relPath(abs, workdir),
    type: "directory",
    count: rows.length,
    content: rows.join("\n"),
    note: "这是目录列表；读具体文件请传文件路径。",
  };
}

export const ReadTool = defineTool({
  name: "Read",
  description:
    "读文件内容（返回带行号的文本，支持 offset/limit 分页）或列目录。修改文件前先用它看清楚现状。" +
    "结果被截断时会附存档路径，需要完整内容必须把存档文件分页读遍。",
  parameters: S.obj({
    file_path: S.str("文件路径或目录路径（相对工作目录，或绝对路径）"),
    offset: S.num("起始行号，1 起（默认 1）"),
    limit: S.num("最多读多少行（默认 2000）"),
  }, ["file_path"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const abs = resolvePath(str(input, "file_path"), ctx.workdir);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) throw new Error("路径不存在：" + relPath(abs, ctx.workdir));

    if (st.isDirectory()) return await listDir(abs, ctx.workdir);

    // PDF / docx / rtf 等富文档：先降级为文本，再复用下面的分页与行号逻辑（否则会被当成乱码或二进制）
    const doc = isDocumentPath(abs) ? await extractDocument(abs) : null;
    if (doc && !doc.ok) {
      return { file_path: relPath(abs, ctx.workdir), kind: doc.kind, binary: true, bytes: st.size, note: "该文档无法解析为文本：" + (doc.error ?? "未知原因") + (doc.note ? "；" + doc.note : "") };
    }
    const { text, bytes, binary } = doc ? { text: doc.text ?? "", bytes: st.size, binary: false } : readTextFile(abs);
    if (binary) {
      return { file_path: relPath(abs, ctx.workdir), binary: true, bytes, note: "二进制文件，未返回内容（图片用相应技能处理）。" };
    }

    const lines = text.split("\n");
    const offset = Math.max(1, Math.floor(optNum(input, "offset") ?? 1));
    const limit = Math.max(1, Math.floor(optNum(input, "limit") ?? DEFAULT_LIMIT));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((l, i) => (offset + i) + "\t" + (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + " …[本行超长已截断]" : l))
      .join("\n");
    const endLine = offset - 1 + slice.length;
    const more = endLine < lines.length;
    const extractionNote = doc ? "已按 " + doc.kind + " 文档解析为文本" + (doc.note ? "；" + doc.note : "") : undefined;

    return {
      file_path: relPath(abs, ctx.workdir),
      content: numbered,
      startLine: offset,
      endLine,
      totalLines: lines.length,
      bytes,
      truncated: more,
      note: [
        more
          ? "本次只显示了第 " + offset + "–" + endLine + " 行（共 " + lines.length + " 行）。" +
            "要接着读请再调 Read 并设置 offset=" + (endLine + 1) + "；只读到这里不算读完全文。"
          : undefined,
        extractionNote,
      ].filter(Boolean).join(" ") || undefined,
    };
  }),
});
