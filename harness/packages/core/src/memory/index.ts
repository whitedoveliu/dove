/**
 * 记忆系统统一门面（MemoryService）：loop / tools / server 只认这一个入口。
 * 组合 L1 文件层、L2 向量层、检索 / 写入 / 睡眠流水线，并把所有异常挡在内部。
 */
import type { ChatMessage, Provider } from "../providers/types.ts";
import type { Db } from "../session/db.ts";
import { MEMORY_INJECT_THRESHOLD, MEMORY_INJECT_THRESHOLD_HASH } from "../constants.ts";
import { createHashEmbedding, type EmbeddingProvider } from "./embedding.ts";
import { MemoryFiles, type PromptFiles } from "./files.ts";
import { MemoryRetriever, type QueryRewriter, type RetrieveOptions, type RetrievedContext } from "./retrieve.ts";
import { rewriteQuery } from "./rewrite.ts";
import { runSleepCycle, startSleepScheduler, type SleepOptions, type SleepStats } from "./sleep.ts";
import { MemoryStore } from "./store.ts";
import { MemoryWriter, extractMemories, type WriteResult } from "./write.ts";
import type { MemoryConfig, MemoryHit, MemoryKind, MemoryLlm, MemoryLogger, SleepConfig } from "./types.ts";
import { errorText, logWarn, normalizeScope, resolveMemoryConfig, resolveSleepConfig } from "./types.ts";

/**
 * 注入阈值按后端分档：hash 降级的分数尺度只有真向量的三分之一左右
 * （相关 0.13~0.39 vs 0.51~0.74），用同一个阈值必然一边漏一边脏。
 */
export function injectThresholdFor(modelId: string): number {
  return (modelId ?? "").startsWith("hash") ? MEMORY_INJECT_THRESHOLD_HASH : MEMORY_INJECT_THRESHOLD;
}

export interface MemoryServiceOptions {
  db: Db;
  configDir: string;
  /** 覆盖默认（规则版）查询改写器；想用 LLM 改写就从这里注入 */
  rewriter?: QueryRewriter;
  /** 缺省用确定性 hash 向量，保证没有 embedding API 也能工作 */
  embedder?: EmbeddingProvider;
  llm?: MemoryLlm;
  logger?: MemoryLogger;
  /** 默认作用域：global 或项目 id（自动补 project: 前缀） */
  scope?: string;
  config?: Partial<MemoryConfig>;
  sleep?: Partial<SleepConfig>;
}

export class MemoryService {
  readonly files: MemoryFiles;
  readonly store: MemoryStore;
  readonly retriever: MemoryRetriever;
  readonly writer: MemoryWriter;

  #llm?: MemoryLlm;
  #logger?: MemoryLogger;
  #config: MemoryConfig;
  #sleep: SleepConfig;
  #scope: string;
  #scheduler: { stop(): void } | null = null;

