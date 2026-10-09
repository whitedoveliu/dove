/**
 * 向量层 L2：memories 表的读写 + JS 余弦检索
 *
 * - 向量以 Float32 BLOB 落盘（Float32Array.buffer）
 * - 维度自适应：写入时记录 embedding_model + embedding_dim，检索只比对同模型的向量
 * - 几千条以内直接内存比对即可，不引入 sqlite-vec
 */
import type { Db } from "../session/db.ts";
import { cosine, type EmbeddingProvider } from "./embedding.ts";
import {
  blobToVec,
  newMemoryId,
  normalizeContent,
  rowToRecord,
  safeParseMetadata,
  scopeClause,
  vecToBlob,
} from "./rows.ts";
import type {
  AddMemoryInput,
  ListOptions,
  MemoryHit,
  MemoryKind,
  MemoryRecord,
  MemoryStatus,
  SearchOptions,
  StoreStats,
  UpdatePatch,
  VectorRow,
} from "./types.ts";
import { isMemoryKind, isMemoryStatus, normalizeScope } from "./types.ts";

export { blobToVec, newMemoryId, normalizeContent, rowToRecord, vecToBlob } from "./rows.ts";
export type {
  AddMemoryInput,
  ListOptions,
  SearchOptions,
  SimilarPair,
  StoreStats,
  UpdatePatch,
  VectorRow,
} from "./types.ts";

export const DEFAULT_SEARCH_LIMIT = 5;
export const DEFAULT_SEARCH_THRESHOLD = 0.1;
/** 单次检索最多扫描的记忆条数 */
export const MAX_SCAN = 5_000;
/** findSimilar 是 O(n^2)（默认 1024 维），设上限防止睡眠流水线卡死 */
export const MAX_SIMILARITY_SCAN = 800;
export const BLOB_COLUMNS =
  "id, content, kind, scope, metadata, thread_id, message_id, status, confidence, embedding, " +
  "embedding_model, embedding_dim, created_at, updated_at, last_used_at, use_count";

export class MemoryStore {
  #db: Db;
  #embedder: EmbeddingProvider;

  constructor(db: Db, embedder: EmbeddingProvider) {
    this.#db = db;
    this.#embedder = embedder;
  }

  get db(): Db {
    return this.#db;
  }

  get embedder(): EmbeddingProvider {
    return this.#embedder;
  }

  get modelId(): string {
    return this.#embedder.id;
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.#embedder.embed(texts);
  }

  // ── 写入 ───────────────────────────────────────────────────

