/**
 * Embedding 抽象（L2 向量层入口）
 *
 * 零依赖策略：默认提供确定性 hash 向量 —— 没有 embedding API 也能跑、能测、离线可用。
 * 真向量与 hash 向量靠 id / dim 隔离：检索只比对同 model 同维度的记忆。
 */

export interface EmbeddingProvider {
  /** provider 身份，写进 memories.embedding_model，用于检索时隔离不同模型 */
  id: string;
  /** 期望维度（真实维度以 embed() 返回的向量长度为准） */
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_EMBEDDING_DIM = 1_024;
/** 每个特征投两个独立散列桶（各半权重），把碰撞噪声压到可忽略 */
export const HASH_SALTS = ["#a", "#b"] as const;
export const EMBEDDING_TIMEOUT_MS = 30_000;
export const EMBEDDING_BATCH_SIZE = 32;

/** 余弦相似度；长度不等时按较短者比对，任一为零向量返回 0 */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** FNV-1a 32 位散列：确定性、零依赖 */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
const WORD_RE = /[a-z0-9][a-z0-9_+#.-]*/g;

/** 特征切分：ASCII 词 + 相邻词对 + CJK 单字 + CJK 双字 */
export function tokenize(text: string): string[] {
  const t = (text ?? "").toLowerCase().normalize("NFKC");
  const out: string[] = [];
  const words = t.match(WORD_RE) ?? [];
  out.push(...words);
  for (let i = 0; i + 1 < words.length; i++) out.push(words[i] + " " + words[i + 1]);
  const runs = t.match(CJK_RE) ?? [];
  for (const run of runs) {
    const chars = Array.from(run);
    out.push(...chars);
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** 原地单位化；零向量原样返回 */
export function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) * inv;
  return v;
}

/**
 * 确定性 hash 向量：同文本永远得到同向量，多字特征（词 / 双字）权重更高。
 * 每个特征投两个独立桶各半权重：单桶方案在 dim=256 时碰撞会吃掉真实相似度。
 */
export function hashVector(text: string, dim: number = DEFAULT_EMBEDDING_DIM): number[] {
  const d = Math.max(8, Math.floor(dim));
  const v = new Array<number>(d).fill(0);
  const scale = 1 / HASH_SALTS.length;
  for (const f of tokenize(text)) {
    const w = (f.length > 1 ? 2 : 1) * scale;
    for (const salt of HASH_SALTS) {
      const h = hash32(salt + f);
      const idx = h % d;
      v[idx] += ((h & 0x80000000) === 0 ? 1 : -1) * w;
    }
  }
  return l2normalize(v);
}

/** 零依赖降级方案：无 embedding API 时的默认实现 */
export function createHashEmbedding(dim: number = DEFAULT_EMBEDDING_DIM): EmbeddingProvider {
  const d = Math.max(8, Math.floor(dim));
  return {
    id: "hash-" + d,
    dim: d,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => hashVector(t, d));
    },
  };
}

// ── openai 兼容 embedding（/v1/embeddings） ──────────────────

export interface OpenAICompatEmbeddingConfig {
  kind?: "openai-compat";
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
  timeoutMs?: number;
  batchSize?: number;
  /** 是否发送 dimensions 字段（部分兼容服务不支持，默认发送） */
  sendDimensions?: boolean;
}

interface EmbeddingApiResponse {
  data?: { embedding?: number[]; index?: number }[];
  error?: { message?: string };
}

/** 创建真向量 provider；失败会抛错，调用方自行回退到 createHashEmbedding */
export function createEmbeddingProvider(cfg: OpenAICompatEmbeddingConfig): EmbeddingProvider {
  const dim = Math.max(0, Math.floor(cfg.dim || 0));
  const batchSize = Math.max(1, cfg.batchSize ?? EMBEDDING_BATCH_SIZE);
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/embeddings";
  const sendDimensions = cfg.sendDimensions !== false && dim > 0;

  const embedBatch = async (batch: string[]): Promise<number[][]> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        input: batch,
        ...(sendDimensions ? { dimensions: dim } : {}),
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? EMBEDDING_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("EMBEDDING_HTTP_" + res.status + ": " + body.slice(0, 200));
    }
    const json = (await res.json()) as EmbeddingApiResponse;
    const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== batch.length) {
      throw new Error("EMBEDDING_BAD_RESPONSE: " + (json.error?.message ?? rows.length + "/" + batch.length));
    }
    return rows.map((r) => {
      const e = r.embedding;
      if (!Array.isArray(e) || e.length === 0) throw new Error("EMBEDDING_EMPTY_VECTOR");
      return e.map((x) => Number(x));
    });
  };

  return {
    id: "openai-compat:" + cfg.model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        out.push(...(await embedBatch(texts.slice(i, i + batchSize))));
      }
      return out;
    },
  };
}
