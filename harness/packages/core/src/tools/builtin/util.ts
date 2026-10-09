/**
 * 工具实现共用助手（无业务语义）
 * 纪律：每个工具的 execute 都必须经过 guarded() —— 工具内部抛错变结构化结果，
 * 绝不冒泡到主循环（旧内核"工具抛错整轮中止"就是反面教材）。
 */
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export type ToolOut = Record<string, unknown>;

/** 错误 → 单行人话 */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** try/catch 外壳：任何异常都变 { error } 返回 */
export async function guarded(fn: () => Promise<ToolOut> | ToolOut): Promise<ToolOut> {
  try {
    return await fn();
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/** 路径解析：相对路径按工作目录展开，支持 ~ */
export function resolvePath(p: unknown, workdir: string): string {
  let s = String(p ?? "").trim();
  if (!s) throw new Error("路径不能为空");
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(workdir, s);
}

/**
 * 写操作的路径护栏：解析成绝对路径，并**强制它落在工作区内**。
 *
 * 为什么必须拦（实测查出来的缺口）：
 *   · Write/Edit 标了 approval: "heuristic"，但审批判定只看 args.command，
 *     而它们没有这个字段 → 走不到审批分支 → **从不审批**
 *   · 而 resolvePath 只做 normalize，不检查边界
 *   → 合起来：「工作区内修改」这一档实际能 Write("/etc/anything")、
 *     甚至写 ~/.ssh/authorized_keys，**不问不拦**。档位的名字是假的。
 *
 * 为什么直接拒绝而不是弹审批：简单、可预测。真要越界写，
 * 走 Bash（那边有分类器 + 审批兜着），别让静默路径存在。
 */
export function resolveInsideWorkspace(p: unknown, workdir: string): string {
  const abs = resolvePath(p, workdir);
  const root = path.resolve(workdir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(
      "路径在工作区外，已拒绝：" + abs + "\n" +
      "当前工作区是 " + root + "。只允许写工作区内的文件。\n" +
      "如果确实要写到外面，请让用户确认后用 Bash（那条路径有审批）。",
    );
  }
  return abs;
}

/** 展示用相对路径（工作区内才转相对，统一 / 分隔） */
export function relPath(p: string, workdir: string): string {
  const r = path.relative(workdir, p);
  return r && !r.startsWith("..") ? r.split(path.sep).join("/") : p;
}

/** 必填字符串 */
export function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (v === undefined || v === null || v === "") throw new Error("缺少必填参数 " + key);
  return String(v);
}

/** 可选字符串 */
export function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return v === undefined || v === null || v === "" ? undefined : String(v);
}

/** 可选数字（非法/缺失返回 undefined） */
export function optNum(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 可选布尔，接受 "true"/"1"/"yes" */
export function optBool(input: Record<string, unknown>, key: string, def = false): boolean {
  const v = input[key];
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "off"].includes(s)) return false;
  return def;
}

export function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读字节：体积保护 + 目录判断 */
export function readBytes(abs: string, maxBytes: number): Buffer {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error("文件不存在：" + abs);
  }
  if (st.isDirectory()) throw new Error("这是目录，不是文件：" + abs);
  if (st.size > maxBytes) {
    throw new Error("文件过大（" + st.size + " 字节，上限 " + maxBytes + "）；请用 Bash 的 head/tail/sed 分段读取");
  }
  return fs.readFileSync(abs);
}

/** 读文本文件：二进制探测 + 体积保护 */
export function readTextFile(abs: string, maxBytes = 32 * 1024 * 1024): { text: string; bytes: number; binary: boolean } {
  const buf = readBytes(abs, maxBytes);
  const binary = buf.subarray(0, 8000).includes(0);
  return { text: binary ? "" : buf.toString("utf8"), bytes: buf.length, binary };
}

/** 确保目录存在 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 人类可读字节数 */
export function humanBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

// ── 文件遍历 / glob（Glob 与 Grep 共用，零依赖自己实现） ──────────────
import * as fsp from "node:fs/promises";

/** 默认跳过的目录：噪声大且几乎不会是用户意图 */
export const SKIP_DIRS = new Set(["node_modules", ".git", ".spill", ".next", "dist", "build", ".cache", "__pycache__", ".venv", "venv"]);

const RE_SPECIALS = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function escapeRe(s: string): string {
  let out = "";
  for (const ch of s) out += RE_SPECIALS.has(ch) ? "\\" + ch : ch;
  return out;
}

/** glob → RegExp：支持 ** / * / ? / {a,b} / [abc]；'**' 单独成段时跨目录 */
export function compileGlob(pattern: string): RegExp {
  const p = pattern.split(path.sep).join("/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") { i++; re += "(?:[^/]+/)*"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = p.indexOf("}", i);
      if (end < 0) re += "\\{";
      else { re += "(?:" + p.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")"; i = end; }
    } else if (c === "[") {
      const end = p.indexOf("]", i);
      if (end < 0) re += "\\[";
      else { re += p.slice(i, end + 1); i = end; }
    } else re += escapeRe(c);
  }
  return new RegExp("^" + re + "$");
}

export interface WalkResult { files: string[]; scanned: number; capped: boolean }

/** 递归遍历文件（只回文件）；默认跳过噪声目录，超上限即停 */
export async function walkFiles(opts: {
  root: string;
  match?: (abs: string, rel: string) => boolean;
  maxFiles?: number;
  maxDepth?: number;
  skipDirs?: Set<string>;
}): Promise<WalkResult> {
  const maxFiles = opts.maxFiles ?? 20000;
  const maxDepth = opts.maxDepth ?? 14;
  const skip = opts.skipDirs ?? SKIP_DIRS;
  const files: string[] = [];
  let scanned = 0;
  let capped = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || capped) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (capped) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      scanned++;
      if (scanned > maxFiles) { capped = true; return; }
      if (opts.match && !opts.match(abs, abs.slice(opts.root.length + 1).split(path.sep).join("/"))) continue;
      files.push(abs);
    }
  }

  await walk(opts.root, 0);
  return { files, scanned, capped };
}

