/**
 * 记忆写入：LLM 抽取 → 归一化去重 → 落库。
 * 抽取失败（无 LLM / JSON 坏 / 超时）一律返回空数组，绝不抛错影响对话。
 */
import { normalizeContent, type MemoryStore } from "./store.ts";
import type { MemoryKind, MemoryLlm, MemoryStatus } from "./types.ts";
import { errorText, isMemoryKind, logWarn, normalizeScope, type MemoryLogger } from "./types.ts";

/** 抽取提示词：中英混合，严格要求 JSON 输出；只抽稳定高价值信息 */
export const MEMORY_EXTRACT_PROMPT = [
  "你是一个记忆抽取器 / You are a memory extractor.",
  "",
  "从下面的对话里抽取【长期有效】的记忆（stable, high-value facts only），不要抽临时状态。",
  "",
  "值得抽取 / Extract:",
  "- preference 偏好：用户喜欢或讨厌什么、习惯怎么做",
  "- taste 品味：审美、风格、语气、格式偏好",
  "- decision 决定：已经拍板的技术选型、命名、方案取舍",
  "- fact 事实：项目结构、技术栈、长期约束、人物关系",
  "- feedback 反馈：用户对上一次产出的明确评价与纠正（下次要照做的那种）",
  "- reference 参考：可复用的链接、文档、命令、路径",
  "",
  "禁止抽取 / Never extract:",
  "- 临时状态：正在做什么、当前进度、一次性的中间结果",
  "- 寒暄、感谢、情绪化表达",
  "- 能从代码或文件里直接读到的细节",
  "- 任何你不确定是否长期有效的内容",
  "",
  "规则：",
  "1. content 用自包含的陈述句，不出现“他 / 它 / 这个 / 上面”这类指代，中文优先，10-200 字。",
  "2. 没有值得记的内容就返回 {\"memories\":[]}。",
  "3. 只输出 JSON，不要解释，不要 markdown 代码块。",
  "",
  "输出格式 / Output schema:",
  "{\"memories\":[{\"content\":\"...\",\"kind\":\"fact|preference|taste|decision|feedback|reference\",\"scope\":\"global|project\"}]}",
  "",
  "对话 / Conversation:",
].join("\n");

export const MEMORY_EXTRACT_SYSTEM = "你是严谨的信息抽取器，只输出 JSON，不要任何解释。";
export const MAX_CONVERSATION_CHARS = 24_000;
export const DEFAULT_EXTRACT_MAX = 10;
/** 对话短于该长度不值得调 LLM */
export const MIN_CONVERSATION_CHARS = 24;
export const MIN_MEMORY_CHARS = 6;
export const MAX_MEMORY_CHARS = 400;
export const DEFAULT_DEDUPE_THRESHOLD = 0.95;
export const DEDUPE_SCAN_LIMIT = 500;

export interface ExtractedMemory {
  content: string;
  kind: MemoryKind;
  scope: string;
}

export interface ExtractOptions {
  scope?: string;
  max?: number;
  minChars?: number;
  maxChars?: number;
  minConversationChars?: number;
  temperature?: number;
  logger?: MemoryLogger;
}

