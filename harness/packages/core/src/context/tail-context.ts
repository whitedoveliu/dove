/**
 * mt —— 尾部上下文（T2.3）
 * 纪律：每轮都会变的内容（时间锚 / 情绪 / 任务 / 记忆文件 / 疲劳）一律不进系统提示词，
 *       只在这里渲染成 mt，再以 `[Context: …]` 前缀 prepend 到最后一条 user 消息。
 *       理由：系统提示词属于前缀缓存，任何逐轮变化都会让它整体失效。
 */
import type { ChatMessage, ContentBlock } from "../providers/types.ts";

/** 已按目标时区解析的本地时间锚 */
export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
  /** Monday / Tuesday / … */
  weekday: string;
  timezone: string;
  /** UTC ISO（日志与调试用） */
  iso: string;
}

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 解析时间锚；at 缺省 = 现在，非法值回落到现在 */
export function resolveLocalTime(at?: Date | number | string, timezone?: string): LocalTime {
  const raw = at === undefined ? new Date() : at instanceof Date ? at : new Date(at);
  const when = Number.isFinite(raw.getTime()) ? raw : new Date();
  const tz = timezone && timezone.trim() ? timezone.trim() : defaultTimezone();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long",
  }).formatToParts(when);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
    weekday: get("weekday"),
    timezone: tz,
    iso: when.toISOString(),
  };
}

export type TailTaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface TailTask { id?: string; title: string; status?: TailTaskStatus; note?: string; }
export interface TailMemoryFile { path: string; label?: string; }
export interface TailEmotion { label: string; intensity?: number; reason?: string; }
export interface TailFatigue { level: number; state?: string; hint?: string; }

/** mt 输入；每个字段都允许直接给成品文本（结构化数据不足时用） */
export interface TailContext {
  /** 时间源；缺省 = 现在 */
  date?: Date | number | string;
  timezone?: string;
  /** 覆盖 weekday / time（测试或特殊场景） */
  weekday?: string;
  time?: string;
  tasks?: TailTask[] | string;
  memoryFiles?: TailMemoryFile[] | string;
  emotion?: TailEmotion | string;
  fatigue?: TailFatigue | number | string;
  /**
   * 运行时注入的活动块（问候通道 / 语义通道，见 activity-inject.ts）。
   * 空串 = 本轮没有可注入的内容；渲染位置固定在时间锚之后、其它块之前。
   */
  activity?: string;
  /** 其他附加块（项目状态、崩溃修复交代等） */
  extra?: string;
}

/** mt 每轮都发，必须小：以下都是硬上限 */
const MAX_TASKS = 8;
const MAX_MEMORY_FILES = 12;
const MAX_BLOCK_CHARS = 1200;

function clip(text: string, max = MAX_BLOCK_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（本块已截断）`;
}

function renderTimeAnchor(t: LocalTime): string {
  return [
    `<reminder>Authoritative Local DateTime: ${t.date} ${t.time} (${t.weekday}), timezone ${t.timezone}.`,
    'This is "now" — resolve every relative date ("today", "昨天", "上周", "in 3 days") against this anchor,',
    "not against your training data. Timestamps inside memories are anchored to their original message, never to this anchor.</reminder>",
  ].join(" ");
}

function renderTasks(value: TailContext["tasks"]): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim() ? clip(`## Tasks\n${value.trim()}`) : "";
  if (value.length === 0) return "";
  const mark: Record<TailTaskStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]", blocked: "[!]" };
  const rows = value.slice(0, MAX_TASKS).map((t) => {
    const id = t.id ? ` #${t.id}` : "";
    const note = t.note ? ` — ${t.note}` : "";
    return `- ${mark[t.status ?? "pending"]}${id} ${t.title}${note}`;
  });
  const more = value.length > MAX_TASKS ? `\n… 还有 ${value.length - MAX_TASKS} 条未显示` : "";
  return clip(`## Tasks\n${rows.join("\n")}${more}`);
}

