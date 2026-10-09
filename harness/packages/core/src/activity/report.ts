/**
 * 日报 / 周报（T7.10）
 * 骨架版 = 确定性 markdown（按项目分组，不调模型、可快照测试）；
 * 叙事版 = 在骨架基础上让 LLM 写一遍读得下去的工作日志（失败则回退骨架）。
 * daily / weekly 共用同一份 system 提示词。
 */
import type { ActivityStore } from "./store.ts";
import { dateKey, dayRange, DAY_MS } from "./store.ts";
import type { ActivityLlm, ActivitySessionRow } from "./types.ts";

export const REPORT_SYSTEM = [
  "你是 Dove，帮用户把一天的屏幕活动整理成一份读得下去的工作日志。",
  "规则：",
  "1. 只写骨架里出现过的事实，禁止编造项目名、人名、数字、版本号、链接。",
  "2. 不要复述原始 OCR 文本，不要罗列标签，要写成连贯的段落。",
  "3. 按项目分组，每组 2-5 句：做了什么、推进到哪一步、留下什么结论。",
  "4. 不写评价与吹捧（「非常棒」「效率很高」这类一律不要），不写建议，除非骨架里有。",
  "5. 输出 markdown，中文，保留标题层级；不要加代码块包裹。",
].join("\n");

export const REPORT_MAX_TOKENS = 2_000;
export const NARRATE_TEMPERATURE = 0.3;

export interface ReportSession {
  id: string;
  project: string;
  title: string;
  description: string;
  topics: string[];
  highlights: string[];
  worth: boolean;
  analyzed: boolean;
  startedAt: number;
  endedAt: number | null;
  snapshotCount: number;
}

export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function toReportSession(row: ActivitySessionRow): ReportSession {
  const s = row.summary;
  return {
    id: row.id,
    project: (s?.project ?? "").trim() || "未归属项目",
    title: (s?.title ?? "").trim() || "活动片段（未分析）",
    description: (s?.description ?? "").trim(),
    topics: s?.topics ?? [],
    highlights: s?.highlights ?? [],
    worth: s?.worth ?? false,
    analyzed: !!row.analyzedAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    snapshotCount: row.snapshotCount ?? 0,
  };
}

/** 某一天的全部会话（按开始时间升序） */
export function collectSessions(store: ActivityStore, date: string): ReportSession[] {
  return store.listSessions(date).map(toReportSession).sort((a, b) => a.startedAt - b.startedAt);
}

function rangeText(s: ReportSession): string {
  return `${hhmm(s.startedAt)}–${s.endedAt ? hhmm(s.endedAt) : "进行中"}`;
}

function groupByProject(sessions: ReportSession[]): Map<string, ReportSession[]> {
  const map = new Map<string, ReportSession[]>();
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
    const list = map.get(s.project) ?? [];
    list.push(s);
    map.set(s.project, list);
  }
  return map;
}

function renderSessions(sessions: ReportSession[], indent: string): string[] {
  const lines: string[] = [];
  for (const s of sessions) {
    lines.push(`${indent}### ${rangeText(s)} · ${s.title}（快照 ${s.snapshotCount} 张）`);
    if (s.description) lines.push(`${indent}${s.description}`);
    if (s.highlights.length) {
      lines.push(`${indent}- 要点：`);
      for (const h of s.highlights) lines.push(`${indent}  - ${h}`);
    }
    if (s.topics.length) lines.push(`${indent}- 标签：${s.topics.join("、")}`);
    lines.push("");
  }
  return lines;
}

/** 骨架版（确定性）：按项目分组；不值得记的会话单独归到末尾 */
export function buildSkeleton(date: string, sessions: ReportSession[]): string {
  const lines: string[] = [`# 工作日志 · ${date}`, ""];
  const worth = sessions.filter((s) => s.worth || s.analyzed === false);
  const skipped = sessions.filter((s) => !worth.includes(s));
  const snapshots = sessions.reduce((n, s) => n + s.snapshotCount, 0);
  const from = sessions.length ? hhmm(Math.min(...sessions.map((s) => s.startedAt))) : "—";
  const to = sessions.length ? hhmm(Math.max(...sessions.map((s) => s.endedAt ?? s.startedAt))) : "—";
  lines.push(`统计：会话 ${sessions.length} 段 · 快照 ${snapshots} 张 · 覆盖 ${from}–${to}`, "");
  if (sessions.length === 0) {
    lines.push("（这一天没有任何活动记录）", "");
    return lines.join("\n");
  }
  for (const [project, list] of groupByProject(worth)) {
    lines.push(`## ${project}`, "");
    lines.push(...renderSessions(list, ""));
  }
  if (skipped.length) {
    lines.push("## 未记入日志的时段", "");
    for (const s of skipped) {
      lines.push(`- ${rangeText(s)} · 快照 ${s.snapshotCount} 张（判定为不值得记录）`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** 周报骨架：按天分组，再按项目分组 */
export function buildRangeSkeleton(fromKey: string, toKey: string, days: { date: string; sessions: ReportSession[] }[]): string {
  const all = days.flatMap((d) => d.sessions);
  const lines: string[] = [`# 工作周报 · ${fromKey} ~ ${toKey}`, ""];
  const snapshots = all.reduce((n, s) => n + s.snapshotCount, 0);
  const projects = [...new Set(all.map((s) => s.project))];
  lines.push(`统计：${days.length} 天 · 会话 ${all.length} 段 · 快照 ${snapshots} 张 · 项目 ${projects.length} 个`, "");
  if (projects.length) lines.push(`涉及项目：${projects.join("、")}`, "");
  for (const day of days) {
    lines.push(`## ${day.date}`, "");
    if (!day.sessions.length) { lines.push("- （无活动记录）", ""); continue; }
    for (const [project, list] of groupByProject(day.sessions.filter((s) => s.worth || !s.analyzed))) {
      lines.push(`### ${project}`, "");
      lines.push(...renderSessions(list, ""));
    }
  }
  return lines.join("\n");
}

/** 叙事版：把骨架交给 LLM 写成日志；任何失败都回退骨架 */
export async function narrate(skeleton: string, llm?: ActivityLlm, opts: { model?: string; maxTokens?: number } = {}): Promise<string> {
  if (!llm) return skeleton;
  const prompt = [
    "下面是今天活动日志的骨架（已经按项目分组，是唯一的事实来源）。",
    "请把它写成一份读得下去的工作日志：合并同一项目的多段会话，去掉重复，保留具体结论。",
    "不许新增骨架里没有的事实。",
    "",
    "骨架：",
    skeleton,
  ].join("\n");
  try {
    const out = await llm.complete(prompt, {
      system: REPORT_SYSTEM, temperature: NARRATE_TEMPERATURE, maxTokens: opts.maxTokens ?? REPORT_MAX_TOKENS,
    });
    const text = (out ?? "").trim();
    return text.length > 0 ? text : skeleton;
  } catch {
    return skeleton;
  }
}

/** 最近 N 天（含今天）的日报骨架数据 */
export function collectDays(store: ActivityStore, days: number, endTs = Date.now()): { date: string; sessions: ReportSession[] }[] {
  const out: { date: string; sessions: ReportSession[] }[] = [];
  const end = dayRange(dateKey(endTs)).to;
  for (let i = days - 1; i >= 0; i--) {
    const date = dateKey(end - (i + 1) * DAY_MS + 1);
    out.push({ date, sessions: collectSessions(store, date) });
  }
  return out;
}