  async add(input: AddMemoryInput): Promise<string> {
    const content = (input.content ?? "").trim();
    if (!content) throw new Error("MEMORY_EMPTY_CONTENT");
    const now = input.createdAt ?? Date.now();
    const id = input.id ?? newMemoryId(now);
    let vec = input.embedding ?? null;
    if (!vec || !vec.length) {
      const [v] = await this.#embedder.embed([content]);
      vec = v && v.length ? v : null;
    }
    const kind: MemoryKind = isMemoryKind(input.kind) ? input.kind : "fact";
    const status: MemoryStatus = isMemoryStatus(input.status) ? input.status : "active";
    this.#db.run(
      "INSERT INTO memories(id, content, kind, scope, metadata, thread_id, message_id, status, confidence, " +
        "embedding, embedding_model, embedding_dim, created_at, updated_at, last_used_at, use_count) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
      id,
      content,
      kind,
      normalizeScope(input.scope),
      JSON.stringify(input.metadata ?? {}),
      input.threadId ?? null,
      input.messageId ?? null,
      status,
      input.confidence ?? 1,
      vec ? vecToBlob(vec) : null,
      vec ? this.#embedder.id : null,
      vec ? vec.length : null,
      now,
      now,
      null,
    );
    return id;
  }

  /** 批量写入：先合并一次 embedding 调用 */
  async addMany(inputs: AddMemoryInput[]): Promise<string[]> {
    const valid = (inputs ?? [])
      .map((i) => ({ ...i, content: (i.content ?? "").trim() }))
      .filter((i) => i.content.length > 0);
    if (!valid.length) return [];
    const need = valid.filter((i) => !i.embedding || !i.embedding.length);
    if (need.length) {
      const vecs = await this.#embedder.embed(need.map((i) => i.content));
      need.forEach((i, k) => {
        i.embedding = vecs[k];
      });
    }
    const ids: string[] = [];
    for (const i of valid) ids.push(await this.add(i));
    return ids;
  }

  /** 重新嵌入并覆盖内容（合并流水线用） */
  async setContent(id: string, content: string): Promise<void> {
    const text = (content ?? "").trim();
    if (!text) throw new Error("MEMORY_EMPTY_CONTENT");
    const [vec] = await this.#embedder.embed([text]);
    const now = Date.now();
    if (vec && vec.length) {
      this.#db.run(
        "UPDATE memories SET content=?, embedding=?, embedding_model=?, embedding_dim=?, updated_at=? WHERE id=?",
        text,
        vecToBlob(vec),
        this.#embedder.id,
        vec.length,
        now,
        id,
      );
    } else {
      this.#db.run(
        "UPDATE memories SET content=?, embedding=NULL, embedding_model=NULL, embedding_dim=NULL, updated_at=? WHERE id=?",
        text,
        now,
        id,
      );
    }
  }

  // ── 检索 ───────────────────────────────────────────────────

  async search(query: string, opts: SearchOptions = {}): Promise<MemoryHit[]> {
    const q = (query ?? "").trim();
    if (!q) return [];
    const [vec] = await this.#embedder.embed([q]);
    if (!vec || !vec.length) return [];
    return this.searchByVector(vec, opts);
  }

  /** 用现成向量检索（去重、睡眠流水线复用） */
  async searchByVector(vec: number[], opts: SearchOptions = {}): Promise<MemoryHit[]> {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const threshold = opts.threshold ?? DEFAULT_SEARCH_THRESHOLD;
    if (limit <= 0 || !vec.length) return [];
    const where: string[] = ["embedding_model = ?", "embedding_dim = ?"];
    const args: unknown[] = [this.#embedder.id, vec.length];
    const status = opts.status ?? "active";
    if (status !== "all") {
      where.push("status = ?");
      args.push(status);
    }
    const sc = scopeClause(opts.scope);
    if (sc) {
      where.push(sc.sql);
      args.push(...sc.args);
    }
    const rows = this.#db.all(
      "SELECT " + BLOB_COLUMNS + " FROM memories WHERE " + where.join(" AND ") + " ORDER BY created_at DESC LIMIT ?",
      ...args,
      MAX_SCAN,
    );
    const hits: MemoryHit[] = [];
    for (const row of rows) {
      const v = blobToVec(row.embedding);
      if (!v || v.length !== vec.length) continue;
      const score = cosine(vec, v);
      if (score < threshold) continue;
      hits.push({
        id: String(row.id),
        content: String(row.content ?? ""),
        score,
        kind: isMemoryKind(row.kind) ? row.kind : "fact",
        createdAt: Number(row.created_at ?? 0),
        metadata: safeParseMetadata(row.metadata),
      });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    if (opts.touch !== false && top.length) this.#touch(top.map((h) => h.id));
    return top;
  }

  list(opts: ListOptions = {}): MemoryRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    const status = opts.status ?? "active";
    if (status !== "all") {
      where.push("status = ?");
      args.push(status);
    }
    const sc = scopeClause(opts.scope);
    if (sc) {
      where.push(sc.sql);
      args.push(...sc.args);
    }
    const sql =
      "SELECT " +
      BLOB_COLUMNS +
      " FROM memories" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    const limit = Math.max(1, Math.min(opts.limit ?? 200, MAX_SCAN));
    const offset = Math.max(0, opts.offset ?? 0);
    return this.#db.all(sql, ...args, limit, offset).map((r) => rowToRecord(r));
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.#db.get("SELECT " + BLOB_COLUMNS + " FROM memories WHERE id = ?", id);
    return row ? rowToRecord(row) : undefined;
  }

  // ── 更新 / 归档 ────────────────────────────────────────────

  update(id: string, patch: UpdatePatch): void {
    const cur = this.get(id);
    if (!cur) return;
    const sets: string[] = [];
    const args: unknown[] = [];
    if (typeof patch.content === "string") {
      const text = patch.content.trim();
      if (text) {
        sets.push("content = ?");
        args.push(text);
        if (patch.embedding && patch.embedding.length) {
          sets.push("embedding = ?", "embedding_model = ?", "embedding_dim = ?");
          args.push(vecToBlob(patch.embedding), this.#embedder.id, patch.embedding.length);
        } else {
          // 内容变了但没给新向量：置空等重建，避免脏向量被检索到
          sets.push("embedding = NULL", "embedding_model = NULL", "embedding_dim = NULL");
        }
      }
    }
    if (isMemoryKind(patch.kind)) {
      sets.push("kind = ?");
      args.push(patch.kind);
    }
    if (typeof patch.scope === "string" && patch.scope.trim()) {
      sets.push("scope = ?");
      args.push(normalizeScope(patch.scope));
    }
    if (isMemoryStatus(patch.status)) {
      sets.push("status = ?");
      args.push(patch.status);
    }
    if (typeof patch.confidence === "number") {
      sets.push("confidence = ?");
      args.push(patch.confidence);
    }
    if (patch.metadata) {
      sets.push("metadata = ?");
      args.push(JSON.stringify({ ...cur.metadata, ...patch.metadata }));
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    args.push(Date.now(), id);
    this.#db.run("UPDATE memories SET " + sets.join(", ") + " WHERE id = ?", ...args);
  }

  /** 归档（软删除）：保留审计信息，不物理删除 */
  archive(id: string, reason: string, mergedInto?: string): void {
    const cur = this.get(id);
    if (!cur) return;
    const meta: Record<string, unknown> = {
      ...cur.metadata,
      archivedReason: reason,
      archivedAt: Date.now(),
    };
    if (mergedInto) meta.mergedInto = mergedInto;
    this.#db.run(
      "UPDATE memories SET status='archived', metadata=?, updated_at=? WHERE id=?",
      JSON.stringify(meta),
      Date.now(),
      id,
    );
  }

  // ── 相似度（睡眠流水线） ───────────────────────────────────

  /** 相似度合并候选：同 model、active、带向量的记忆两两比对 */
  findSimilar(threshold: number, limit = 100): SimilarPair[] {
    const rows = this.loadVectors();
    const pairs: SimilarPair[] = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      if (!a) continue;
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j];
        if (!b) continue;
        const score = cosine(a.vector, b.vector);
        if (score >= threshold) pairs.push({ a: a.id, b: b.id, score });
      }
    }
    pairs.sort((x, y) => y.score - x.score);
    return pairs.slice(0, Math.max(0, limit));
  }

  loadVectors(): VectorRow[] {
    const rows = this.#db.all(
      "SELECT id, content, kind, scope, embedding, created_at, use_count, confidence FROM memories " +
        "WHERE status = 'active' AND embedding_model = ? ORDER BY created_at ASC LIMIT ?",
      this.#embedder.id,
      MAX_SIMILARITY_SCAN,
    );
    const out: VectorRow[] = [];
    for (const r of rows) {
      const v = blobToVec(r.embedding);
      if (!v || !v.length) continue;
      out.push({
        id: String(r.id),
        content: String(r.content ?? ""),
        kind: isMemoryKind(r.kind) ? r.kind : "fact",
        scope: String(r.scope ?? "global"),
        createdAt: Number(r.created_at ?? 0),
        useCount: Number(r.use_count ?? 0),
        confidence: Number(r.confidence ?? 1),
        vector: v,
      });
    }
    return out;
  }

  stats(): StoreStats {
    const count = (sql: string, ...args: unknown[]): number => Number(this.#db.get(sql, ...args)?.c ?? 0);
    return {
      total: count("SELECT COUNT(*) AS c FROM memories"),
      active: count("SELECT COUNT(*) AS c FROM memories WHERE status = 'active'"),
      pending: count("SELECT COUNT(*) AS c FROM memories WHERE status = 'pending'"),
      archived: count("SELECT COUNT(*) AS c FROM memories WHERE status = 'archived'"),
      indexed: count(
        "SELECT COUNT(*) AS c FROM memories WHERE embedding_model = ? AND embedding IS NOT NULL",
        this.#embedder.id,
      ),
    };
  }

  /** 命中回写（失败不影响检索结果） */
  #touch(ids: string[]): void {
    const now = Date.now();
    try {
      this.#db.tx(() => {
        for (const id of ids) {
          this.#db.run("UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?", now, id);
        }
      });
    } catch {
      // ignore
    }
  }
}
