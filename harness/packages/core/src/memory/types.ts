/**
 * 记忆系统共享类型 / 配置
 * 纪律：本目录只依赖 constants / session / providers，绝不 import 上层（loop / tools / context / server）。
 */
import { MEMORY_DEFAULTS, MEMORY_SLEEP_DEFAULTS } from "../constants.ts";

// ── 种类 / 状态（用 type + const 数组，不用 enum：erasable syntax 约束） ──

/** 记忆种类：只记稳定高价值信息 */
export type MemoryKind = "fact" | "preference" | "taste" | "decision" | "feedback" | "reference";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "preference",
  "taste",
  "decision",
  "feedback",
  "reference",
];

export type MemoryStatus = "active" | "pending" | "archived";

export const MEMORY_STATUSES: readonly MemoryStatus[] = ["active", "pending", "archived"];

export function isMemoryKind(v: unknown): v is MemoryKind {
  return typeof v === "string" && (MEMORY_KINDS as readonly string[]).includes(v);
}

export function isMemoryStatus(v: unknown): v is MemoryStatus {
  return typeof v === "string" && (MEMORY_STATUSES as readonly string[]).includes(v);
}

/** 作用域：global（全局）/ project:<id>（项目内） */
export type MemoryScope = string;

/** 归一化作用域：空值回退 fallback，裸 id 自动补 project: 前缀 */
export function normalizeScope(v: unknown, fallback = "global"): MemoryScope {
  const s = typeof v === "string" ? v.trim() : "";
  if (s === "global") return "global";
  if (!s) return fallback;
  return s.includes(":") ? s : "project:" + s;
}

// ── 日志（最小接口，避免依赖 server 的 logger） ──────────────

export interface MemoryLogger {
  debug?(msg: string, data?: Record<string, unknown>): void;
  info?(msg: string, data?: Record<string, unknown>): void;
  warn?(msg: string, data?: Record<string, unknown>): void;
  error?(msg: string, data?: Record<string, unknown>): void;
}

export function logWarn(logger: MemoryLogger | undefined, msg: string, data?: Record<string, unknown>): void {
  try {
    logger?.warn?.(msg, data);
  } catch {
    // 日志本身失败不影响主流程
  }
}

export function logDebug(logger: MemoryLogger | undefined, msg: string, data?: Record<string, unknown>): void {
  try {
    logger?.debug?.(msg, data);
  } catch {
    // ignore
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── LLM 最小接口（抽取 / 查询改写 / 合并判定都走它） ──────────

export interface MemoryLlm {
  complete(
    prompt: string,
    opts?: { system?: string; maxTokens?: number; temperature?: number },
  ): Promise<string>;
}

// ── 领域记录 ─────────────────────────────────────────────────

/** 记忆记录（memories 行的领域视图） */
export interface MemoryRecord {
  id: string;
  content: string;
  kind: MemoryKind;
  scope: string;
  status: MemoryStatus;
  metadata: Record<string, unknown>;
  threadId?: string | null;
  messageId?: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number | null;
  useCount: number;
  embeddingModel?: string | null;
  embeddingDim?: number | null;
}

/** 检索命中 */
export interface MemoryHit {
  id: string;
  content: string;
  score: number;
  kind: MemoryKind;
  createdAt: number;
  metadata: Record<string, unknown>;
}

// ── 配置（默认值全部来自 constants.ts） ──────────────────────

export interface MemoryConfig {
  enabled: boolean;
  autoSummarize: boolean;
  autoRetrieve: boolean;
  maxRetrievedMemories: number;
  similarityThreshold: number;
  queryRewriting: boolean;
}

export function resolveMemoryConfig(c?: Partial<MemoryConfig>): MemoryConfig {
  return {
    enabled: c?.enabled ?? MEMORY_DEFAULTS.enabled,
    autoSummarize: c?.autoSummarize ?? MEMORY_DEFAULTS.autoSummarize,
    autoRetrieve: c?.autoRetrieve ?? MEMORY_DEFAULTS.autoRetrieve,
    maxRetrievedMemories: c?.maxRetrievedMemories ?? MEMORY_DEFAULTS.maxRetrievedMemories,
    similarityThreshold: c?.similarityThreshold ?? MEMORY_DEFAULTS.similarityThreshold,
    queryRewriting: c?.queryRewriting ?? MEMORY_DEFAULTS.queryRewriting,
  };
}

export interface SleepConfig {
  /** 每天几点跑（HH:MM，本地时区） */
  dailyTime: string;
  /** 临时记忆 TTL（天） */
  ttlDays: number;
  /** 直接合并阈值 */
  mergeThreshold: number;
  /** LLM 判定带下界 */
  llmLow: number;
  llmEnabled: boolean;
  llmBatchSize: number;
}

export function resolveSleepConfig(c?: Partial<SleepConfig>): SleepConfig {
  return {
    dailyTime: c?.dailyTime ?? MEMORY_SLEEP_DEFAULTS.dailyTime,
    ttlDays: c?.ttlDays ?? MEMORY_SLEEP_DEFAULTS.temporaryTtlDays,
    mergeThreshold: c?.mergeThreshold ?? MEMORY_SLEEP_DEFAULTS.similarityMergeThreshold,
    llmLow: c?.llmLow ?? MEMORY_SLEEP_DEFAULTS.llmMergeLow,
    llmEnabled: c?.llmEnabled ?? MEMORY_SLEEP_DEFAULTS.llmEnabled,
    llmBatchSize: c?.llmBatchSize ?? MEMORY_SLEEP_DEFAULTS.llmBatchSize,
  };
}

// ── MemoryStore 的输入 / 输出契约 ────────────────────────────

export interface AddMemoryInput {
  content: string;
  kind?: MemoryKind;
  scope?: string;
  metadata?: Record<string, unknown>;
  threadId?: string | null;
  messageId?: string | null;
  status?: MemoryStatus;
  confidence?: number;
  /** 预计算向量（批量写入时复用，避免重复调 embedder） */
  embedding?: number[];
  createdAt?: number;
  id?: string;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  scope?: string | string[];
  status?: MemoryStatus | "all";
  /** 命中后是否更新 last_used_at / use_count（默认 true） */
  touch?: boolean;
}

export interface ListOptions {
  scope?: string | string[];
  /** 默认只看 active；传 "all" 才包含已归档 */
  status?: MemoryStatus | "all";
  limit?: number;
  offset?: number;
}

export interface UpdatePatch {
  content?: string;
  kind?: MemoryKind;
  scope?: string;
  status?: MemoryStatus;
  confidence?: number;
  metadata?: Record<string, unknown>;
  /** content 变更时必须一并给新向量，否则向量会被置空（等重建） */
  embedding?: number[];
}

export interface SimilarPair {
  a: string;
  b: string;
  score: number;
}

export interface VectorRow {
  id: string;
  content: string;
  kind: MemoryKind;
  scope: string;
  createdAt: number;
  useCount: number;
  confidence: number;
  vector: number[];
}

export interface StoreStats {
  total: number;
  active: number;
  pending: number;
  archived: number;
  indexed: number;
}

