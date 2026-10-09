/**
 * 睡眠合并流水线（默认每天 03:00 跑一次）
 *
 * 顺序：精确去重归档 → 过期清理（TTL）→ 孤儿清理 → 相似度合并
 *   - 余弦 > 0.95：直接合并（保留最常用 / 最早的一条，其余归档并记 mergedInto）
 *   - 0.75 ~ 0.95：交 LLM 判定，LLM 缺失时整段跳过
 * 每次运行都会写 memory_sleep_runs 表。
 */
import { randomUUID } from "node:crypto";
import { MEMORY_SLEEP_DEFAULTS } from "../constants.ts";
import { normalizeContent, type MemoryStore, type SimilarPair, type VectorRow } from "./store.ts";
import type { MemoryLlm, MemoryLogger, MemoryRecord } from "./types.ts";
import { errorText, logWarn } from "./types.ts";
import { parseJsonLoose } from "./write.ts";

export const MAX_SLEEP_SCAN = 5_000;
export const MAX_MERGE_PAIRS = 200;
export const MAX_MERGE_TEXT_CHARS = 200;
export const DAY_MS = 86_400_000;

export interface SleepOptions {
  trigger?: string;
  /** 便于测试注入的时间戳 */
  now?: number;
  ttlDays?: number;
  mergeThreshold?: number;
  llmLow?: number;
  llm?: MemoryLlm;
  llmEnabled?: boolean;
  llmBatchSize?: number;
  dryRun?: boolean;
  logger?: MemoryLogger;
  /** 调度器用：HH:MM */
  dailyTime?: string;
}

export interface SleepStats {
  runId: string;
  status: "ok" | "error";
  trigger: string;
  /** 以下计数与 memory_sleep_runs 的列一一对应 */
  examined: number;
  archivedExact: number;
  archivedExpired: number;
  archivedOrphan: number;
  archivedSimilarity: number;
  merged: number;
  llmChecked: number;
  llmMerged: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  note?: string;
}

// ── 主流程 ───────────────────────────────────────────────────

export async function runSleepCycle(store: MemoryStore, opts: SleepOptions = {}): Promise<SleepStats> {
  const logger = opts.logger;
  const startedAt = opts.now ?? Date.now();
  const trigger = opts.trigger ?? "manual";
  const dryRun = opts.dryRun === true;
  const runId = "slp_" + randomUUID().replace(/-/g, "").slice(0, 12);
  const notes: string[] = [];
  const stats: SleepStats = {
    runId, status: "ok", trigger,
    examined: 0, archivedExact: 0, archivedExpired: 0, archivedOrphan: 0, archivedSimilarity: 0,
    merged: 0, llmChecked: 0, llmMerged: 0,
    startedAt, endedAt: startedAt, durationMs: 0,
  };

  try {
    store.db.run(
      "INSERT INTO memory_sleep_runs(id, started_at, status, trigger, examined, archived_exact, " +
        "archived_expired, archived_orphan, archived_similarity, note) VALUES (?,?,?,?,0,0,0,0,0,NULL)",
      runId,
      startedAt,
      "running",
      trigger,
    );
  } catch (e) {
    logWarn(logger, "memory sleep: 写 run 记录失败", { error: errorText(e) });
  }

  try {
    const all = store.list({ status: "all", limit: MAX_SLEEP_SCAN });
    const actives = all.filter((m) => m.status === "active");
    const live = all.filter((m) => m.status !== "archived");
    stats.examined = live.length;

    stats.archivedExact = archiveExactDuplicates(store, actives, dryRun);
    stats.archivedExpired = archiveExpired(store, live, startedAt, opts, dryRun);
    stats.archivedOrphan = archiveOrphans(store, dryRun);

    const merge = await mergeSimilar(store, opts, logger, dryRun);
    stats.archivedSimilarity = merge.archived;
    stats.merged = merge.merged;
    stats.llmChecked = merge.llmChecked;
    stats.llmMerged = merge.llmMerged;
    if (merge.llmChecked === 0 && merge.bandSize > 0) notes.push("llm-skip");
    if (stats.merged) notes.push("merged=" + stats.merged);
  } catch (e) {
    stats.status = "error";
    notes.push(errorText(e));
    logWarn(logger, "memory sleep 运行失败", { error: errorText(e) });
  }

  stats.endedAt = Date.now();
  stats.durationMs = stats.endedAt - startedAt;
  if (notes.length) stats.note = notes.join("; ").slice(0, 500);

  try {
    store.db.run(
      "UPDATE memory_sleep_runs SET ended_at=?, status=?, examined=?, archived_exact=?, archived_expired=?, " +
        "archived_orphan=?, archived_similarity=?, note=? WHERE id=?",
      stats.endedAt,
      stats.status,
      stats.examined,
      stats.archivedExact,
      stats.archivedExpired,
      stats.archivedOrphan,
      stats.archivedSimilarity,
      stats.note ?? null,
      runId,
    );
  } catch (e) {
    logWarn(logger, "memory sleep: 更新 run 记录失败", { error: errorText(e) });
  }
  return stats;
}

