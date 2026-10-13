/**
 * journal 的**大正文落盘**（从 session/journal.ts 搬出来：那边要守 400 行上限，而这一段自成一体）
 *
 * 语义只有一条：**不截断**。超过 JOURNAL_BLOB_AFTER_CHARS 的字符串落到
 * `<configDir>/logs/blobs/<sha1>.txt`，原位置换成自描述指针 `{ blob, chars, sha1 }`。
 *
 * 为什么要单独一个模块而不是几行内联：它是「模型可见 ⟺ 已记录」这句纪律的**唯一**执行点 ——
 * 旧日志（session/event-log.ts）把超过 2000 字符的字段切掉，正是要消灭的行为；这里一旦被改回
 * 「切短」，模型之后按恢复指针去日志里找细节就永远找不到，而任何断言都不会响。
 *
 * 落盘失败**不丢内容**：返回 null，调用方把正文原样留在行里（行大一点比内容没了强得多）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

/** 超过这个长度的字符串落盘成 blob（**不是**截断：正文必须完整可回读） */
export const JOURNAL_BLOB_AFTER_CHARS = 16_384;

/**
 * 递归洗字符串的深度上限。超过就不再往下洗 —— **保留原值**（宁可这一行很大，也不丢数据）；
 * 洗的目的只是把大正文挪出主文件，不是校验结构。
 */
export const MAX_SPILL_DEPTH = 6;

/** 大正文的指针（放在原值的位置上，读的人一眼看得出来这不是正文） */
export interface BlobRef {
  /** 相对 configDir 的路径，例如 `logs/blobs/<sha1>.txt`（绝对路径会让日志搬个家就全指空） */
  blob: string;
  /** 被挪走的正文长度（字符） */
  chars: number;
  sha1: string;
}

/** 落盘位置的两个根：blob 目录本身 + 用来算相对路径的 configDir（指针必须是相对的） */
export interface BlobRoots {
  blobDir: string;
  configDir: string;
}

/**
 * 递归把超长字符串换成 blob 指针；**拿不到落盘位置就原样返回**（见文件头：丢内容比行大糟得多）。
 */
export function shrinkForBlob(value: unknown, roots: BlobRoots, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= JOURNAL_BLOB_AFTER_CHARS) return value;
    return blobFor(value, roots) ?? value;
  }
  if (depth >= MAX_SPILL_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => shrinkForBlob(v, roots, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrinkForBlob(v, roots, depth + 1);
    return out;
  }
  return value;
}

/** 内容寻址落盘：sha1 命名 → 同一段正文永远同一份文件，重复写是幂等的 */
function blobFor(text: string, roots: BlobRoots): BlobRef | null {
  const sha1 = createHash("sha1").update(text, "utf8").digest("hex");
  const abs = join(roots.blobDir, `${sha1}.txt`);
  try {
    mkdirSync(roots.blobDir, { recursive: true });
    if (!existsSync(abs)) writeFileSync(abs, text);
  } catch { return null; }
  return { blob: relative(roots.configDir, abs).split(sep).join("/"), chars: text.length, sha1 };
}
