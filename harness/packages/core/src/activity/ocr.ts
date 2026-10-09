/**
 * OCR（T7.5）：Vision helper 的运行时编译与调用。
 * - 源码是同目录的 ocr.swift；按内容 sha256 命名，缓存到 ~/.dove/cache/ocr-<hash>
 * - 首次数秒编译，之后直接复用（同内容只编译一次，进程内并发也只编译一次）
 * - 无 swiftc / 编译失败 / 识别失败 → { text: "", error }，绝不抛
 * - 「每 3 张跑一次」由上层按 OCR_EVERY_N 控制
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./capture.ts";

export const SWIFTC = "/usr/bin/swiftc";
export const OCR_EVERY_N = 3;
/**
 * OCR 语言表 —— **顺序有语义，中文必须在前**。
 *
 * 踩过的坑：原来写成 ["en-US", "zh-Hans", "zh-Hant", "ja"]，
 * 结果 Vision 对纯中文画面（哪怕字有 150px 大）只返回 "iX" —— 它锁死在拉丁字母上不认中文了。
 * 实测对比（同一张整屏截图的中文菜单栏）：
 *   en 优先 → "Chrome X1 448 / EX1E1 / KHET"
 *   zh 优先 → "Chrome 文件 编辑 / 显示 / 历史记录 书签 个人资料 标签页 窗口帮助"
 * 中文用户占多数，所以把中文放最前。
 */
export const OCR_LANGUAGES = ["zh-Hans", "zh-Hant", "ja", "en-US"] as const;
export const OCR_COMPILE_TIMEOUT_MS = 180_000;
export const OCR_RUN_TIMEOUT_MS = 30_000;
export const SWIFTC_MISSING_HINT =
  "未找到 /usr/bin/swiftc：安装 Xcode Command Line Tools（xcode-select --install）后重试。";

export interface OcrResult { text: string; error?: string }
export interface HelperResult { ok: boolean; path?: string; error?: string }

/** 缓存目录：DOVE_CACHE_DIR 可覆盖，默认 ~/.dove/cache */
export function cacheDir(): string {
  const custom = process.env.DOVE_CACHE_DIR?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), ".dove", "cache");
}

export function swiftSourcePath(): string {
  return fileURLToPath(new URL("./ocr.swift", import.meta.url));
}

function sourceHash(): string {
  const src = readFileSync(swiftSourcePath(), "utf8");
  return createHash("sha256").update(src).digest("hex").slice(0, 12);
}

/** 编译产物路径：~/.dove/cache/ocr-<hash> */
export function helperPath(): string {
  return join(cacheDir(), `ocr-${sourceHash()}`);
}

function isUsable(path: string): boolean {
  try { return existsSync(path) && statSync(path).size > 0; } catch { return false; }
}

let compiling: Promise<HelperResult> | null = null;

async function compileHelper(): Promise<HelperResult> {
  const src = swiftSourcePath();
  if (!existsSync(src)) return { ok: false, error: `缺少 Swift 源码：${src}` };
  if (!existsSync(SWIFTC) && !process.env.DOVE_SWIFTC) {
    return { ok: false, error: SWIFTC_MISSING_HINT };
  }
  const swiftc = process.env.DOVE_SWIFTC?.trim() || SWIFTC;
  const out = helperPath();
  try { mkdirSync(cacheDir(), { recursive: true }); } catch { /* ignore */ }
  const tmp = `${out}.tmp-${process.pid}`;
  const r = await run(swiftc, ["-O", "-o", tmp, src], { timeoutMs: OCR_COMPILE_TIMEOUT_MS });
  if (r.code !== 0 || !isUsable(tmp)) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    const detail = (r.stderr || r.error || "").trim().split("\n").slice(0, 6).join(" / ").slice(0, 400);
    return { ok: false, error: `Swift 编译失败（code=${r.code}）：${detail}` };
  }
  try { renameSync(tmp, out); } catch (e) { return { ok: false, error: `编译产物落盘失败：${String(e)}` }; }
  return { ok: true, path: out };
}

/** 确保 helper 可用（必要时编译）；同一进程内并发调用共享同一次编译 */
export async function ensureHelper(force = false): Promise<HelperResult> {
  const out = helperPath();
  if (!force && isUsable(out)) return { ok: true, path: out };
  if (!compiling) {
    compiling = compileHelper().finally(() => { compiling = null; });
  }
  return compiling;
}

/** 识别一张图；失败返回空文本 + 明确 error */
export async function ocrImage(path: string): Promise<OcrResult> {
  if (!path || !existsSync(path)) return { text: "", error: `图片不存在：${path}` };
  const helper = await ensureHelper();
  if (!helper.ok || !helper.path) return { text: "", error: helper.error ?? "OCR helper 不可用" };
  const r = await run(helper.path, [path], { timeoutMs: OCR_RUN_TIMEOUT_MS });
  if (r.code !== 0) {
    const detail = (r.stderr || r.error || "").trim().slice(0, 300);
    return { text: "", error: `OCR 执行失败（code=${r.code}）：${detail}` };
  }
  return { text: r.stdout.trim() };
}

/** 自测用：用同一个 helper 渲染一张含文字的 PNG */
export async function renderTextImage(out: string, text: string): Promise<HelperResult> {
  const helper = await ensureHelper();
  if (!helper.ok || !helper.path) return { ok: false, error: helper.error ?? "OCR helper 不可用" };
  const r = await run(helper.path, ["--render", out, text], { timeoutMs: OCR_RUN_TIMEOUT_MS });
  if (r.code !== 0 || !existsSync(out)) {
    return { ok: false, error: `渲染测试图失败（code=${r.code}）：${(r.stderr || r.error || "").trim().slice(0, 200)}` };
  }
  return { ok: true, path: out };
}
