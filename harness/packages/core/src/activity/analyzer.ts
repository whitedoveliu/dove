/**
 * 会话分析（T7.8 / T7.9）
 * 会话关闭 → 把该会话的 OCR 文本压成 digest → 让 LLM 提结构化 JSON。
 * 结果入库前再脱敏一次（模型可能复述 OCR 里的密钥）；任何失败都返回空结果，绝不抛。
 */
import { redact } from "./redact.ts";
import type { ActivityStore } from "./store.ts";
import type { ActivityLlm, ActivitySessionRow, AnalysisResult, MemoryCandidate } from "./types.ts";
import { emptyAnalysis } from "./types.ts";

export const ANALYSIS_SYSTEM = "你是严谨的活动日志分析器，只输出 JSON，不要任何解释。";
export const MAX_DIGEST_CHARS = 12_000;
export const MAX_FRAMES = 60;
export const MAX_FRAME_CHARS = 700;
export const MIN_DIGEST_CHARS = 40;
export const ANALYSIS_MAX_TOKENS = 1_400;
export const DEFAULT_ANALYSIS_MODEL = "deepseek-flash";

/**
 * 分析提示词（照 Alma 的判据重写一版）
 * 三条硬约束：只判断值不值得记、必须抽 memoryCandidates、禁止编造 PR/人名/版本。
 */
export const ANALYSIS_PROMPT = [
  "你在读一个人刚才的屏幕活动转写（OCR 文本 + 应用/窗口信息）。它嘈杂、重复、有 OCR 错字。",
  "请判断这段活动值不值得记进工作日志，并抽成结构化 JSON。",
  "",
  "worth = true（满足任意一条）：",
  "- 产出了具体成果：写了代码/文档/设计稿，并且能说清是什么",
  "- 做出了决定或取舍：选型、命名、方案调整、方向变化",
  "- 学到了新东西：读文档、查到结论、搞清楚了一个问题",
  "- 与人的实质沟通：讨论、评审、反馈，且有具体内容",
  "worth = false：",
  "- 只是浏览信息流 / 看视频 / 无产出消遣",
  "- 全是重复画面或 OCR 噪声，抽不出任何具体信息",
  "- 桌面、锁屏、空闲画面",
  "",
  "硬性规则（违反即错误）：",
  "1. 禁止编造。不要写输入里没有出现过的 PR 编号、issue 编号、人名、公司名、版本号、文件名、URL、日期。",
  "   输入里没有的，宁可不写；拿不准的也不要写。",
  "2. title ≤ 40 字；description 2-4 句，只写「做了什么、做到哪一步」，不写评价、不写感想。",
  "3. project：只填输入里出现过、或能从窗口标题/路径直接看出来的项目名；看不出来就填空字符串。",
  "4. topics：3-8 个短标签；highlights：0-5 条，每条一句话，必须是输入里真实发生过的事。",
  "5. entities：只抽输入里真实出现的实体（file / repo / url / tech / person / version），不确定就不要写。",
  "6. memoryCandidates：只写跨会话仍然成立的信息（偏好、决定、长期约束、可复用的结论），不写临时进度；",
  "   没有就给空数组。每条 10-200 字，自包含陈述句，不出现「他/它/这个/上面」这类指代。",
  "7. 只输出 JSON 一行，不要 markdown 代码块，不要解释。",
  "",
  "输出格式：",
  '{"worth":true,"title":"...","description":"...","project":"...","topics":["..."],"highlights":["..."],' +
  '"entities":[{"type":"file","name":"..."}],"memoryCandidates":[{"content":"...","kind":"fact"}]}',
  "",
  "活动转写：",
].join("\n");

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 宽松取 JSON（容忍代码块与前后废话） */
export function parseJsonLoose(text: string): unknown {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  let body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) body = body.slice(start, end + 1);
  try { return JSON.parse(body) as unknown; } catch { return null; }
}

function strList(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = typeof item === "string" ? item.trim() : "";
    if (!s) continue;
    const cut = s.slice(0, maxChars);
    if (!out.includes(cut)) out.push(cut);
    if (out.length >= max) break;
  }
  return out;
}

/** 解析模型输出；坏 JSON 返回 null（调用方降级） */
export function parseAnalysis(text: string, model?: string): AnalysisResult | null {
  const parsed = parseJsonLoose(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const entities: { type: string; name: string }[] = [];
  if (Array.isArray(raw.entities)) {
    for (const item of raw.entities) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim().slice(0, 120) : "";
      if (!name) continue;
      entities.push({ type: typeof rec.type === "string" ? rec.type.trim().slice(0, 24) : "unknown", name });
      if (entities.length >= 20) break;
    }
  }
  const memoryCandidates: MemoryCandidate[] = [];
  if (Array.isArray(raw.memoryCandidates)) {
    for (const item of raw.memoryCandidates) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const content = typeof rec.content === "string" ? rec.content.trim().slice(0, 400) : "";
      if (content.length < 6) continue;
      memoryCandidates.push({ content, kind: typeof rec.kind === "string" ? rec.kind.trim().slice(0, 24) : "fact" });
      if (memoryCandidates.length >= 10) break;
    }
  }
  const result: AnalysisResult = {
    worth: raw.worth === true,
    title: typeof raw.title === "string" ? raw.title.trim().slice(0, 80) : "",
    description: typeof raw.description === "string" ? raw.description.trim().slice(0, 1_200) : "",
    project: typeof raw.project === "string" ? raw.project.trim().slice(0, 80) : "",
    topics: strList(raw.topics, 8, 32),
    highlights: strList(raw.highlights, 5, 200),
    entities,
    memoryCandidates,
    ...(model ? { model } : {}),
  };
  return result;
}