function renderMemoryFiles(value: TailContext["memoryFiles"]): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim() ? clip(`## Memory Files\n${value.trim()}`) : "";
  if (value.length === 0) return "";
  const rows = value.slice(0, MAX_MEMORY_FILES).map((f) => `- ${f.path}${f.label ? ` —— ${f.label}` : ""}`);
  const more = value.length > MAX_MEMORY_FILES ? `\n… 还有 ${value.length - MAX_MEMORY_FILES} 个文件未显示` : "";
  return clip(`## Memory Files\n${rows.join("\n")}${more}`);
}

function renderEmotion(value: TailContext["emotion"]): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim() ? clip(`## Emotion\n${value.trim()}`) : "";
  const intensity = typeof value.intensity === "number" ? `（强度 ${Math.round(value.intensity)}/100）` : "";
  const reason = value.reason ? ` 起因：${value.reason}` : "";
  return clip(`## Emotion\n${value.label}${intensity}。${reason}`);
}

function renderFatigue(value: TailContext["fatigue"]): string {
  if (value == null) return ""; // 疲劳 0 是合法值，不能用 falsy 判断
  if (typeof value === "string") return value.trim() ? clip(`## Fatigue\n${value.trim()}`) : "";
  const f: TailFatigue = typeof value === "number" ? { level: value } : value;
  const level = Number.isFinite(f.level) ? Math.max(0, Math.min(100, Math.round(f.level))) : 0;
  const state = f.state ?? (level >= 80 ? "需要休息" : level >= 50 ? "有点累" : "状态正常");
  const hint = f.hint ? ` ${f.hint}` : "";
  return clip(`## Fatigue\n疲劳 ${level}/100（${state}）。${hint}`);
}

/** 渲染 mt：权威时间锚 + 其他易变块 */
export function renderTailContext(t: TailContext): string {
  const time = resolveLocalTime(t.date, t.timezone);
  if (t.weekday) time.weekday = t.weekday;
  if (t.time) time.time = t.time;

  const blocks: string[] = [renderTimeAnchor(time)];
  // 活动块必须紧跟时间锚：它是对「现在」的补充（刚才在干嘛），别混进状态块里
  if (t.activity && t.activity.trim()) blocks.push(clip(t.activity.trim()));
  for (const block of [
    renderTasks(t.tasks),
    renderMemoryFiles(t.memoryFiles),
    renderEmotion(t.emotion),
    renderFatigue(t.fatigue),
    t.extra && t.extra.trim() ? clip(t.extra.trim()) : "",
  ]) {
    if (block) blocks.push(block);
  }
  return blocks.join("\n\n");
}

/** 注入前缀 = [Context: mt] + 记忆切片块 */
export function buildInjectionPrefix(mt: string, memories?: string): string {
  const parts: string[] = [];
  if (mt && mt.trim()) parts.push(`[Context: ${mt.trim()}]`);
  if (memories && memories.trim()) parts.push(memories.trim());
  return parts.join("\n\n");
}

function prependText(content: ChatMessage["content"], prefix: string): ChatMessage["content"] {
  if (!content) return prefix;
  if (typeof content === "string") return `${prefix}\n\n${content}`;
  return [{ type: "text", text: prefix }, ...content] as ContentBlock[];
}

/** 把 mt（和记忆块）prepend 到最后一条 user 消息前面；找不到 user 消息则原样返回 */
export function injectIntoLastUser(messages: ChatMessage[], mt: string, memories?: string): ChatMessage[] {
  const prefix = buildInjectionPrefix(mt, memories);
  if (!prefix) return messages.slice();
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") { idx = i; break; }
  }
  if (idx < 0) return messages.slice();
  const out = messages.slice();
  const msg = out[idx]!;
  out[idx] = { ...msg, content: prependText(msg.content, prefix) };
  return out;
}
