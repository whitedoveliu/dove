/**
 * 消息 / parts 模型（计划 T0.4；答疑 p04）
 * 纪律：parts 是唯一真相源 —— UI 渲染与模型转换都从它出发。
 */
import type { SegmentKind } from "../constants.ts";

/** part 类型：text | reasoning | file | image | tool-<Name> */
export type PartType =
  | "text" | "reasoning" | "file" | "image" | "step-start" | `tool-${string}`;

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
  output?: unknown;
  errorText?: string;
  approvalDecision?: "allow" | "deny";
  /** 输出预算处理后的存档路径（超长结果落盘） */
  spillPath?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type Part = TextPart | FilePart | ToolPart;

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
