/**
 * Markdown + YAML frontmatter 小工具（情绪文件专用）
 * 纪律：情绪文件必须人可读、可直接手改 —— frontmatter 只放简单标量，正文是给人看的备注。
 * 零依赖硬约束：不引 YAML 库，只认 `key: value` 这一种子集。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type FrontmatterValue = string | number | boolean;

export interface MarkdownDoc {
  data: Record<string, FrontmatterValue>;
  /** frontmatter 之后的正文（已去掉首尾空行） */
  body: string;
}

/** 标量反序列化：去引号，数字 / 布尔尽量还原成原生类型 */
function coerce(value: string): FrontmatterValue {
  const v = value.replace(/^["']|["']$/g, "");
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

/** 标量序列化：换行会毁掉 frontmatter，一律压成空格 */
function scalar(value: FrontmatterValue): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

/** 解析 `---` 包裹的 frontmatter；没有 frontmatter 时 data 为空、body 为全文 */
export function parseFrontmatter(text: string): MarkdownDoc {
  const raw = (text ?? "").replace(/^\uFEFF/, "");
  if (!raw.startsWith("---")) return { data: {}, body: raw.trim() };
  const lines = raw.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { data: {}, body: raw.trim() };
  const data: Record<string, FrontmatterValue> = {};
  for (const line of lines.slice(1, end)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf(":");
    if (idx <= 0) continue;
    const key = t.slice(0, idx).trim();
    if (!key) continue;
    data[key] = coerce(t.slice(idx + 1).trim());
  }
  return { data, body: lines.slice(end + 1).join("\n").trim() };
}

/** 序列化：空值（undefined / ""）自动省略，人读起来更干净 */
export function serializeFrontmatter(data: Record<string, FrontmatterValue>, body = ""): string {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined && data[k] !== "");
  const head = keys.map((k) => `${k}: ${scalar(data[k]!)}`);
  const tail = (body ?? "").trim();
  return ["---", ...head, "---", "", tail, ""].join("\n");
}

/** 读 markdown 文件；不存在或读失败返回 null（调用方给默认值） */
export function readMarkdown(path: string): MarkdownDoc | null {
  if (!existsSync(path)) return null;
  try {
    return parseFrontmatter(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeMarkdownAtomic(
  path: string,
  data: Record<string, FrontmatterValue>,
  body = "",
): void {
  atomicWriteText(path, serializeFrontmatter(data, body));
}

/** 原子写：临时文件 fsync 后 rename，避免半截文件被下一轮读到 */
export function atomicWriteText(target: string, content: string): void {
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理失败可忽略
    }
    throw e;
  }
}

/** 文件名安全化：只留 [A-Za-z0-9._-]（会话 id 可能带奇怪字符） */
export function safeId(id?: string, fallback = "default"): string {
  const s = String(id ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 64);
  return s || fallback;
}
