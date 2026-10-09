/**
 * 三条运行时注入通道的编排层（仿 Alma 的运行时注入）
 *
 * 纪律（三条，缺一不可）：
 * - **运行时注入**：结果只走 mt（renderTailContext 的 activity 字段），绝不进系统提示词；
 * - **不落库**：这里只读不写 —— 不写 messages、不写事件日志、不写 activity 表；
 * - **失败静默**：任何一环抛错 / 超时，只丢自己那一块，整体永远返回，绝不拖慢发送。
 *
 * 通道①问候（纯本地，不做向量）与通道②语义（检索，350ms 超时）互斥：
 * 问候消息走①，其余 ≥4 字符的消息走②，<4 字符两条都不走。
 * 通道③记忆不在这里 —— 它由 memory 模块的 memoriesBlock 流程负责（阈值 + 查询改写）。
 *
 * 语义通道有两条腿：
 * - **向量腿**（有真 embedder + listFrames 时）：query 向量 vs 最近 OCR 帧向量算余弦，阈值 0.40；
 * - **词袋腿**（没装 onnxruntime-node / 没下模型时）：本地 2-gram 倒排打分，阈值 0.25。
 * 两条腿的分数不在一个量级，所以阈值是两个常量（见 constants.ts）。
 */
import { ACTIVITY_INJECT } from "../constants.ts";
import { cosine } from "../memory/embedding.ts";
import { tokenize, type ScreenHit } from "../memory/screen-index.ts";
import { buildGreetingBlock, charLength, isGreeting } from "./greeting.ts";

export type { ScreenHit };

