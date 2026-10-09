/**
 * 情绪（T6.6 / 答疑 p09）：双层模型
 *   base    —— 长期心境，衰减窗口 6 小时
 *   context —— 当下情境，衰减窗口 2 小时
 * 融合：0.3 × base + 0.7 × context
 * 回落：窗口内**线性**回落到中性基线 6（题干明确 Alma 的回落目标是 6，不是 0）。
 * 存储：<configDir>/emotions/base.md 与 <configDir>/emotions/context/<chatId>.md
 *        markdown + YAML frontmatter，人可读、可手改。
 */
import { join } from "node:path";
import { readMarkdown, safeId, writeMarkdownAtomic } from "./frontmatter.ts";

export const EMOTION_MIN = -10;
export const EMOTION_MAX = 10;
/** 中性基线 = 回落的终点。注意：是 6 不是 0。 */
export const EMOTION_NEUTRAL = 6;
export const EMOTION_BASE_DECAY_MS = 6 * 60 * 60 * 1000;
export const EMOTION_CONTEXT_DECAY_MS = 2 * 60 * 60 * 1000;
export const EMOTION_FUSION_BASE = 0.3;
export const EMOTION_FUSION_CONTEXT = 0.7;
export const EMOTION_DEFAULT_LABEL = "平静";

export interface Emotion {
  /** -10 ~ 10，中性基线 6 */
  valence: number;
  /** 中文情绪名，如「愉快」「烦躁」 */
  label: string;
  /** 起因；渲染时会写进「为什么」那一行 */
  reason?: string;
  /** 写入时刻（衰减从这个时间点算起） */
  updatedAt: number;
}

export interface EmotionState {
  base: Emotion;
  context: Emotion;
  fused: Emotion;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clampValence(v: number, min = EMOTION_MIN, max = EMOTION_MAX): number {
  if (!Number.isFinite(v)) return EMOTION_NEUTRAL;
  return round2(Math.max(min, Math.min(max, v)));
}

/**
 * 线性衰减：elapsedMs 内从当前值均匀回落到中性基线；到窗口终点恰好等于基线。
 * 已经越过基线时同样往回走（负值会回升），保证「总是回到基线」。
 */
export function decayValence(
  valence: number,
  elapsedMs: number,
  windowMs: number,
  neutral = EMOTION_NEUTRAL,
): number {
  if (!Number.isFinite(valence)) return neutral;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return clampValence(valence);
  }
  const ratio = Math.min(1, elapsedMs / windowMs);
  return clampValence(valence + (neutral - valence) * ratio);
}

/** 融合：0.3 × base + 0.7 × context；标签取偏离基线更远的那个 */
export function fuseEmotions(
  base: Emotion,
  context: Emotion,
  neutral = EMOTION_NEUTRAL,
  now = Date.now(),
): Emotion {
  const valence = clampValence(
    EMOTION_FUSION_BASE * base.valence + EMOTION_FUSION_CONTEXT * context.valence,
  );
  const dominant =
    Math.abs(context.valence - neutral) >= Math.abs(base.valence - neutral) ? context : base;
  return {
    valence,
    label: dominant.label || EMOTION_DEFAULT_LABEL,
    reason: dominant.reason || undefined,
    updatedAt: now,
  };
}

/** 语气提示：只给方向，不写台词（台词由模型自己组织） */
export function toneHint(valence: number, neutral = EMOTION_NEUTRAL): string {
  const d = valence - neutral;
  if (d >= 2.5) return "状态很好，语气可以放松、主动一些，但别过度热情。";
  if (d >= 0.8) return "心情偏正向，语气自然轻快一点。";
  if (d > -0.8) return "心情平稳，正常说话即可。";
  if (d > -2.5) return "有点低落，语气收一点，别硬撑热情。";
  return "状态不太好，话少一点、直一点，不要假装开心。";
}

