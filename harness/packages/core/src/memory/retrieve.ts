/**
 * 检索服务：把 L2 记忆转成可注入的上下文段落。
 * 铁律：记忆只是增强项 —— 任何异常都必须吞掉，绝不能影响对话。
 */
import { MEMORY_DEFAULTS } from "../constants.ts";
import { DEFAULT_SEARCH_LIMIT, DEFAULT_SEARCH_THRESHOLD, type MemoryStore, type SearchOptions } from "./store.ts";
import type { MemoryHit, MemoryLogger } from "./types.ts";
import { errorText, logWarn } from "./types.ts";

export const RELEVANT_MEMORIES_HEADER = "## Relevant Memories";
export const MEMORY_INTRO = "以下是与当前任务相关的长期记忆（可能不完整，仅作背景参考）：";
export const DEFAULT_CONTEXT_BUDGET = 2_000;

/** 查询改写函数；失败自动回退原查询 */
export type QueryRewriter = (query: string) => Promise<string> | string;

export interface RetrieveOptions extends SearchOptions {
  /** 查询改写（可选）；失败自动回退原查询 */
  rewriter?: QueryRewriter;
  /** 注入上下文的最大字符数 */
  maxChars?: number;
  /** 是否给每条记忆加 kind 标签（默认加） */
  withKind?: boolean;
}

export interface RetrievedContext {
  context: string;
  usedMemories: { id: string; content: string; score: number }[];
}

/** 单行化：记忆内容不允许把注入段落撑破 */
export function oneLine(s: string): string {
  return (s ?? "").replace(/\s*\n+\s*/g, " ").trim();
}

export class MemoryRetriever {
  #store: MemoryStore;
  #limit: number;
  #threshold: number;
  #rewriteEnabled: boolean;
  #rewriter?: QueryRewriter;
  #logger?: MemoryLogger;

  constructor(
    store: MemoryStore,
    defaults: {
      limit?: number; threshold?: number; queryRewriting?: boolean;
      /** 默认查询改写器（注入通道用；缺省 = 不改写） */
      rewriter?: QueryRewriter;
      logger?: MemoryLogger;
    } = {},
  ) {
    this.#store = store;
    this.#limit = defaults.limit ?? MEMORY_DEFAULTS.maxRetrievedMemories;
    this.#threshold = defaults.threshold ?? MEMORY_DEFAULTS.similarityThreshold;
    this.#rewriteEnabled = defaults.queryRewriting ?? MEMORY_DEFAULTS.queryRewriting;
    this.#rewriter = defaults.rewriter;
    this.#logger = defaults.logger;
  }

  get store(): MemoryStore {
    return this.#store;
  }

  /** 安全检索：失败一律返回空数组 */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<MemoryHit[]> {
    try {
      const q = (query ?? "").trim();
      if (!q || (opts.limit ?? this.#limit) <= 0) return [];
      const finalQuery = await this.#rewrite(q, opts.rewriter);
      return await this.#store.search(finalQuery, {
        limit: opts.limit ?? this.#limit,
        threshold: opts.threshold ?? this.#threshold,
        scope: opts.scope,
        status: opts.status ?? "active",
        touch: opts.touch,
      });
    } catch (e) {
      logWarn(this.#logger, "memory.retrieve 失败", { error: errorText(e) });
      return [];
    }
  }

  /** 组装注入段落；空结果返回 { context: "", usedMemories: [] } */
  async retrieveForContext(query: string, opts: RetrieveOptions = {}): Promise<RetrievedContext> {
    const empty: RetrievedContext = { context: "", usedMemories: [] };
    try {
      const hits = await this.retrieve(query, opts);
      if (!hits.length) return empty;
      const budget = Math.max(200, opts.maxChars ?? DEFAULT_CONTEXT_BUDGET);
      const withKind = opts.withKind !== false;
      const lines: string[] = [];
      const used: RetrievedContext["usedMemories"] = [];
      let size = RELEVANT_MEMORIES_HEADER.length + MEMORY_INTRO.length;
      for (const h of hits) {
        const text = oneLine(h.content);
        if (!text) continue;
        const line = "- " + (withKind ? "[" + h.kind + "] " : "") + text;
        if (lines.length && size + line.length > budget) break;
        lines.push(line);
        used.push({ id: h.id, content: h.content, score: h.score });
        size += line.length + 1;
      }
      if (!lines.length) return empty;
      return { context: [RELEVANT_MEMORIES_HEADER, MEMORY_INTRO, ...lines].join("\n"), usedMemories: used };
    } catch (e) {
      logWarn(this.#logger, "memory.retrieveForContext 失败", { error: errorText(e) });
      return empty;
    }
  }

  async #rewrite(query: string, rewriter?: QueryRewriter): Promise<string> {
    const rw = rewriter ?? this.#rewriter;
    if (!rw || !this.#rewriteEnabled) return query;
    try {
      const out = (await rw(query)) ?? "";
      const text = oneLine(String(out));
      return text.length >= 2 ? text : query;
    } catch (e) {
      logWarn(this.#logger, "memory 查询改写失败，回退原查询", { error: errorText(e) });
      return query;
    }
  }
}