/** 从模型输出里捞出第一个 JSON 对象（容忍代码块与前后废话） */
export function parseJsonLoose(text: string): unknown {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  let body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) body = body.slice(start, end + 1);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** 解析 {"memories":[...]}；非法项直接丢弃 */
export function parseMemoryJson(text: string, opts: ExtractOptions = {}): ExtractedMemory[] {
  const parsed = parseJsonLoose(text);
  if (parsed == null) return [];
  const arr = Array.isArray(parsed) ? parsed : (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(arr)) return [];
  const fallbackScope = normalizeScope(opts.scope);
  const min = opts.minChars ?? MIN_MEMORY_CHARS;
  const max = opts.maxChars ?? MAX_MEMORY_CHARS;
  const out: ExtractedMemory[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    if (content.length < min || content.length > max) continue;
    const key = normalizeContent(content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const kind: MemoryKind = isMemoryKind(rec.kind) ? rec.kind : "fact";
    const scope = rec.scope === "project" ? fallbackScope : normalizeScope(rec.scope, fallbackScope);
    out.push({ content, kind, scope });
    if (out.length >= (opts.max ?? DEFAULT_EXTRACT_MAX)) break;
  }
  return out;
}

/** 调 LLM 抽取记忆；任何失败都返回 [] */
export async function extractMemories(
  llm: MemoryLlm | undefined,
  conversationText: string,
  opts: ExtractOptions = {},
): Promise<ExtractedMemory[]> {
  try {
    const text = (conversationText ?? "").trim();
    if (!llm || text.length < (opts.minConversationChars ?? MIN_CONVERSATION_CHARS)) return [];
    const prompt = MEMORY_EXTRACT_PROMPT + "\n" + text.slice(0, MAX_CONVERSATION_CHARS);
    const out = await llm.complete(prompt, {
      system: MEMORY_EXTRACT_SYSTEM,
      temperature: opts.temperature ?? 0,
      maxTokens: 1_200,
    });
    return parseMemoryJson(out, opts);
  } catch (e) {
    logWarn(opts.logger, "memory.extract 失败", { error: errorText(e) });
    return [];
  }
}

// ── MemoryWriter ─────────────────────────────────────────────

export interface WriteMemoryInput {
  content: string;
  kind?: MemoryKind;
  scope?: string;
  metadata?: Record<string, unknown>;
  threadId?: string | null;
  messageId?: string | null;
  status?: MemoryStatus;
  confidence?: number;
}

export interface WriteResult {
  id: string;
  action: "inserted" | "duplicate";
  duplicateOf?: string;
  score?: number;
}

export class MemoryWriter {
  #store: MemoryStore;
  #logger?: MemoryLogger;
  #threshold: number;
  #defaultScope: string;

  constructor(
    store: MemoryStore,
    opts: { dedupeThreshold?: number; defaultScope?: string; logger?: MemoryLogger } = {},
  ) {
    this.#store = store;
    this.#logger = opts.logger;
    this.#threshold = opts.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD;
    this.#defaultScope = normalizeScope(opts.defaultScope);
  }

  /** 去重后写入：命中重复则返回既有 id，不再落库 */
  async write(input: WriteMemoryInput): Promise<WriteResult> {
    const content = (input.content ?? "").trim();
    if (!content) throw new Error("MEMORY_EMPTY_CONTENT");
    const scope = normalizeScope(input.scope ?? this.#defaultScope);
    const scopes = scope === "global" ? ["global"] : [scope, "global"];
    const exact = this.#findExact(content, scopes);
    if (exact) return exact;
    const near = await this.#findNear(content, scopes);
    if (near) return near;
    const id = await this.#store.add({ ...input, content, scope });
    return { id, action: "inserted" };
  }

  /** 批量写入：单条失败不影响其余 */
  async writeMany(items: WriteMemoryInput[]): Promise<WriteResult[]> {
    const out: WriteResult[] = [];
    for (const item of items ?? []) {
      try {
        out.push(await this.write(item));
      } catch (e) {
        logWarn(this.#logger, "memory.write 失败", { error: errorText(e) });
      }
    }
    return out;
  }

  /** tools 的 remember 入口：只关心 id */
  async remember(content: string, kind?: MemoryKind, scope?: string): Promise<string> {
    const r = await this.write({ content, kind, scope });
    return r.id;
  }

  /** 归一化内容比较：完全相同，或新内容已被旧记忆覆盖 */
  #findExact(content: string, scopes: string[]): WriteResult | null {
    const key = normalizeContent(content);
    if (!key) return null;
    const rows = this.#store.list({ scope: scopes, status: "active", limit: DEDUPE_SCAN_LIMIT });
    for (const r of rows) {
      const other = normalizeContent(r.content);
      if (!other) continue;
      if (other === key || (other.length >= 12 && key.includes(other))) {
        return { id: r.id, action: "duplicate", duplicateOf: r.id, score: 1 };
      }
    }
    return null;
  }

  /** 向量近重复：余弦 > 阈值视为同一条 */
  async #findNear(content: string, scopes: string[]): Promise<WriteResult | null> {
    const hits = await this.#store.search(content, {
      limit: 1,
      threshold: this.#threshold,
      scope: scopes,
      status: "active",
      touch: false,
    });
    const top = hits[0];
    if (!top) return null;
    return { id: top.id, action: "duplicate", duplicateOf: top.id, score: top.score };
  }
}
