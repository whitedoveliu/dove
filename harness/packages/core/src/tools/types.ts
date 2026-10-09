/**
 * 工具系统类型（T3.1）
 * 一个工具 = 声明 + 执行器 + 输出档位 + 审批档位 + 并行安全性
 * 纪律（D7）：一个工具一个文件；registry.ts 只做汇总排序。
 */
import type { ToolSchema } from "../providers/types.ts";

/** 输出档位（T3.5） */
export type OutputTier = "passthrough" | "exact" | "compact";

/** 审批档位（T3.7-T3.9） */
export type ApprovalMode = "never" | "heuristic" | "always";

export interface ToolContext {
  toolCallId: string;
  threadId: string;
  /** 当前工作目录（项目根） */
  workdir: string;
  /** 产物目录 */
  outputsDir: string;
  signal?: AbortSignal;
  /** 事件上报（走 server 唯一出口） */
  emit: (event: string, data: Record<string, unknown>) => void;
  /** 请求用户审批；返回 false 表示拒绝/超时 */
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalResponse>;
  /** 数据服务（记忆等）注入点，避免 tools 直接依赖 memory */
  services: ToolServices;
}

export interface ApprovalRequest {
  title: string;
  message: string;
  riskLevel: "safe" | "low" | "medium" | "high";
  metadata?: Record<string, unknown>;
}

export interface ApprovalResponse {
  approved: boolean;
  reason?: "user" | "timeout" | "no-window";
  denyReason?: string;
  decision?: "allow" | "deny";
}

export interface ToolServices {
  recall?: (query: string, limit?: number) => Promise<{ content: string; score: number; createdAt: number }[]>;
  remember?: (content: string, kind?: string, scope?: string) => Promise<string>;
  /** 启动子代理（M6）；background=true 时立即返回 taskId */
  spawnSubagent?: (opts: { prompt: string; label?: string; background?: boolean })
    => Promise<{ status: "running" | "done"; taskId?: string; output?: string }>;
  /** 查后台任务状态（TaskOutput 用） */
  getTask?: (taskId: string) => { taskId: string; label: string; status: string; result?: string } | undefined;
  /** 把任务派到项目线程（D8：Home 只读 + 调度） */
  dispatchToProject?: (projectId: string, instruction: string) => Promise<{ output: string; endReason: string }>;
  /** 项目操作 */
  project?: ProjectOps;
  /**
   * 检索**屏幕内容**（截图 OCR 的历史）。
   * 和 recall 是两条不同的记忆通道：recall 查的是沉淀下来的长期记忆，
   * searchScreen 查的是「我当时在屏幕上看到过什么」。
   */
  searchScreen?: (query: string, limit?: number) => ScreenHit[];
  /**
   * 搜索 API 的 key（目前是 Tavily）。
   *
   * 为什么不直接读 process.env：env 文件是被 loadConfig 解析成对象用的，
   * **不会**写进 process.env（避免密钥出现在 ps 里）。所以走注入。
   *
   * 没配 key 时 WebSearch 自动退回抓搜索引擎 HTML —— 质量差但零依赖。
   */
  webSearchKey?: string;
}

/** 屏幕检索的一条命中（结构来自 memory/screen-index.ts，这里只声明形状避免跨层 import） */
export interface ScreenHit {
  frameId: string;
  snapshotId: string;
  text: string;
  matched: string[];
  score: number;
  at: number;
  appName?: string | null;
  windowTitle?: string | null;
  filePath?: string | null;
}

export interface ProjectOps {
  build(): Promise<{ ok: boolean; output: string; durationMs: number }>;
  preview(): Promise<{ url: string; port: number }>;
  listVersions(): Promise<{ version: string; message: string; at: number }[]>;
  restoreVersion(version: string): Promise<{ ok: boolean; message: string }>;
  snapshot(message: string): Promise<{ ok: boolean; version?: string; message: string }>;
}

export interface ToolResult {
  /** 给模型看的输出（已经过预算裁剪由 budget.ts 处理） */
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description: string;
  /**
   * 一句话说明「这个工具能干什么」，**给 ToolSearch 的描述用**。
   *
   * 为什么需要它：按需工具不在模型的默认工具表里，模型只能靠读 ToolSearch 的说明
   * 知道「有什么可搜」。原来那句话是手写的四个例子（网页搜索/网页抓取/PPT/版本管理），
   * **漏了子代理** —— 而且「版本管理」在工具删掉之后还留着。
   * 实测后果：用户让模型"派子代理"，模型压根不知道有这个能力，全程自己搜网页。
   * 现在改成从这张表生成，加/删按需工具时描述自动跟着变。
   */
  discoverable?: string;
  /** JSON Schema（object） */
  parameters: Record<string, unknown>;
  outputTier: OutputTier;
  approval: ApprovalMode;
  concurrencySafe: boolean;
  /** 超时覆盖（毫秒） */
  timeoutMs?: number;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolDefinition extends Tool {}

export function defineTool<T extends Tool>(t: T): T { return t; }

export function toWireSchema(t: Tool): ToolSchema {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

/**
 * 批量转 wire schema。
 * ⚠️ 缓存纪律：**输入数组的顺序即 wire 顺序**，调用方必须传「固定前导 + 只追加」的数组。
 *    任何重排都会让 provider 的前缀缓存整段失效。
 */
export function toWireSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map(toWireSchema);
}

/** 常用 JSON Schema 片段 */
export const S = {
  str: (desc: string) => ({ type: "string", description: desc }),
  num: (desc: string) => ({ type: "number", description: desc }),
  bool: (desc: string) => ({ type: "boolean", description: desc }),
  obj: (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required }),
  arr: (items: unknown, desc: string) => ({ type: "array", items, description: desc }),
} as const;
