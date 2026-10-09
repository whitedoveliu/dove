/**
 * 感知层（M7 活动记录器）公共类型。
 * 只放类型定义，不产生副作用；上层（server / index.ts）从这里取契约。
 */

/** 活动记录器需要的最小 LLM 接口（与 memory 的 MemoryLlm 结构兼容，可直接传 providerLlm(provider, model)） */
export interface ActivityLlm {
  complete(prompt: string, opts?: { system?: string; temperature?: number; maxTokens?: number }): Promise<string>;
}

/** 触发来源：哪些原因会导致采一帧 */
export type TriggerKind = "heartbeat" | "visual_change" | "app_focus" | "click" | "typing_pause" | "manual";

export interface TriggerMeta {
  appName?: string;
  windowTitle?: string;
}

/** activity_snapshots 一行 */
export interface SnapshotRow {
  id: string;
  sessionId: string | null;
  timestamp: number;
  filePath: string;
  width: number;
  height: number;
  sizeBytes: number;
  trigger: string;
  appName: string | null;
  windowTitle: string | null;
  hashHex: string | null;
  histogram: number[] | null;
  diffPct: number | null;
  storageTier: string;
  createdAt: number;
}

/** activity_ocr_frames 一行（text 已脱敏） */
export interface OcrFrameRow {
  id: string;
  snapshotId: string;
  sessionId: string | null;
  text: string;
  charCount: number;
  createdAt: number;
}

/** activity_events 一行（焦点 / 点击 / 打字等输入事件） */
export interface ActivityEventRow {
  id: string;
  sessionId: string | null;
  timestamp: number;
  kind: string;
  appName: string | null;
  data: Record<string, unknown>;
  createdAt: number;
}

/** 会话分析结果（analyzer.ts 的输出，存 activity_sessions.summary） */
export interface AnalysisEntity {
  type: string;
  name: string;
}

export interface MemoryCandidate {
  content: string;
  kind: string;
}

export interface AnalysisResult {
  worth: boolean;
  title: string;
  description: string;
  project: string;
  topics: string[];
  highlights: string[];
  entities: AnalysisEntity[];
  memoryCandidates: MemoryCandidate[];
  /** 产生该结果的模型；解析失败时为空 */
  model?: string;
  /** 非空表示这次分析降级了（无 LLM / JSON 坏 / 调用失败），结果不可信 */
  error?: string;
}

/** activity_sessions 一行（summary 已解析） */
export interface ActivitySessionRow {
  id: string;
  startedAt: number;
  endedAt: number | null;
  triggerKind: string;
  summary: AnalysisResult | null;
  analyzedAt: number | null;
  snapshotCount?: number;
}

/** 空结果：所有降级路径都返回它，绝不抛 */
export function emptyAnalysis(error?: string): AnalysisResult {
  return {
    worth: false, title: "", description: "", project: "",
    topics: [], highlights: [], entities: [], memoryCandidates: [],
    ...(error ? { error } : {}),
  };
}
