/**
 * 内核 HTTP 客户端。
 *
 * 三种运行形态都要能工作：
 * ① 内核托管（生产）：同源，直接用相对路径
 * ② vite dev：同源，/api 由 vite 代理到 127.0.0.1:8790
 * ③ Tauri 等外部宿主：页面来自 tauri://localhost，同源没有内核 → 指向本地内核
 */
export const API_BASE = (() => {
  const injected = (globalThis as { __DOVE_API_BASE__?: string }).__DOVE_API_BASE__;
  if (typeof injected === "string" && injected.length > 0) return injected.replace(/\/$/, "");
  if (typeof location === "undefined") return "http://127.0.0.1:8790";
  if (location.protocol === "http:" || location.protocol === "https:") return "";
  // tauri:// file:// 等非 http 宿主 → 连本地内核
  return "http://127.0.0.1:8790";
})();

import type {
  ActivityCaptureResult,
  ActivityReport,
  ActivityStatus,
  CronJob,
  CronList,
  CronRun,
  CronRunResult,
  EmotionState,
  FatigueState,
  FileContent,
  Health,
  HeartbeatResult,
  LogEvent,
  MemoryItem,
  PreviewInfo,
  Project,
  ProjectTree,
  RawMessage,
  SleepStats,
  Thread,
} from "../types.ts";

export class ApiError extends Error {
  status: number;

  constructor(status: number, detail: string) {
    super(detail || "HTTP " + status);
    this.name = "ApiError";
    this.status = status;
  }
}

function detailOf(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: string; message?: string };
    return j.error ?? j.message ?? "";
  } catch {
    return text.slice(0, 200);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new ApiError(0, "无法连接内核：" + (err as Error).message);
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, detailOf(text) || res.statusText);
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, "响应不是 JSON：" + text.slice(0, 160));
  }
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

/** 后端可能返回裸数组或 { items: [...] }，统一成数组 */
export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const bag = value as Record<string, unknown>;
    for (const key of ["items", "data", "threads", "projects", "messages", "events", "logs", "memories", "list"]) {
      if (Array.isArray(bag[key])) return bag[key] as T[];
    }
  }
  return [];
}

export const api = {
  health: () => request<Health>("/api/health"),

  threads: async () => asArray<Thread>(await request<unknown>("/api/threads")),
  createThread: (body: { kind: string; title?: string; projectId?: string | null }) =>
    post<Thread>("/api/threads", body),
  messages: async (threadId: string) =>
    asArray<RawMessage>(await request<unknown>("/api/threads/" + encodeURIComponent(threadId) + "/messages")),

  stop: (threadId: string) => post<unknown>("/api/stop", { threadId }),
  answer: (threadId: string, answer: string) => post<unknown>("/api/answer", { threadId, answer }),
  approve: (body: { threadId: string; toolCallId: string; approved: boolean; reason?: string }) =>
    post<unknown>("/api/approve", body),

  projects: async () => asArray<Project>(await request<unknown>("/api/projects")),
  createProject: (body: { name: string; path: string }) => post<Project>("/api/projects", body),

  memory: async () => asArray<MemoryItem>(await request<unknown>("/api/memory")),
  /** 手动跑一次睡眠合并，返回统计 */
  memorySleep: () => post<SleepStats>("/api/memory/sleep", {}),
  configFile: (name: string) =>
    request<{ name: string; content: string }>("/api/config/file?name=" + encodeURIComponent(name)),
  saveConfigFile: (name: string, content: string) =>
    post<{ ok: boolean }>("/api/config/file", { name, content }),

  /* ---- 情绪 / 疲劳（可能 { available:false }） ---- */
  emotion: () => request<EmotionState>("/api/emotion"),
  setEmotion: (body: { layer: "base" | "context"; label?: string; valence?: number }) =>
    post<EmotionState & { ok?: boolean }>("/api/emotion", body),
  fatigue: () => request<FatigueState>("/api/fatigue"),
  fatigueAction: (body: { action: "sleep" | "wake" | "rest"; minutes?: number }) =>
    post<FatigueState & { ok?: boolean }>("/api/fatigue", body),

  /* ---- 定时任务 ---- */
  cron: () => request<CronList>("/api/cron"),
  createCron: (body: Partial<CronJob>) => post<CronJob>("/api/cron", body),
  removeCron: (id: string) => del<{ ok: boolean }>("/api/cron/" + encodeURIComponent(id)),
  runCron: (id: string) => post<CronRunResult>("/api/cron/" + encodeURIComponent(id) + "/run", {}),
  cronHistory: async (limit = 30) =>
    asArray<CronRun>(await request<unknown>("/api/cron/history?limit=" + limit)),

  /* ---- 心跳 ---- */
  heartbeat: () => post<HeartbeatResult>("/api/heartbeat", {}),

  /* ---- 感知（M7） ---- */
  activityStatus: () => request<ActivityStatus>("/api/activity/status"),
  activityCapture: () => post<ActivityCaptureResult>("/api/activity/capture", { reason: "manual" }),
  activityReport: (kind: "daily" | "weekly") =>
    request<ActivityReport>("/api/activity/report?kind=" + kind),

  /* ---- 文件 ---- */
  files: (projectId: string) =>
    request<ProjectTree | null>("/api/files/" + encodeURIComponent(projectId)),
  file: (projectId: string, path: string) =>
    request<FileContent>(
      "/api/file?projectId=" + encodeURIComponent(projectId) + "&path=" + encodeURIComponent(path),
    ),

  logs: async (threadId: string, limit = 200) =>
    asArray<LogEvent>(
      await request<unknown>("/api/logs?threadId=" + encodeURIComponent(threadId) + "&limit=" + limit),
    ),

  build: (projectId: string) => post<unknown>("/api/build", { projectId }),
  preview: (projectId: string) =>
    request<PreviewInfo>("/api/preview/" + encodeURIComponent(projectId)),
};
