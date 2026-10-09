/**
 * 富文本 → 纯文本（macOS 自带 /usr/bin/textutil）
 * 支持 .docx / .doc / .rtf / .rtfd / .html / .odt / .wordml / .webarchive。
 *
 * ⚠️ 实测坑：textutil 即使**读不到文件**也返回 exit code 0，错误只写在 stderr。
 *    所以判失败要看 stderr + stdout 是否为空，不能只看退出码。
 */
import { existsSync, statSync } from "node:fs";
import { run } from "./swift.ts";

export const TEXTUTIL = "/usr/bin/textutil";
export const TEXTUTIL_TIMEOUT_MS = 60_000;
export const TEXTUTIL_MISSING_HINT =
  "未找到 /usr/bin/textutil（macOS 自带）：非 macOS 环境下 docx/rtf 等富文本无法解析，请用纯文本或 PDF。";

/** textutil 能转成文本的扩展名 */
export const RICH_EXTS = new Set([".docx", ".doc", ".rtf", ".rtfd", ".odt", ".wordml", ".html", ".htm", ".webarchive"]);

export interface TextutilResult { ok: boolean; text?: string; error?: string }

/** 富文本 → 纯文本；任何失败都返回结构化结果，绝不抛 */
export async function textutilExtract(path: string): Promise<TextutilResult> {
  if (!path || !existsSync(path)) return { ok: false, error: "文件不存在：" + path };
  try { if (statSync(path).isDirectory()) return { ok: false, error: "这是目录，不是文件：" + path }; }
  catch (e) { return { ok: false, error: "读取文件状态失败：" + String(e) }; }
  if (!existsSync(TEXTUTIL)) return { ok: false, error: TEXTUTIL_MISSING_HINT };

  const r = await run(TEXTUTIL, ["-convert", "txt", "-stdout", path], { timeoutMs: TEXTUTIL_TIMEOUT_MS });
  if (r.error && r.code === null) return { ok: false, error: "textutil 执行失败：" + r.error };
  const raw = r.stdout ?? "";
  const detail = (r.stderr ?? "").trim();
  // 退出码不可信：只有「stderr 报错 + 没有产出」或「明确 Error reading」才算失败
  if (/error reading|no such file|不支持|cannot open/i.test(detail) && raw.trim() === "") {
    return { ok: false, error: "textutil 无法解析：" + detail.split("\n")[0].slice(0, 300) };
  }
  if (r.code !== 0 && raw.trim() === "") {
    return { ok: false, error: "textutil 失败（code=" + r.code + "）：" + detail.slice(0, 300) };
  }
  if (raw.trim() === "") return { ok: false, error: "textutil 没输出文本（可能是空文档或纯图片文档）：" + path };
  return { ok: true, text: normalize(raw) };
}

/** 统一换行、去掉行尾空白与 BOM */
export function normalize(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