// ── 1) 精确去重 ──────────────────────────────────────────────

function archiveExactDuplicates(store: MemoryStore, actives: MemoryRecord[], dryRun: boolean): number {
  const kept = new Map<string, MemoryRecord>();
  let archived = 0;
  for (const m of actives) {
    const key = normalizeContent(m.content);
    if (!key) continue;
    const prev = kept.get(key);
    if (!prev) {
      kept.set(key, m);
      continue;
    }
    const keep = prev.createdAt <= m.createdAt ? prev : m;
    const drop = keep === prev ? m : prev;
    kept.set(key, keep);
    if (!dryRun) store.archive(drop.id, "duplicate", keep.id);
    archived++;
  }
  return archived;
}

// ── 2) 过期清理 ──────────────────────────────────────────────

/** 临时记忆（metadata.temporary）或 pending 超过 TTL，以及显式 expiresAt 到期 */
function archiveExpired(
  store: MemoryStore,
  live: MemoryRecord[],
  now: number,
  opts: SleepOptions,
  dryRun: boolean,
): number {
  const ttl = (opts.ttlDays ?? MEMORY_SLEEP_DEFAULTS.temporaryTtlDays) * DAY_MS;
  let archived = 0;
  for (const m of live) {
    const expiresAt = m.metadata.expiresAt;
    const expired =
      (typeof expiresAt === "number" && expiresAt <= now) ||
      ((m.metadata.temporary === true || m.status === "pending") && m.createdAt + ttl <= now);
    if (!expired) continue;
    if (!dryRun) store.archive(m.id, "expired");
    archived++;
  }
  return archived;
}

// ── 3) 孤儿清理 ──────────────────────────────────────────────

/** 来源线程 / 消息已被删除，或内容为空 */
function archiveOrphans(store: MemoryStore, dryRun: boolean): number {
  const rows = store.db.all(
    "SELECT m.id FROM memories m WHERE m.status = 'active' AND (" +
      "TRIM(COALESCE(m.content, '')) = '' " +
      "OR (m.thread_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = m.thread_id)) " +
      "OR (m.message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages g WHERE g.id = m.message_id))" +
      ") LIMIT ?",
    MAX_SLEEP_SCAN,
  );
  let archived = 0;
  for (const r of rows) {
    if (!dryRun) store.archive(String(r.id), "orphan");
    archived++;
  }
  return archived;
}

// ── 4) 相似度合并 ────────────────────────────────────────────

interface MergeOutcome {
  merged: number;
  archived: number;
  llmChecked: number;
  llmMerged: number;
  bandSize: number;
}

async function mergeSimilar(
  store: MemoryStore,
  opts: SleepOptions,
  logger: MemoryLogger | undefined,
  dryRun: boolean,
): Promise<MergeOutcome> {
  const high = opts.mergeThreshold ?? MEMORY_SLEEP_DEFAULTS.similarityMergeThreshold;
  const low = opts.llmLow ?? MEMORY_SLEEP_DEFAULTS.llmMergeLow;
  const index = new Map<string, VectorRow>();
  for (const v of store.loadVectors()) index.set(v.id, v);
  const pairs = store.findSimilar(low, MAX_MERGE_PAIRS);
  const direct = pairs.filter((p) => p.score >= high);
  const band = pairs.filter((p) => p.score < high);

  let merged = 0;
  let archived = 0;
  for (const group of groupPairs(direct)) {
    const r = await mergeGroup(store, group, index, "similarity", dryRun);
    merged += r.merged;
    archived += r.archived;
  }

  let llmChecked = 0;
  let llmMerged = 0;
  const llm = opts.llm;
  if (llm && opts.llmEnabled !== false && band.length) {
    const batchSize = Math.max(1, opts.llmBatchSize ?? MEMORY_SLEEP_DEFAULTS.llmBatchSize);
    for (let i = 0; i < band.length; i += batchSize) {
      const batch = band.slice(i, i + batchSize);
      llmChecked += batch.length;
      const verdict = await judgePairs(llm, batch, index, logger);
      for (const group of groupPairs(verdict.map((k) => batch[k]).filter((p): p is SimilarPair => !!p))) {
        const r = await mergeGroup(store, group, index, "llm-merge", dryRun);
        llmMerged += r.merged;
        merged += r.merged;
        archived += r.archived;
      }
    }
  }
  return { merged, archived, llmChecked, llmMerged, bandSize: band.length };
}

