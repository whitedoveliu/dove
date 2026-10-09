/**
 * 文档解析自测（packages/core/src/docs/）
 * 运行：cd harness && node --no-warnings scripts/smoke-docs.ts
 *
 * 覆盖：txt 直读 → rtf/docx（/usr/bin/textutil）→ PDF（Swift+PDFKit，手写最小 PDF 字节）
 *      → 多页 + 页范围 → 大文件截断 note → 未知类型 → Read 工具接线（PDF 不再返回二进制）
 * 环境能力缺失（无 swiftc / 无 textutil）时按「明确降级说明」跳过，不影响 exit 0；
 * 但「有能力却解析错」一定 exit 1。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TEXT_BYTES, type DocumentExtract, docKindOf, extractDocument, isDocumentPath,
} from "../packages/core/src/docs/index.ts";
import { ensurePdfHelper, pdfExtract } from "../packages/core/src/docs/pdf.ts";
import { textutilExtract } from "../packages/core/src/docs/textutil.ts";
import { ReadTool } from "../packages/core/src/tools/builtin/read.ts";
import type { ToolContext } from "../packages/core/src/tools/types.ts";

let passed = 0, failed = 0, degraded = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};
const skip = (name: string, why: string): void => { degraded++; console.log("  ⚠️  跳过 " + name + " — " + why); };
const section = (t: string): void => { console.log("\n=== " + t + " ==="); };

/** 手写最小 PDF（零依赖）：每页一段 Helvetica 文本，xref 偏移按真实字节算 */
function minimalPdf(pageTexts: string[]): Buffer {
  const objs: Record<number, string> = {};
  const kids: string[] = [];
  const fontId = 3 + pageTexts.length * 2;
  for (let i = 0; i < pageTexts.length; i++) {
    const pageId = 3 + i * 2, contentId = pageId + 1;
    kids.push(pageId + " 0 R");
    objs[pageId] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 "
      + fontId + " 0 R >> >> /Contents " + contentId + " 0 R >>";
    const stream = "BT /F1 36 Tf 72 700 Td (" + pageTexts[i] + ") Tj ET";
    objs[contentId] = "<< /Length " + Buffer.byteLength(stream, "latin1") + " >>\nstream\n" + stream + "\nendstream";
  }
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + pageTexts.length + " >>";
  objs[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const off: number[] = new Array(fontId + 1).fill(0);
  for (let i = 1; i <= fontId; i++) { off[i] = Buffer.byteLength(out, "latin1"); out += i + " 0 obj\n" + objs[i] + "\nendobj\n"; }
  const xref = Buffer.byteLength(out, "latin1");
  out += "xref\n0 " + (fontId + 1) + "\n0000000000 65535 f \n";
  for (let i = 1; i <= fontId; i++) out += String(off[i]).padStart(10, "0") + " 00000 n \n";
  out += "trailer\n<< /Size " + (fontId + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(out, "latin1");
}

const TMP = mkdtempSync(join(tmpdir(), "dove-docs-smoke-"));
const ctx = {
  toolCallId: "smoke", threadId: "smoke", workdir: TMP, outputsDir: TMP,
  emit: () => {}, requestApproval: async () => ({ approved: true }), services: {},
} as unknown as ToolContext;

try {
  // ── 1. 造测试文件 ────────────────────────────────────────
  section("1. 造测试文件");
  const txt = join(TMP, "smoke.txt");
  writeFileSync(txt, "DOVE TXT SMOKE\n第二行中文\n");
  const big = join(TMP, "big.txt");
  writeFileSync(big, "DOVE-BIG\n" + "x".repeat(MAX_TEXT_BYTES + 4096));
  const bin = join(TMP, "unknown.bin");
  writeFileSync(bin, "DOVE SNIFF SMOKE\n");
  const pdfPath = join(TMP, "smoke.pdf");
  writeFileSync(pdfPath, minimalPdf(["DOVE PDF SMOKE", "DOVE PDF PAGE TWO"]));
  console.log("  临时目录：" + TMP + "（pdf " + minimalPdf(["a", "b"]).length + " 字节模板）");

  let rtf = join(TMP, "smoke.rtf"), docx = join(TMP, "smoke.docx");
  let hasTextutil = true;
  try {
    execFileSync("/usr/bin/textutil", ["-convert", "rtf", "-output", rtf, txt]);
    execFileSync("/usr/bin/textutil", ["-convert", "docx", "-output", docx, txt]);
    writeFileSync(join(TMP, "rtf-src.txt"), "DOVE RTF SMOKE\n第二行中文\n");
    execFileSync("/usr/bin/textutil", ["-convert", "rtf", "-output", rtf, join(TMP, "rtf-src.txt")]);
    writeFileSync(join(TMP, "docx-src.txt"), "DOVE DOCX SMOKE\n第二行中文\n");
    execFileSync("/usr/bin/textutil", ["-convert", "docx", "-output", docx, join(TMP, "docx-src.txt")]);
  } catch (e) {
    hasTextutil = false;
    skip("textutil 造 rtf/docx", String(e).slice(0, 120));
  }
  check("扩展名识别", isDocumentPath("a.PDF") && isDocumentPath("a.docx") && !isDocumentPath("a.txt") && docKindOf("a.md") === "text");

  // ── 2. 纯文本 / 嗅探 ─────────────────────────────────────
  section("2. 纯文本与魔数嗅探");
  const t = await extractDocument(txt);
  check("txt：kind=text 且文本正确", t.ok && t.kind === "text" && (t.text ?? "").includes("DOVE TXT SMOKE"), JSON.stringify(t.text));
  const sniff = await extractDocument(bin);
  check("未知扩展名：嗅探成 text 并读出内容", sniff.ok && sniff.kind === "text" && (sniff.text ?? "").includes("DOVE SNIFF SMOKE"), sniff.kind);
  const bigRes = await extractDocument(big);
  check("大文件：截断并在 note 里说明", bigRes.ok && (bigRes.text ?? "").length > 0 && !!bigRes.note && bigRes.note.includes("已截断"), String(bigRes.note).slice(0, 90));
  const missing = await extractDocument(join(TMP, "nope.pdf"));
  check("文件不存在：结构化失败（不抛）", !missing.ok && !!missing.error, String(missing.error).slice(0, 60));

  // ── 3. textutil（富文本） ────────────────────────────────
  section("3. 富文本（/usr/bin/textutil）");
  if (hasTextutil) {
    const rtfRes = await extractDocument(rtf);
    check("rtf：提取出 DOVE RTF SMOKE", rtfRes.ok && rtfRes.kind === "richtext" && (rtfRes.text ?? "").includes("DOVE RTF SMOKE"), JSON.stringify(rtfRes.text));
    const docxRes = await extractDocument(docx);
    check("docx：提取出 DOVE DOCX SMOKE", docxRes.ok && docxRes.kind === "richtext" && (docxRes.text ?? "").includes("DOVE DOCX SMOKE"), JSON.stringify(docxRes.text));
    const badDir = await textutilExtract(TMP);
    check("textutil 对目录：返回结构化错误", !badDir.ok && !!badDir.error, String(badDir.error).slice(0, 50));
  } else skip("rtf/docx 提取", "无 /usr/bin/textutil");

  // ── 4. PDF（Swift + PDFKit） ─────────────────────────────
  section("4. PDF（Swift + PDFKit）");
  const helper = await ensurePdfHelper();
  console.log("  helper：" + JSON.stringify(helper));
  if (helper.ok) {
    const pdf = await extractDocument(pdfPath);
    check("pdf：kind=pdf 且第 1 页文本正确", pdf.ok && pdf.kind === "pdf" && (pdf.pages?.[0]?.text ?? "").includes("DOVE PDF SMOKE"), JSON.stringify(pdf.pages?.map((p) => p.text)));
    check("pdf：text 拼接包含两页内容", (pdf.text ?? "").includes("DOVE PDF SMOKE") && (pdf.text ?? "").includes("PAGE TWO"), String(pdf.text).slice(0, 60));
    const page2 = await pdfExtract(pdfPath, { pages: [2, 2] });
    check("页范围 [2,2]：只返回第 2 页", page2.ok && page2.pages?.length === 1 && page2.pages[0].page === 2 && page2.pages[0].text.includes("PAGE TWO"), JSON.stringify(page2.pages));
    check("页范围：totalPages 报出总页数", page2.totalPages === 2, String(page2.totalPages));
    const broken = join(TMP, "broken.pdf");
    writeFileSync(broken, "%PDF-1.4\nnot really a pdf\n%%EOF\n");
    const brokenRes = await extractDocument(broken);
    check("坏 PDF：结构化失败（不抛）", !brokenRes.ok && !!brokenRes.error, String(brokenRes.error).slice(0, 70));
  } else {
    skip("PDF 提取", "无 swiftc 或编译失败：" + String(helper.error).slice(0, 120));
  }

  // ── 5. Read 工具接线 ─────────────────────────────────────
  section("5. Read 工具接线（PDF/docx 不再返回「二进制文件」）");
  const readPdf = await ReadTool.execute({ file_path: pdfPath }, ctx) as Record<string, unknown>;
  check("Read(pdf)：返回带行号的文本", String(readPdf.content ?? "").includes("DOVE PDF SMOKE"), String(readPdf.content ?? "").slice(0, 80));
  check("Read(pdf)：note 说明已按文档解析", String(readPdf.note ?? "").includes("文档解析"), String(readPdf.note ?? "").slice(0, 80));
  check("Read(pdf)：不再是 binary 提示", readPdf.binary !== true);
  const readTxt = await ReadTool.execute({ file_path: txt }, ctx) as Record<string, unknown>;
  check("Read(txt)：行为不变（行号 + totalLines）", String(readTxt.content ?? "").includes("1\tDOVE TXT SMOKE") && readTxt.totalLines === 3, "totalLines=" + String(readTxt.totalLines));
  const readDir = await ReadTool.execute({ file_path: TMP }, ctx) as Record<string, unknown>;
  check("Read(目录)：行为不变", readDir.type === "directory", String(readDir.count));
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log("\n通过 " + passed + " / 失败 " + failed + " / 降级跳过 " + degraded);
process.exit(failed > 0 ? 1 : 0);