export interface DigestResult { digest: string; frames: number; apps: string[] }

/** 把会话的 OCR 帧 + 焦点应用压成一段有界的文本 */
export function buildDigest(store: ActivityStore, session: ActivitySessionRow, maxChars = MAX_DIGEST_CHARS): DigestResult {
  const frames = store.listOcrFrames(session.id, MAX_FRAMES * 4);
  const snaps = store.snapshotsForSession(session.id, 500);
  const byId = new Map(snaps.map((s) => [s.id, s]));
  const apps = [...new Set(snaps.map((s) => s.appName).filter((v): v is string => !!v))].slice(0, 20);
  const parts: string[] = [
    `会话 ${session.id}：${hhmm(session.startedAt)}–${session.endedAt ? hhmm(session.endedAt) : "进行中"}`,
    `快照 ${snaps.length} 张，OCR 帧 ${frames.length} 条${apps.length ? `，应用：${apps.join(" / ")}` : ""}`,
    "",
  ];
  let used = 0;
  for (const f of frames) {
    const snap = byId.get(f.snapshotId);
    const head = `[${hhmm(f.createdAt)}]${snap?.appName ? ` (${snap.appName}${snap.windowTitle ? " · " + snap.windowTitle : ""})` : ""}`;
    const body = f.text.replace(/\s*\n\s*/g, " / ").slice(0, MAX_FRAME_CHARS);
    const line = `${head} ${body}`;
    if (used + line.length > maxChars) break;
    parts.push(line);
    used += line.length;
  }
  return { digest: parts.join("\n"), frames: frames.length, apps };
}

export interface AnalyzerOptions {
  llm?: ActivityLlm;
  model?: string;
  logger?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
  /** 已知项目名，帮助模型对齐 project 字段（不额外提供任何未出现的信息） */
  knownProjects?: () => string[];
}

export class SessionAnalyzer {
  #store: ActivityStore;
  #llm?: ActivityLlm;
  #model: string;
  #logger?: AnalyzerOptions["logger"];
  #knownProjects?: () => string[];

  constructor(store: ActivityStore, opts: AnalyzerOptions = {}) {
    this.#store = store;
    this.#llm = opts.llm;
    this.#model = opts.model ?? DEFAULT_ANALYSIS_MODEL;
    this.#logger = opts.logger;
    this.#knownProjects = opts.knownProjects;
  }

  async analyze(session: ActivitySessionRow | string): Promise<AnalysisResult> {
    const row = typeof session === "string" ? this.#store.getSession(session) : session;
    if (!row) return emptyAnalysis(`会话不存在：${String(session)}`);
    if (!this.#llm) return emptyAnalysis("未配置 LLM，跳过会话分析");
    const { digest, frames } = buildDigest(this.#store, row);
    if (frames === 0 || digest.length < MIN_DIGEST_CHARS) return emptyAnalysis("该会话没有可分析的文本（OCR 未命中）");
    try {
      const projects = this.#knownProjects?.() ?? [];
      const hint = projects.length ? `\n（已知项目名，仅当输入里出现时才可用：${projects.slice(0, 20).join("、")}）` : "";
      const out = await this.#llm.complete(ANALYSIS_PROMPT + hint + "\n" + digest, {
        system: ANALYSIS_SYSTEM, temperature: 0, maxTokens: ANALYSIS_MAX_TOKENS,
      });
      const parsed = parseAnalysis(out, this.#model);
      if (!parsed) return emptyAnalysis("模型输出不是合法 JSON");
      // 入库前再脱敏：模型可能复述 OCR 里的密钥
      return {
        ...parsed,
        title: redact(parsed.title).text,
        description: redact(parsed.description).text,
        highlights: parsed.highlights.map((h) => redact(h).text),
        memoryCandidates: parsed.memoryCandidates.map((m) => ({ ...m, content: redact(m.content).text })),
      };
    } catch (e) {
      this.#logger?.("warn", "activity.analyze 失败", { error: String(e).slice(0, 200) });
      return emptyAnalysis(`分析调用失败：${String(e).slice(0, 200)}`);
    }
  }
}

/** 便捷入口（契约要求）：analyzeSession(store, session, llm) */
export async function analyzeSession(
  store: ActivityStore, session: ActivitySessionRow | string, llm?: ActivityLlm,
  opts: Omit<AnalyzerOptions, "llm"> = {},
): Promise<AnalysisResult> {
  return new SessionAnalyzer(store, { ...opts, llm }).analyze(session);
}