/** 并查集分组：把两两相似的对子聚成可合并的簇 */
function groupPairs(pairs: SimilarPair[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p === undefined) {
      parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const p of pairs) {
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const key of [...parent.keys()]) {
    const root = find(key);
    const arr = groups.get(root);
    if (arr) arr.push(key);
    else groups.set(root, [key]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** 合并一簇：留最常用/最早的一条，内容取最长的版本，其余归档 */
async function mergeGroup(
  store: MemoryStore,
  ids: string[],
  index: Map<string, VectorRow>,
  reason: string,
  dryRun: boolean,
): Promise<{ merged: number; archived: number }> {
  const members = ids.map((id) => index.get(id)).filter((v): v is VectorRow => !!v);
  if (members.length < 2) return { merged: 0, archived: 0 };
  members.sort((a, b) => b.useCount - a.useCount || a.createdAt - b.createdAt);
  const survivor = members[0];
  if (!survivor) return { merged: 0, archived: 0 };
  let richest = survivor;
  for (const m of members) if (m.content.length > richest.content.length) richest = m;
  if (dryRun) return { merged: 1, archived: members.length - 1 };
  try {
    if (normalizeContent(richest.content) !== normalizeContent(survivor.content)) {
      await store.setContent(survivor.id, richest.content);
    }
  } catch {
    // 重新嵌入失败就保留原内容，不阻断合并
  }
  for (const m of members) {
    if (m.id === survivor.id) continue;
    store.archive(m.id, reason, survivor.id);
  }
  return { merged: 1, archived: members.length - 1 };
}

// ── LLM 判定（0.75 ~ 0.95 带） ───────────────────────────────

const LLM_MERGE_PROMPT = [
  "你在整理长期记忆。下面每行是一对候选记忆（编号 + A/B 内容 + 相似度）。",
  "判断每一对是否在描述同一件事（可以合并成一条）：",
  "- 只是主题相近但事实不同 → 不要合并",
  "- 同一事实的不同说法 / 补充 → 合并",
  "只输出 JSON，merges 里放需要合并的候选编号：{\"merges\":[0,3]}；一对都不合并就返回 {\"merges\":[]}。",
].join("\n");

async function judgePairs(
  llm: MemoryLlm,
  batch: SimilarPair[],
  index: Map<string, VectorRow>,
  logger: MemoryLogger | undefined,
): Promise<number[]> {
  const lines = batch.map((p, i) => {
    const a = (index.get(p.a)?.content ?? "").slice(0, MAX_MERGE_TEXT_CHARS);
    const b = (index.get(p.b)?.content ?? "").slice(0, MAX_MERGE_TEXT_CHARS);
    return i + ". A=" + JSON.stringify(a) + " B=" + JSON.stringify(b) + " (相似度 " + p.score.toFixed(3) + ")";
  });
  try {
    const out = await llm.complete(LLM_MERGE_PROMPT + "\n" + lines.join("\n"), {
      system: "只输出 JSON。",
      temperature: 0,
      maxTokens: 512,
    });
    const parsed = parseJsonLoose(out) as { merges?: unknown } | null;
    const arr = parsed && Array.isArray(parsed.merges) ? parsed.merges : [];
    const picked = new Set<number>();
    for (const item of arr) {
      const candidates = Array.isArray(item) ? item : [item];
      for (const c of candidates) {
        const n = typeof c === "number" ? c : Number.NaN;
        if (Number.isInteger(n) && n >= 0 && n < batch.length) picked.add(n);
      }
    }
    return [...picked];
  } catch (e) {
    logWarn(logger, "memory sleep: LLM 合并判定失败", { error: errorText(e) });
    return [];
  }
}

// ── 调度器 ───────────────────────────────────────────────────

/** 距下一个 HH:MM（本地时区）还有多少毫秒 */
export function msUntilNext(dailyTime: string, from: number = Date.now()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((dailyTime ?? "").trim());
  const hh = m ? Math.min(23, Number(m[1])) : 3;
  const mm = m ? Math.min(59, Number(m[2])) : 0;
  const d = new Date(from);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
  if (target.getTime() <= from) target.setDate(target.getDate() + 1);
  return target.getTime() - from;
}

/** 每天 dailyTime 跑一次睡眠流水线；返回的 stop() 用于关闭 */
export function startSleepScheduler(store: MemoryStore, opts: SleepOptions = {}): { stop(): void } {
  const dailyTime = opts.dailyTime ?? MEMORY_SLEEP_DEFAULTS.dailyTime;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void runSleepCycle(store, { ...opts, trigger: "schedule" }).catch((e) =>
        logWarn(opts.logger, "memory sleep 调度执行失败", { error: errorText(e) }),
      );
      schedule();
    }, msUntilNext(dailyTime));
    const t = timer as unknown as { unref?: () => void };
    t.unref?.();
  };

  schedule();
  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
