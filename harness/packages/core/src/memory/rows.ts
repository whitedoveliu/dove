/**
 * memories 行的编解码与查询辅助：Float32 BLOB、作用域过滤、ID、行 → 领域对象。
 * 单独一层是为了让 store.ts 保持在 400 行以内。
 */
import { randomUUID } from "node:crypto";
import type { MemoryRecord } from "./types.ts";
import { isMemoryKind, isMemoryStatus, normalizeScope } from "./types.ts";

/** 内容归一化：只留字母 / 数字 / CJK，用于精确去重比较 */
export function normalizeContent(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Float32 向量 → BLOB（独占 buffer，避免共享底层 ArrayBuffer） */
export function vecToBlob(vec: number[]): Uint8Array {
  const f = new Float32Array(vec);
  return new Uint8Array(f.buffer.slice(0));
}

/** BLOB → 向量；非 BLOB / 长度非法返回 null */
export function blobToVec(b: unknown): number[] | null {
  if (b == null) return null;
  let u8: Uint8Array;
  if (b instanceof Uint8Array) u8 = b;
  else if (b instanceof ArrayBuffer) u8 = new Uint8Array(b);
  else if (ArrayBuffer.isView(b)) u8 = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  else return null;
  const copy = new Uint8Array(u8); // 复制一份，保证 4 字节对齐且独占 buffer
  if (copy.byteLength < 4 || copy.byteLength % 4 !== 0) return null;
  return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength / 4));
}

/** 稳定可读的记忆 id：mem_YYYYMMDD_<rand> */
export function newMemoryId(now: number = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  return "mem_" + day + "_" + randomUUID().replace(/-/g, "").slice(0, 10);
}

export function safeParseMetadata(raw: unknown): Record<string, unknown> {
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 作用域过滤片段：支持单值或数组（如 [项目作用域, "global"]） */
export function scopeClause(
  scope: string | string[] | undefined,
): { sql: string; args: unknown[] } | null {
  if (!scope) return null;
  const list = (Array.isArray(scope) ? scope : [scope]).map((s) => normalizeScope(s)).filter(Boolean);
  if (!list.length) return null;
  return { sql: "scope IN (" + list.map(() => "?").join(",") + ")", args: list };
}

export function rowToRecord(r: Record<string, unknown>): MemoryRecord {
  return {
    id: String(r.id),
    content: String(r.content ?? ""),
    kind: isMemoryKind(r.kind) ? r.kind : "fact",
    scope: String(r.scope ?? "global"),
    status: isMemoryStatus(r.status) ? r.status : "active",
    metadata: safeParseMetadata(r.metadata),
    threadId: (r.thread_id as string | null) ?? null,
    messageId: (r.message_id as string | null) ?? null,
    confidence: Number(r.confidence ?? 1),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    useCount: Number(r.use_count ?? 0),
    embeddingModel: (r.embedding_model as string | null) ?? null,
    embeddingDim: r.embedding_dim == null ? null : Number(r.embedding_dim),
  };
}
