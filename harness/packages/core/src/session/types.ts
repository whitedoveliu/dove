/**
 * 消息 / parts 模型（计划 T0.4；答疑 p04）
 * 纪律：parts 是唯一真相源 —— UI 渲染与模型转换都从它出发。
 */
import type { SegmentKind } from "../constants.ts";

/** part 类型：text | reasoning | file | image | step-start | injection | tool-<Name> */
export type PartType =
  | "text" | "reasoning" | "file" | "image" | "step-start" | "injection" | `tool-${string}`;

export type PartState =
  | "streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "approval-requested"
  | "approval-responded"
  | "permission-denied";

export interface BasePart {
  type: PartType;
  state?: PartState;
  /** 稳定 id，用于流式增量合并 */
  id?: string;
}

export interface TextPart extends BasePart { type: "text" | "reasoning"; text: string; }

export interface FilePart extends BasePart {
  type: "file" | "image";
  mediaType: string;
  url: string;          // 文件系统路径或 data: URL
  filename?: string;
}

export interface ToolPart extends BasePart {
  type: `tool-${string}`;
  toolCallId: string;
  toolName: string;
  input?: unknown;
  /**
   * provider 逐字节给的原始参数串。落库它、重建时原样重放：
   * `JSON.stringify(safeParse(raw))` 会把 `{"a":"b"}` 重新排版成 `{"a": "b"}`，
   * 差一个空格就够让整段缓存前缀作废（见 agent/wire-history.ts 的铁律二）。
   */
  inputRaw?: string;
  output?: unknown;
  errorText?: string;
  approvalDecision?: "allow" | "deny";
  /** 输出预算处理后的存档路径（超长结果落盘） */
  spillPath?: string;
  startedAt?: number;
  finishedAt?: number;
}

/**
 * 中途注入模型的消息（steering 插话 / 闸门提醒）：实时以 role:"user" 进 wire。
 * 为什么落成 parts 而不是独立消息：一轮只落**一条** assistant 行，独立消息按 created_at
 * 排不进它的两步之间（重建顺序会错）—— 见 agent/runtime.ts 与 agent/wire-history.ts。
 */
export interface InjectionPart extends BasePart { type: "injection"; text: string; }

/**
 * 步边界记号：runtime 在每个 step 开头打进 parts，重建时按它把一轮切回若干步
 * （并行多调用与两步各一次调用只能靠它区分）。它**不上 wire**，也不渲染。
 */
export interface StepStartPart extends BasePart { type: "step-start"; }

export type Part = TextPart | FilePart | ToolPart | InjectionPart | StepStartPart;

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  parts: Part[];
  createdAt: number;
  /** 分支支持 */
  parentId?: string | null;
  depth?: number;
  /** 模型可见的原始用量（用于压缩估算） */
  usage?: Usage;
  /**
   * 这条消息**从哪来的**。`"injection"` = 宿主注入（不是用户说的话），
   * 面板据此把它挡在用户气泡之外；模型侧照常可见（含回放）。
   * 见 agent/mode-injection.ts。
   */
  origin?: string;
  /** 注入的种类（origin === "injection" 时才有意义），如 "swarm-mode" */
  variant?: string;
  /**
   * 实时贴上 wire 的尾上下文前缀（`[Context: …]` + 记忆切片）——**逐字节原文**。
   * 只有「当轮最新那条 user 消息」会带它；重建时由 toWireHistory 原样重放，
   * 这样上一轮的 user 消息在下一轮的请求里逐字节不变（跨轮缓存前缀的全部来源）。
   * 落库在 messages.metadata JSON 上，见 session/store.ts。
   */
  tail?: string;
  /**
   * 撤销时刻（`messages.undone_at`，毫秒）。有值 = 这条消息被撤销了：
   * 磁盘上那一行仍在（**从不删行**），只是读历史时不再返回它（见 session/store.ts 的 undoTurns）。
   * listMessages 照旧返回它们（UI 要把撤销过的回合显示成灰色，而不是凭空消失），
   * recentMessages / 重建 wire 则跳过 —— 后者才是模型看得到的历史。
   */
  undoneAt?: number;
  /**
   * 这一轮改了哪些文件（回合净 diff 的**快照**）。落库在 messages.metadata JSON 上。
   * 为什么要存它：面板要在**回合结束之后**（含刷新/重开）把「本轮产出的文件」列出来并支持点开预览，
   * 而 turn_diff 原本只是 SSE 里发一次的事件，刷新就没了 —— 用户明确要求「每个会话结束后展示出来」。
   * ⚠️ 边界：只覆盖**自报**的 Write/Edit；Bash 重定向、RunScript、终端里的改动看不见
   * （见 tools/turn-diff.ts 的文件头说明，别把它当成「这一轮磁盘变化的全集」）。
   */
  turnDiff?: {
    files: { path: string; added: number; removed: number; created: boolean; deleted: boolean }[];
    truncated: boolean;
  };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Thread {
  id: string;
  /**
   * home    = 常驻调度线程
   * project = 项目工作线程
   * subagent = 子代理的过程线程（A1）—— 内容只读，用来「点进去看它干了什么」。
   *            它和 project 一样带 projectId，所以项目级的过滤/删除**自动覆盖**它。
   */
  kind: "home" | "project" | "subagent";
  projectId?: string | null;
  title: string;
  model: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultRecord {
  toolCallId: string;
  toolName: string;
  output?: unknown;
  errorText?: string;
  /** 写类工具的幂等 hash */
  contentHash?: string;
}

/** 工具名 → part type */
export function toolPartType(name: string): PartType {
  return `tool-${name}` as PartType;
}

export function toolPartName(type: string): string | null {
  return type.startsWith("tool-") ? type.slice(5) : null;
}

export function isToolPart(p: Part): p is ToolPart {
  return p.type.startsWith("tool-");
}
