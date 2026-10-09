/** 展示层格式化：时间 / 时长 / 工具摘要 / 状态与风险色 */
import type { PartState, Usage } from "../types.ts";

export function formatClock(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

export function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s";
}

export function formatTokens(usage?: Usage): string {
  if (!usage) return "";
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  if (!inTok && !outTok) return "";
  return "↑" + inTok + " ↓" + outTok + (usage.cacheReadTokens ? " ⚡" + usage.cacheReadTokens : "");
}

export function shorten(text: string, max = 72): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

/** 字节 → 可读体积（面板只用 KB / MB 两档） */
export function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/** 时间戳 → 短日期时间（MM-DD HH:MM） */
export function formatDateTime(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** 时间戳 → 相对描述（刚刚 / N 分钟前 / 今天 HH:MM / MM-DD HH:MM） */
export function formatWhen(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return formatDateTime(ts);
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + " 分钟前";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = p(d.getHours()) + ":" + p(d.getMinutes());
  if (sameDay) return "今天 " + hm;
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + hm;
}

export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const SUMMARY_KEYS = [
  "command", "file_path", "filePath", "path", "pattern", "query",
  "url", "name", "target", "prompt", "content", "text",
];

/** 工具参数摘要：优先取语义字段，否则压平 JSON */
export function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return shorten(input);
  if (typeof input === "object") {
    const bag = input as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
      const v = bag[key];
      if (typeof v === "string" && v.trim()) return shorten(v);
    }
    try {
      return shorten(JSON.stringify(bag));
    } catch {
      return "[无法序列化的参数]";
    }
  }
  return String(input);
}

/** 值 → 可读文本（长文本截断，超长提示落盘路径在卡片上单独展示） */
export function stringifyValue(v: unknown, max = 20000): string {
  if (v == null) return "";
  if (typeof v === "string") return clip(v, max);
  try {
    return clip(JSON.stringify(v, null, 2), max);
  } catch {
    return clip(String(v), max);
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n…（已截断）" : text;
}

/** 从工具参数里取命令（审批弹窗要显示原始命令） */
export function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const bag = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "file_path", "path"]) {
    const v = bag[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export interface Tone {
  label: string;
  text: string;
  dot: string;
  border: string;
}

/** 工具状态 → 文案 + 配色（运行中/成功/失败/待审批/已拒绝） */
export function statusMeta(state: PartState, errorText?: string): Tone {
  switch (state) {
    case "output-available":
      return { label: "成功", text: "text-success", dot: "bg-success", border: "border-line-strong" };
    case "output-error":
      return { label: "失败", text: "text-danger", dot: "bg-danger", border: "border-danger/40" };
    case "approval-requested":
      return { label: "待审批", text: "text-warn", dot: "bg-warn", border: "border-warn/40" };
    case "approval-responded":
      return { label: "已审批", text: "text-info", dot: "bg-info", border: "border-line-strong" };
    case "permission-denied":
      return { label: "已拒绝", text: "text-danger", dot: "bg-danger", border: "border-danger/40" };
    case "streaming":
      return { label: "运行中", text: "text-accent", dot: "bg-accent animate-pulse", border: "border-accent/40" };
    default:
      return {
        label: errorText ? "失败" : "运行中",
        text: errorText ? "text-danger" : "text-accent",
        dot: errorText ? "bg-danger" : "bg-accent animate-pulse",
        border: "border-line-strong",
      };
  }
}

/** 风险级别 → 配色 */
export function riskTone(level?: string): Tone {
  const key = (level ?? "").toLowerCase();
  if (key.includes("high") || key.includes("danger") || key.includes("高")) {
    return { label: level || "high", text: "text-danger", dot: "bg-danger", border: "border-danger/50" };
  }
  if (key.includes("medium") || key.includes("warn") || key.includes("中")) {
    return { label: level || "medium", text: "text-warn", dot: "bg-warn", border: "border-warn/50" };
  }
  if (!key) {
    return { label: "unknown", text: "text-fg-dim", dot: "bg-fg-dim", border: "border-line-strong" };
  }
  return { label: level ?? "low", text: "text-success", dot: "bg-success", border: "border-line-strong" };
}
