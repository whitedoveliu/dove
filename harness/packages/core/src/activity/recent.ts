/**
 * 「最近 N 小时我在干嘛」—— 问候通道的输入（也是给人看的诊断材料）。
 *
 * 纪律：
 * - **纯本地**：只读 activity_* 表，绝不调 LLM（问候通道不能有网络延迟）；
 * - **绝不抛**：任何一步失败都降级，最坏返回 null（问候块会用兜底指令）；
 * - **具体优先**：窗口标题 / 文件 / 项目名比「用户在使用电脑」有用一万倍 —— 硬性指令要求提一件具体的事。
 */
import { ACTIVITY_INJECT } from "../constants.ts";
import type { ActivitySessionRow } from "./types.ts";
import { dateKey, DAY_MS, type ActivityStore } from "./store.ts";

export interface RecentSummaryOptions {
  hours?: number;
  /** 注入用「现在」，测试可覆盖 */
  now?: number;
  /** 最多列几条会话 */
  maxSessions?: number;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

/** 已分析的会话 → 一行「时间 + 在干嘛」 */
function analyzedLine(s: ActivitySessionRow): string {
  const a = s.summary!;
  const span = s.endedAt ? `${clock(s.startedAt)}–${clock(s.endedAt)}` : `${clock(s.startedAt)} 起`;
  const title = (a.title || a.project || "").trim();
  const parts: string[] = [];
  if (title) parts.push(title);
  if (a.description) parts.push(clip(a.description, 90));
  if (a.topics?.length) parts.push(`话题：${a.topics.slice(0, 4).join("、")}`);
  if (a.highlights?.length) parts.push(`要点：${clip(a.highlights.slice(0, 2).join("；"), 90)}`);
  return parts.length ? `- ${span} ${parts.join("｜")}` : "";
}

/** 没分析的会话 → 退回窗口标题（照样是「具体的事」） */
function rawLine(store: ActivityStore, s: ActivitySessionRow): string {
  const snaps = store.snapshotsForSession(s.id, 8);
  if (!snaps.length) return "";
  const apps = [...new Set(snaps.map((x) => x.appName).filter(Boolean))].slice(0, 2);
  const titles = [...new Set(snaps.map((x) => x.windowTitle).filter(Boolean))].slice(0, 3);
  const span = s.endedAt ? `${clock(s.startedAt)}–${clock(s.endedAt)}` : `${clock(s.startedAt)} 起`;
  const what = [apps.join(" / "), titles.join(" / ")].filter(Boolean).join(" — ");
  return what ? `- ${span} ${clip(what, 110)}（${snaps.length} 张截图）` : "";
}

/**
 * 组装最近活动摘要；窗口内什么都没有 → null。
 * 输出已经裁剪到 ACTIVITY_INJECT.greetingSummaryChars 以内。
 */
export function buildRecentSummary(store: ActivityStore, opts: RecentSummaryOptions = {}): string | null {
  const hours = opts.hours ?? ACTIVITY_INJECT.greetingWindowMs / 3_600_000;
  const now = opts.now ?? Date.now();
  const from = now - hours * 3_600_000;
  const maxSessions = opts.maxSessions ?? 8;
  try {
    const sessions = store.sessionsBetween(from, now, 60).slice(-maxSessions);
    const lines: string[] = [];
    for (const s of sessions) {
      try {
        const line = s.summary ? analyzedLine(s) : rawLine(store, s);
        if (line) lines.push(line);
      } catch { /* 单条会话坏掉不影响其它 */ }
    }

    // 日报是 LLM 叙事，信息密度最高：有就放在最前面
    const daily: string[] = [];
    for (const key of [dateKey(now), dateKey(now - DAY_MS)]) {
      try {
        const row = store.getSummary("daily", key);
        const text = (row?.summary ?? "").trim();
        if (text) daily.push(`${key} 的工作日志：${clip(text, 220)}`);
      } catch { /* ignore */ }
    }

    if (!lines.length && !daily.length) return null;
    const head = `最近 ${Math.round(hours)} 小时（${dateKey(from)} ~ ${dateKey(now)}）：`;
    const body = [
      head,
      ...daily,
      ...(lines.length ? ["屏幕活动：", ...lines] : []),
    ].join("\n");
    return clip(body, ACTIVITY_INJECT.greetingSummaryChars);
  } catch {
    return null;
  }
}