/** 语义向量后端：结构与 core 的 EmbeddingProvider 完全一致（可直传 resolveEmbedder().provider） */
export interface ScreenEmbedder {
  id: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** 向量通道的候选帧（activity 层提供；只读，不落库） */
export interface ScreenFrame {
  frameId: string;
  snapshotId?: string;
  text: string;
  at: number;
  appName?: string | null;
  windowTitle?: string | null;
}

export interface ActivityInjectOptions {
  userText: string;
  /** 词袋腿：屏幕内容检索（memory/screen-index.ts 的 ScreenIndex.search） */
  searchScreen?: (q: string, limit: number) => ScreenHit[];
  /** 向量腿后端；与 listFrames 同时具备才走向量 */
  embedder?: ScreenEmbedder;
  /** 向量腿候选池：最近 OCR 帧（activity/store.listRecentOcrFrames） */
  listFrames?: (since: number, limit: number) => ScreenFrame[];
  /** 最近 48h 活动摘要（activity/recent.ts 的 buildRecentSummary） */
  recentSummary?: () => Promise<string | null>;
  /** 语义通道阈值（不给就按腿取默认：向量 0.40 / 词袋 0.25） */
  threshold?: number;
  /** 超时毫秒（默认 350） */
  timeoutMs?: number;
}

export interface ActivityInjectResult {
  /** 问候块；未命中 = 空串 */
  greeting: string;
  /** 语义块；未命中 / 超时 / 失败 = 空串 */
  semantic: string;
  /** 诊断用，别注入 */
  meta: {
    greetingHit: boolean;
    semanticHits: number;
    elapsedMs: number;
    skipped?: string;
    /** 本轮语义通道实际走的腿（词袋降级也标出来，方便排查） */
    path?: "vector" | "lexical";
  };
}

/** 语义块标题：固定，不随触发原因变化（验收项） */
export const SEMANTIC_TITLE = "## Relevant past activity (matched to your message)";

const TIMEOUT_MSG = "activity-inject-timeout";

/** 查询词权重：中文单字（1-gram）命中太容易，降权；2-gram 与西文词算满权重 */
function termWeight(term: string): number {
  return charLength(term) >= 2 ? 1 : ACTIVITY_INJECT.singleCharWeight;
}

/**
 * 词袋腿的归一化相关性（0~1）：命中查询词权重 / min(查询词总权重, semanticQueryCap)。
 * 分母封顶是为了不让「长消息」被自身长度惩罚；封顶后长消息命中 3 个词也能过阈值。
 */
export function screenRelevance(query: string, hit: ScreenHit): number {
  const terms = [...new Set(tokenize(query ?? ""))];
  if (terms.length === 0) return 0;
  const matched = new Set(hit?.matched ?? []);
  let hitWeight = 0;
  let totalWeight = 0;
  for (const t of terms) {
    const w = termWeight(t);
    totalWeight += w;
    if (matched.has(t)) hitWeight += w;
  }
  const denom = Math.min(totalWeight, ACTIVITY_INJECT.semanticQueryCap);
  return denom <= 0 ? 0 : Math.min(1, hitWeight / denom);
}

/** 本地时间戳：MM-DD HH:mm（时间锚另有权威来源，这里只做定位） */
function stamp(at: number): string {
  const d = new Date(Number.isFinite(at) ? at : Date.now());
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 单行化 + 截断：注入块每轮都发，必须小 */
function snippet(text: string): string {
  const one = (text ?? "").replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
  const max = ACTIVITY_INJECT.semanticSnippetChars;
  return one.length <= max ? one : one.slice(0, max) + "…";
}

/** 渲染语义块；无有效命中返回空串 */
export function renderSemanticBlock(hits: ScreenHit[]): string {
  if (!hits.length) return "";
  const rows = hits.map((h, i) => {
    const where = [h.appName, h.windowTitle].filter(Boolean).join(" — ");
    const head = [stamp(h.at), where].filter(Boolean).join(" · ");
    return `${i + 1}. [${head}] ${snippet(h.text)}`;
  });
  return [SEMANTIC_TITLE, "你在最近 24 小时里看过的屏幕内容（OCR），按与你这条消息的相关度排序：", "", ...rows].join("\n");
}

// ── 向量腿：帧向量只在内存里缓存（不落库），避免每轮把同一帧重算一遍 ──
const frameVecCache = new Map<string, number[]>();
function cacheKey(embedderId: string, frameId: string): string { return embedderId + "|" + frameId; }
function cachePut(key: string, vec: number[]): void {
  frameVecCache.set(key, vec);
  while (frameVecCache.size > ACTIVITY_INJECT.semanticVectorCache) {
    const oldest = frameVecCache.keys().next().value;
    if (oldest === undefined) break;
    frameVecCache.delete(oldest);
  }
}

/**
 * 向量腿：query 向量 vs 最近 N 帧向量算余弦。
 * 返回 null = 这条路不可用（没后端 / 没候选 API / 调用炸了）→ 由调用方降级词袋；
 * 返回 [] = 路通了但没命中（**不降级**，否则两个阈值语义会打架）。
 */
async function vectorHits(o: ActivityInjectOptions, query: string, threshold: number): Promise<ScreenHit[] | null> {
  const embedder = o.embedder;
  const listFrames = o.listFrames;
  if (!embedder || !listFrames) return null;
  try {
    const since = Date.now() - ACTIVITY_INJECT.semanticWindowMs;
    const frames = (listFrames(since, ACTIVITY_INJECT.semanticVectorFrames) ?? [])
      .filter((f) => f && typeof f.text === "string" && f.text.trim().length > 0 && Number.isFinite(f.at) && f.at >= since);
    if (frames.length === 0) return [];
    const [queryVec] = await embedder.embed([query]);
    if (!queryVec || queryVec.length === 0) return null;

    const missing = frames.filter((f) => !frameVecCache.has(cacheKey(embedder.id, f.frameId)));
    if (missing.length > 0) {
      const vecs = await embedder.embed(missing.map((f) => f.text));
      missing.forEach((f, i) => {
        const v = vecs[i];
        if (v && v.length === queryVec.length) cachePut(cacheKey(embedder.id, f.frameId), v);
      });
    }

    return frames
      .map((f) => ({ f, score: cosine(queryVec, frameVecCache.get(cacheKey(embedder.id, f.frameId)) ?? []) }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, ACTIVITY_INJECT.semanticTopK)
      .map((x) => ({
        frameId: x.f.frameId, snapshotId: x.f.snapshotId ?? "", text: x.f.text,
        matched: [], score: x.score, at: x.f.at,
        appName: x.f.appName ?? null, windowTitle: x.f.windowTitle ?? null,
      }));
  } catch {
    return null;   // 向量腿任何异常 → 让词袋腿兜底
  }
}

/**
 * 词袋腿：本地 2-gram 倒排打分。多取一倍再按自己的阈值重排（ScreenIndex 的 score 只用于排序）。
 * 这里 await 一下：接口是同步的，但调用方可能包一层异步（例如带缓存/锁的检索）——
 * await 非 Promise 是零成本的，却能让超时对异步实现同样有效。
 */
async function lexicalHits(search: (q: string, limit: number) => ScreenHit[], query: string, threshold: number): Promise<ScreenHit[]> {
  const raw = (await search(query, ACTIVITY_INJECT.semanticTopK * 2)) ?? [];
  const since = Date.now() - ACTIVITY_INJECT.semanticWindowMs;
  return raw
    .filter((h) => h && Number.isFinite(h.at) && h.at >= since)
    .map((h) => ({ h, rel: screenRelevance(query, h) }))
    .filter((x) => x.rel >= threshold)
    .sort((a, b) => b.rel - a.rel)
    .slice(0, ACTIVITY_INJECT.semanticTopK)
    .map((x) => x.h);
}

/** Promise.race 超时。timer 不 unref：unref 后事件循环可能先空掉，顶层 await 会以 exit 13 收场 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(TIMEOUT_MSG)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 语义通道：超时 / 抛错 / 阈值不过 → 空串，且绝不向外抛 */
async function collectSemantic(
  o: ActivityInjectOptions,
  query: string,
  timeoutMs: number,
): Promise<{ block: string; count: number; path: "vector" | "lexical"; skipped?: string }> {
  const run = async (): Promise<{ hits: ScreenHit[]; path: "vector" | "lexical" }> => {
    const vector = await vectorHits(o, query, o.threshold ?? ACTIVITY_INJECT.semanticThreshold);
    if (vector) return { hits: vector, path: "vector" };
    if (!o.searchScreen) return { hits: [], path: "lexical" };
    const hits = await lexicalHits(o.searchScreen, query, o.threshold ?? ACTIVITY_INJECT.semanticThresholdLexical);
    return { hits, path: "lexical" };
  };
  try {
    const r = await withTimeout(run(), timeoutMs);
    return { block: r.hits.length ? renderSemanticBlock(r.hits) : "", count: r.hits.length, path: r.path };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { block: "", count: 0, path: "lexical", skipped: msg === TIMEOUT_MSG ? "timeout" : "search-error" };
  }
}

/**
 * 组装本轮注入。**永远 resolve**（不抛），任何一环失败只影响自己那一段。
 * meta.skipped 取值：greeting / too-short / no-search / timeout / search-error / greeting-summary-error
 */
export async function buildActivityInjection(o: ActivityInjectOptions): Promise<ActivityInjectResult> {
  const started = Date.now();
  const text = (o.userText ?? "").trim();
  const meta: ActivityInjectResult["meta"] = { greetingHit: false, semanticHits: 0, elapsedMs: 0 };
  let greeting = "";
  let semantic = "";

  const greetingHit = isGreeting(text);
  meta.greetingHit = greetingHit;

  // ── ① 问候通道：纯本地（最多加一次本地 DB 读摘要），不设超时、不做向量
  if (greetingHit) {
    try {
      const summary = o.recentSummary ? await o.recentSummary() : null;
      greeting = buildGreetingBlock(summary);
    } catch {
      meta.skipped = "greeting-summary-error";
      greeting = buildGreetingBlock(null);
    }
  }

  // ── ② 语义通道：与问候互斥；太短不搜
  if (greetingHit) {
    if (!meta.skipped) meta.skipped = "greeting";
  } else if (charLength(text) < ACTIVITY_INJECT.semanticMinChars) {
    if (!meta.skipped) meta.skipped = "too-short";
  } else if (!o.embedder && !o.searchScreen) {
    if (!meta.skipped) meta.skipped = "no-search";
  } else {
    const r = await collectSemantic(o, text, o.timeoutMs ?? ACTIVITY_INJECT.semanticTimeoutMs);
    semantic = r.block;
    meta.semanticHits = r.count;
    meta.path = r.path;
    if (r.skipped) meta.skipped = r.skipped;
  }

  meta.elapsedMs = Date.now() - started;
  return { greeting, semantic, meta };
}