function clip(text: string, max = 60): string {
  const t = (text ?? "").trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

export interface EmotionServiceOptions {
  configDir: string;
  /** 测试注入时钟；缺省 = 真实时间 */
  now?: () => Date;
  /** 中性基线覆盖；缺省 6 */
  neutral?: number;
}

export class EmotionService {
  #dir: string;
  #now: () => Date;
  #neutral: number;

  constructor(opts: EmotionServiceOptions) {
    this.#dir = join(opts.configDir, "emotions");
    this.#now = opts.now ?? (() => new Date());
    this.#neutral = Number.isFinite(opts.neutral) ? (opts.neutral as number) : EMOTION_NEUTRAL;
  }

  get dir(): string {
    return this.#dir;
  }

  get neutral(): number {
    return this.#neutral;
  }

  get basePath(): string {
    return join(this.#dir, "base.md");
  }

  contextPath(chatId?: string): string {
    return join(this.#dir, "context", safeId(chatId) + ".md");
  }

  /** 读双层情绪（已按经过时间衰减）+ 融合结果；纯读，不落盘 */
  getState(chatId?: string): EmotionState {
    const now = this.#nowMs();
    const base = this.#read(this.basePath, EMOTION_BASE_DECAY_MS, now);
    const context = this.#read(this.contextPath(chatId), EMOTION_CONTEXT_DECAY_MS, now);
    return { base, context, fused: fuseEmotions(base, context, this.#neutral, now) };
  }

  /** 设置长期心境（未给的字段保留当前值） */
  setBase(v: Partial<Emotion>): void {
    const now = this.#nowMs();
    const cur = this.#read(this.basePath, EMOTION_BASE_DECAY_MS, now);
    this.#write(this.basePath, this.#merge(cur, v, now));
  }

  /** 设置当下情境（按 chatId 分文件；缺省 default） */
  setContext(v: Partial<Emotion>, chatId?: string): void {
    const now = this.#nowMs();
    const path = this.contextPath(chatId);
    const cur = this.#read(path, EMOTION_CONTEXT_DECAY_MS, now);
    this.#write(path, this.#merge(cur, v, now));
  }

  /** 渲染成注入 mt 尾部的短块（3–6 行，每轮都变，绝不进系统提示词） */
  renderBlock(chatId?: string): string {
    const { base, context, fused } = this.getState(chatId);
    const why = clip(fused.reason ?? "", 60) || "没有特别的触发，保持平稳。";
    return [
      `心情：${fused.label}（valence ${fused.valence.toFixed(1)}，中性基线 ${this.#neutral}）。`,
      `为什么：${why}`,
      `底层心境：${base.label}（${base.valence.toFixed(1)}）；此刻情境：${context.label}（${context.valence.toFixed(1)}）。`,
      `语气提示：${toneHint(fused.valence, this.#neutral)}`,
    ].join("\n");
  }

  #nowMs(): number {
    const t = this.#now().getTime();
    return Number.isFinite(t) ? t : Date.now();
  }

  #read(path: string, windowMs: number, now: number): Emotion {
    const doc = readMarkdown(path);
    if (!doc) {
      return { valence: this.#neutral, label: EMOTION_DEFAULT_LABEL, updatedAt: now };
    }
    const d = doc.data;
    const raw = typeof d.valence === "number" ? d.valence : Number(d.valence);
    const valence = Number.isFinite(raw) ? clampValence(raw) : this.#neutral;
    const label =
      typeof d.label === "string" && d.label.trim() ? d.label.trim() : EMOTION_DEFAULT_LABEL;
    const keyReason = typeof d.reason === "string" ? d.reason.trim() : "";
    // 正文第一行当 reason 用 —— 但要跳过注释/引用行，
    // 否则默认模板里那句「> 手改这个文件就能调我的心情…」会被当成"为什么"。
    const bodyReason = doc.body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith(">") && !l.startsWith("#") && !l.startsWith("<!--")) ?? "";
    const updated = Number(d.updatedAt);
    const updatedAt = Number.isFinite(updated) && updated > 0 ? updated : now;
    return {
      valence: decayValence(valence, now - updatedAt, windowMs, this.#neutral),
      label,
      reason: keyReason || bodyReason || undefined,
      updatedAt,
    };
  }

  #write(path: string, e: Emotion): void {
    writeMarkdownAtomic(
      path,
      {
        valence: e.valence,
        label: e.label,
        reason: e.reason ?? "",
        updatedAt: e.updatedAt,
        updated: new Date(e.updatedAt).toISOString(),
      },
      `> 手改这个文件就能调我的心情。valence 范围 ${EMOTION_MIN} ~ ${EMOTION_MAX}，中性基线 ${this.#neutral}，` +
        `衰减窗口 ${Math.round(EMOTION_BASE_DECAY_MS / 3_600_000)} 小时（base）/ ${Math.round(EMOTION_CONTEXT_DECAY_MS / 3_600_000)} 小时（context）。`,
    );
  }

  #merge(cur: Emotion, v: Partial<Emotion>, now: number): Emotion {
    const label = typeof v.label === "string" && v.label.trim() ? v.label.trim() : cur.label;
    const reason = typeof v.reason === "string" ? v.reason.trim() : (cur.reason ?? "");
    return {
      valence: v.valence === undefined ? cur.valence : clampValence(v.valence),
      label,
      reason: reason || undefined,
      updatedAt: now,
    };
  }
}
