/**
 * 前端类型：对齐内核 HTTP / SSE 契约
 * 历史消息沿用内核 session/types.ts 的 parts 模型（parts 是唯一真相源）
 */

export type ThreadKind = "home" | "project";

export interface Thread {
  id: string;
  kind: ThreadKind | string;
  projectId?: string | null;
  title: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  port?: number;
  kind?: string;
}

export interface Health {
  ok: boolean;
  version?: string;
  model?: string;
}

export interface MemoryItem {
  id?: string;
  kind?: string;
  scope?: string;
  content?: string;
  status?: string;
  /** 检索命中时才有；列表接口通常没有 */
  score?: number;
  confidence?: number;
  useCount?: number;
  createdAt?: number;
  [key: string]: unknown;
}

/** 事件日志行：字段随类型变化，未知字段原样展示 */
export interface LogEvent {
  seq?: number;
  type?: string;
  ts?: number;
  threadId?: string;
  [key: string]: unknown;
}

/* ---------- 内核 part 模型（只读消费） ---------- */

export type PartState =
  | "streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "approval-requested"
  | "approval-responded"
  | "permission-denied";

export interface BasePart {
  type: string;
  state?: PartState;
  id?: string;
}

export interface TextPart extends BasePart {
  type: "text" | "reasoning";
  text: string;
}

export interface FilePart extends BasePart {
  type: "file" | "image";
  mediaType?: string;
  url: string;
  filename?: string;
}

export interface ToolPart extends BasePart {
  type: string;
  toolCallId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  spillPath?: string;
  approvalDecision?: "allow" | "deny";
  startedAt?: number;
  finishedAt?: number;
}

export type Part = TextPart | FilePart | ToolPart;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  [key: string]: unknown;
}

/** GET /api/threads/:id/messages 的单条消息（宽容解析） */
export interface RawMessage {
  id?: string;
  threadId?: string;
  role?: string;
  parts?: Part[];
  content?: unknown;
  text?: string;
  createdAt?: number;
  usage?: Usage;
}

/* ---------- SSE ---------- */

/** 字段全部可选：未知事件类型被 UI 忽略，后端演进不炸面板 */
export interface SSEEvent {
  type: string;
  content?: string;
  turn?: number;
  step?: number;
  tool?: string;
  toolCallId?: string;
  input?: unknown;
  result?: unknown;
  spillPath?: string;
  message?: string;
  riskLevel?: string;
  question?: string;
  suggestions?: string[];
  todos?: Todo[];
  usage?: Usage;
  durationMs?: number;
}

export interface Todo {
  content: string;
  status: string;
}

/* ---------- UI 渲染模型 ---------- */

export interface UIReasoningPart {
  kind: "reasoning";
  id: string;
  text: string;
  done: boolean;
}

export interface UITextPart {
  kind: "text";
  id: string;
  text: string;
  done: boolean;
}

export interface UIErrorPart {
  kind: "error";
  id: string;
  text: string;
}

export interface Approval {
  toolCallId: string;
  tool: string;
  message: string;
  riskLevel: string;
  command?: string;
}

export interface UIToolPart {
  kind: "tool";
  id: string;
  toolCallId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  spillPath?: string;
  state: PartState;
  approval?: Approval;
  startedAt: number;
  finishedAt?: number;
}

export type UIPart = UIReasoningPart | UITextPart | UIErrorPart | UIToolPart;

export interface AskRequest {
  question: string;
  suggestions: string[];
}

export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: UIPart[];
  createdAt: number;
  /** true = 仍在流式接收（增量合并目标） */
  open?: boolean;
  usage?: Usage;
  durationMs?: number;
}

export interface PreviewInfo {
  url: string;
  port?: number;
}

/** 工具状态是否终态 */
export function isToolSettled(state: PartState): boolean {
  return state === "output-available" || state === "output-error" || state === "permission-denied";
}

/* ---------- 新面板契约（M6 / M7：服务未接入时返回 { available:false }） ---------- */

/** 可选服务统一形状：available:false = 未接入，面板静默降级、不显示 */
export interface OptionalService {
  available?: boolean;
}

/** 情绪层：valence -10 ~ 10，中性基线 6 */
export interface EmotionLayer {
  label: string;
  valence: number;
  reason?: string;
  updatedAt?: number;
}

export interface EmotionState extends OptionalService {
  base?: EmotionLayer;
  context?: EmotionLayer;
  fused?: EmotionLayer;
}

/** 疲劳快照：端口给 level，服务快照给 fatigue，两个都兼容 */
export interface FatigueState extends OptionalService {
  level?: number;
  fatigue?: number;
  energy?: number;
  state?: string;
  sleeping?: boolean;
  hours?: number;
  hint?: string;
  note?: string;
  updatedAt?: number;
}

export interface CronJob {
  id: string;
  name: string;
  type: "at" | "every" | "cron" | string;
  schedule: string;
  mode: "main" | "isolated" | string;
  prompt: string;
  enabled: boolean;
  timezone?: string;
  createdAt?: number;
  updatedAt?: number;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  runCount?: number;
}

export interface CronList extends OptionalService {
  jobs?: CronJob[];
}

export interface CronRun {
  id?: string;
  jobId?: string;
  jobName?: string;
  startedAt?: number;
  finishedAt?: number | null;
  ok?: boolean;
  result?: string;
  error?: string;
  trigger?: string;
  receipt?: string;
}

export interface CronRunResult {
  ok?: boolean;
  result?: string;
  error?: string;
}

export interface HeartbeatResult {
  ran?: boolean;
  suppressed?: boolean;
  output?: string;
  /** off-hours / in-flight / heartbeat-ok / empty / run-failed / deliver-failed */
  reason?: string;
}

export interface ActivityStatus extends OptionalService {
  snapshots?: number;
  bytes?: number;
  lastCaptureAt?: number;
  totalLimitBytes?: number;
  trimTargetBytes?: number;
  /** 屏幕录制权限：后端可能用不同字段名体现，全部兼容 */
  screenPermission?: boolean;
  screenRecording?: boolean;
  permission?: boolean;
  note?: string;
}

export interface ActivityCaptureResult {
  ok?: boolean;
  snapshotId?: string;
  skipped?: string;
  error?: string;
  bytes?: number;
}

export interface ActivityReport {
  kind?: string;
  date?: string;
  report?: string;
  note?: string;
}

/** GET /api/files/:projectId：children 递归的目录节点 */
export interface BackendFileNode {
  name: string;
  type?: string;
  size?: number;
  children?: BackendFileNode[];
}

export interface ProjectTree {
  id?: string;
  name?: string;
  children?: BackendFileNode[];
}

export interface FileContent {
  path: string;
  content: string;
  truncated?: boolean;
}

/** POST /api/memory/sleep 的统计；未知字段原样展示 */
export interface SleepStats {
  status?: string;
  trigger?: string;
  examined?: number;
  archivedExact?: number;
  archivedExpired?: number;
  archivedOrphan?: number;
  archivedSimilarity?: number;
  merged?: number;
  llmChecked?: number;
  llmMerged?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  skipped?: boolean;
  note?: string;
  [key: string]: unknown;
}