  constructor(opts: MemoryServiceOptions) {
    this.#llm = opts.llm;
    this.#logger = opts.logger;
    this.#config = resolveMemoryConfig(opts.config);
    this.#sleep = resolveSleepConfig(opts.sleep);
    this.#scope = normalizeScope(opts.scope);
    this.files = new MemoryFiles(opts.configDir);
    this.store = new MemoryStore(opts.db, opts.embedder ?? createHashEmbedding());
    this.retriever = new MemoryRetriever(this.store, {
      limit: this.#config.maxRetrievedMemories,
      // 注入通道的阈值比 recall 高，且按后端分档：白送的上下文宁缺毋滥（理由见 constants.ts）
      threshold: injectThresholdFor(this.store.modelId),
      queryRewriting: this.#config.queryRewriting,
      rewriter: opts.rewriter ?? rewriteQuery,
      logger: opts.logger,
    });
    this.writer = new MemoryWriter(this.store, { defaultScope: this.#scope, logger: opts.logger });
  }

  get enabled(): boolean {
    return this.#config.enabled;
  }

  get scope(): string {
    return this.#scope;
  }

  get config(): MemoryConfig {
    return this.#config;
  }

  get embedder(): EmbeddingProvider {
    return this.store.embedder;
  }

  /** 首次运行创建默认模板与目录；可重复调用 */
  async init(): Promise<void> {
    try {
      this.files.ensureDefaults();
    } catch (e) {
      logWarn(this.#logger, "memory.init 失败", { error: errorText(e) });
    }
  }

  /** 语义检索（tools 的 recall 入口）；失败返回空数组 */
  async recall(query: string, limit?: number): Promise<MemoryHit[]> {
    if (!this.#config.enabled) return [];
    try {
      return await this.store.search(query, {
        limit: limit ?? this.#config.maxRetrievedMemories,
        threshold: this.#config.similarityThreshold,
        scope: this.#scopeList(),
        status: "active",
      });
    } catch (e) {
      logWarn(this.#logger, "memory.recall 失败", { error: errorText(e) });
      return [];
    }
  }

  /** 显式写入一条记忆；去重命中时返回既有 id */
  async remember(content: string, kind?: MemoryKind, scope?: string): Promise<string> {
    const r = await this.writer.write({ content, kind, scope: scope ?? this.#scope });
    return r.id;
  }

  /** 组装要注入 prompt 的记忆段落；失败返回空 */
  async retrieveForContext(query: string, opts: RetrieveOptions = {}): Promise<RetrievedContext> {
    if (!this.#config.enabled || !this.#config.autoRetrieve) return { context: "", usedMemories: [] };
    return this.retriever.retrieveForContext(query, { scope: this.#scopeList(), ...opts });
  }

  /** L1 文件内容（SOUL / USER / MEMORY / 日记），空的已剔除 */
  async loadFilesForPrompt(): Promise<PromptFiles> {
    try {
      this.files.ensureDefaults();
      return this.files.loadForPrompt();
    } catch (e) {
      logWarn(this.#logger, "memory.loadFilesForPrompt 失败", { error: errorText(e) });
      return { soul: "", user: "", memory: "", daily: [] };
    }
  }

  async captureDaily(content: string): Promise<void> {
    try {
      this.files.captureDaily(content);
    } catch (e) {
      logWarn(this.#logger, "memory.captureDaily 失败", { error: errorText(e) });
    }
  }

  /** 读一个持久化文件（面板编辑用） */
  readFile(name: string): string {
    try { return this.files.read(name); } catch { return ""; }
  }

  /** 写一个持久化文件（面板编辑用）；只允许白名单文件名 */
  async writeFile(name: string, content: string): Promise<void> {
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "");
    if (!safe) throw new Error("非法文件名");
    this.files.write(safe, content);
  }

  /** 列出记忆（面板用） */
  async listForApi(scope?: string): Promise<unknown[]> {
    return this.store.list({ scope, limit: 500 });
  }

  /** 睡眠合并流水线（手动跑一次） */
  async runSleep(opts: SleepOptions = {}): Promise<SleepStats> {
    return runSleepCycle(this.store, { llm: this.#llm, logger: this.#logger, ...this.#sleep, ...opts });
  }

  /** 从对话文本抽记忆并落库，返回写入（或命中重复）的 id */
  async rememberFromConversation(text: string, opts: { scope?: string; max?: number } = {}): Promise<string[]> {
    if (!this.#config.enabled || !this.#config.autoSummarize) return [];
    const scope = normalizeScope(opts.scope ?? this.#scope);
    const items = await extractMemories(this.#llm, text, { scope, max: opts.max, logger: this.#logger });
    if (!items.length) return [];
    const results: WriteResult[] = await this.writer.writeMany(
      items.map((i) => ({ content: i.content, kind: i.kind, scope: i.scope })),
    );
    return results.map((r) => r.id);
  }

  /**
   * 把一轮对话浓缩成一行日记（用户选的方案：每轮 LLM 总结）。
   *
   * 为什么单独做一层而不是直接调 captureDaily：
   * 日记是**给人读的流水**（也是系统提示词 S11 槽位的内容），
   * 把「用户：xxx\n\nDove：yyy」原样塞进去只会变成一团噪音。
   * 交给 LLM 压一行，才符合「日记」的语义。
   *
   * 失败一律吞掉 —— 日记是锦上添花，不能因为一次 LLM 抖动就影响主流程。
   */
  async captureDiary(exchange: string): Promise<void> {
    if (!this.#config.enabled) return;
    const text = (exchange ?? "").trim();
    if (text.length < 10) return;
    try {
      const line = await this.#llm.complete(
        `把下面这轮对话浓缩成**一行**中文日记。\n\n` +
        `要求：\n` +
        `- 不超过 40 字，只记以后还用得上的：做了什么、做了什么决定、得出了什么结论\n` +
        `- 不要写「用户问了X助手答了Y」这种没有信息量的话\n` +
        `- 不要加引号、不要编号、不要「- 」前缀\n` +
        `- 如果这轮确实没有值得记的（寒暄、闲聊、重复），**只回一个空字符串**\n\n` +
        `对话：\n${text.slice(0, 4000)}`,
        { system: "你是一个只写事实的日记助手。输出一行，不要任何解释。", maxTokens: 120, temperature: 0 },
      );
      const one = (line ?? "").trim().replace(/^[-*\d.、\s]+/, "").split("\n")[0]!.trim();
      if (one.length >= 4) this.captureDaily(one.slice(0, 120));
    } catch (e) {
      logWarn(this.#logger, "memory.captureDiary 失败", { error: errorText(e) });
    }
  }

  /** 启动每天 03:00 的睡眠调度；重复调用只保留最新一个 */
  startScheduler(): { stop(): void } {
    this.stopScheduler();
    this.#scheduler = startSleepScheduler(this.store, { llm: this.#llm, logger: this.#logger, ...this.#sleep });
    return this.#scheduler;
  }

  stopScheduler(): void {
    this.#scheduler?.stop();
    this.#scheduler = null;
  }

  /** 项目作用域时同时检索 global */
  #scopeList(): string[] | undefined {
    return this.#scope === "global" ? undefined : [this.#scope, "global"];
  }
}

/** 把 providers 的 Provider 适配成记忆用的最小 LLM 接口 */
export function providerLlm(provider: Provider, model: string): MemoryLlm {
  return {
    async complete(prompt, opts) {
      const messages: ChatMessage[] = [];
      if (opts?.system) messages.push({ role: "system", content: opts.system });
      messages.push({ role: "user", content: prompt });
      const r = await provider.stream({
        model,
        messages,
        temperature: opts?.temperature ?? 0,
        maxTokens: opts?.maxTokens ?? 1_024,
      });
      return r.text ?? "";
    },
  };
}

// ── 便捷再导出（上层只 import memory/index.ts 即可） ──────────

export { cosine, createEmbeddingProvider, createHashEmbedding } from "./embedding.ts";
export { MemoryFiles } from "./files.ts";
export { MemoryRetriever } from "./retrieve.ts";
export { rewriteQuery } from "./rewrite.ts";
export { runSleepCycle, startSleepScheduler } from "./sleep.ts";
export { MemoryStore } from "./store.ts";
export { extractMemories, MEMORY_EXTRACT_PROMPT, MemoryWriter } from "./write.ts";

export type { EmbeddingProvider } from "./embedding.ts";
export type { PromptFiles } from "./files.ts";
export type { QueryRewriter, RetrieveOptions, RetrievedContext } from "./retrieve.ts";
export type { SleepOptions, SleepStats } from "./sleep.ts";
export type { WriteMemoryInput, WriteResult } from "./write.ts";
export type {
  AddMemoryInput,
  ListOptions,
  MemoryConfig,
  MemoryHit,
  MemoryKind,
  MemoryLlm,
  MemoryLogger,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  SearchOptions,
  SleepConfig,
} from "./types.ts";
