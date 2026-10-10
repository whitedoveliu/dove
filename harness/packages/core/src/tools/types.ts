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
  /**
   * 把一张本地图片挂进对话（ReadImage 用）。
   *
   * 为什么不是一个普通的返回值：OpenAI 兼容协议里 role:"tool" 的 content **只能是字符串**，
   * 图片塞不进工具结果。所以图片必须走既有的 image part 链路（消息 parts 的 "image" 类型），
   * 由运行时负责落库 + 在下一步注入。工具侧只递一个请求，不认识 store / loop。
   */
  attachImage?: (req: ImageAttachRequest) => Promise<ImageAttachResult>;
  /** MCP 资源能力（ListMcpResources / ReadMcpResource 用）；没接 MCP 时为 undefined */
  mcp?: McpResourcePort;
  /** 子代理控制面（ListAgents 用）；由 agent 运行时实现 */
  listAgents?: () => AgentSummary[];
  /** 给子代理追加消息（SendMessage 用）；语义见返回值里的 mode */
  sendAgentMessage?: (id: string, message: string) => Promise<AgentSendResult>;
  /** 中断正在跑的子代理（InterruptAgent 用） */
  interruptAgent?: (id: string) => AgentInterruptResult;
  /** 定时任务（CronCreate / CronList / CronDelete 用） */
  cron?: CronOps;
  /** 当前上下文统计（GetContextRemaining 用）；拿不到真实 usage 时返回估算值 */
  contextStats?: () => ContextStats;
  /** 长期目标（CreateGoal / GetGoal / UpdateGoal 用）；面板的 /goal 共用同一张表 */
  goals?: GoalPort;
  /** 计划批准后退出计划模式（ExitPlanMode 用）；**只有处于计划模式时**运行时才会挂上 */
  exitPlanMode?: (plan: string) => Promise<{ ok: boolean; error?: string }>;
}

/** 图片附件请求 / 结果（ReadImage → 运行时） */
export interface ImageAttachRequest {
  /** 绝对路径 */
  path: string;
  mediaType: string;
  filename?: string;
}
export interface ImageAttachResult {
  ok: boolean;
  /** 落库后的消息 id（图片作为一条 user 消息存进线程） */
  id?: string;
  error?: string;
  note?: string;
}

/** MCP 资源（列表 / 模板 / 内容）——形状对齐 mcp/client.ts 的 McpResource 等 */
export interface McpResourceInfo { uri: string; name?: string; mimeType?: string; description?: string }
export interface McpResourceTemplateInfo { uriTemplate: string; name?: string; mimeType?: string; description?: string }
export interface McpResourceListing {
  server: string;
  ok: boolean;
  resources?: McpResourceInfo[];
  templates?: McpResourceTemplateInfo[];
  error?: string;
  note?: string;
}
export interface McpResourceContentInfo {
  uri?: string;
  mimeType?: string;
  text?: string;
  /** blob 只报字节数：base64 塞进上下文既没用又贵 */
  blobBytes?: number;
  note?: string;
}
export interface McpResourceReadResult {
  server: string;
  ok: boolean;
  contents?: McpResourceContentInfo[];
  error?: string;
  note?: string;
}
/**
 * 长期目标的一条视图（工具与面板看到的是同一份形状）。
 * 真正的存储在 agents/goal-store.ts；tools 层只依赖这个形状，不 import agents/。
 */
export interface GoalView {
  id: string;
  revision: number;
  objective: string;
  phase: string;
  roundsStarted: number;
  maxRounds: number;
  blockedReason?: string;
}

/** 目标端口：GoalStore 结构化实现它（不 import agents/，靠形状对上） */
export interface GoalPort {
  get(threadId: string): GoalView | null;
  create(threadId: string, input: { objective: string; maxRounds?: number }): GoalView;
  update(threadId: string, input: {
    goalId: string;
    revision: number;
    action: "edit" | "pause" | "resume" | "complete" | "blocked";
    objective?: string;
    maxRounds?: number;
    blockedReason?: string;
  }): GoalView;
}

export interface McpResourcePort {
  servers(): { name: string; connected: boolean; enabled: boolean; error?: string }[];
  list(server?: string): Promise<McpResourceListing[]>;
  read(uri: string, server?: string): Promise<McpResourceReadResult[]>;
}

/** 子代理 / 后台任务的一条摘要（ListAgents 的输出行） */
export interface AgentSummary {
  id: string;
  label: string;
  status: "running" | "done" | "error" | "canceled" | "unknown";
  background: boolean;
  /** 后台任务 id（TaskRegistry）；前台子代理没有 */
  taskId?: string;
  startedAt: number;
  finishedAt?: number;
  steps?: number;
  endReason?: string;
  /** live = 本进程还在跟踪（能中断/追加）；record = 只在库里 */
  source: "live" | "record";
  outputPreview?: string;
}
export interface AgentSendResult {
  ok: boolean;
  /**
   * injected = 子代理还在跑，消息会在它的下一步被读进去（真注入）；
   * resumed  = 它已经结束了，带着它之前的最终答复**新起一个**子代理继续做。
   */
  mode?: "injected" | "resumed";
  error?: string;
  note?: string;
  ///* resumed 时是新子代理的结论 */
  output?: string;
  subagentId?: string;
}
export interface AgentInterruptResult {
  ok: boolean;
  error?: string;
  note?: string;
  status?: string;
}

/** 定时任务（CronCreate / CronList / CronDelete 用） */
export interface CronJobInfo {
  id: string;
  name: string;
  type: string;
  schedule: string;
  mode: string;
  prompt: string;
  enabled: boolean;
  timezone?: string;
  createdAt: number;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  runCount: number;
}
export interface CronCreateResult { ok: boolean; job?: CronJobInfo; error?: string; warning?: string }
export interface CronOps {
  create(job: {
    name?: string; type?: string; schedule: string; mode?: string;
    prompt: string; timezone?: string; model?: string; deliverTo?: string;
  }): CronCreateResult;
  list(): CronJobInfo[];
  remove(id: string): { ok: boolean; error?: string };
  /** 当前生效的时区名（模型需要知道「本地时间」到底是哪个时区） */
  timezone(): string;
}

/**
 * 当前上下文统计（GetContextRemaining 用）。
 * source=usage 时 used 来自 provider 上报的真实用量；source=estimate 时是本地估算。
 */
export interface ContextStats {
  model: string;
  contextWindow: number;
  /** 压缩触发线（窗口 × 阈值%，与「窗口 − 输出预留」取较小者） */
  compactAt: number;
  used: number;
  /** used / contextWindow × 100 */
  percent: number;
  /** used / compactAt × 100 */
  compactPercent: number;
  nearCompact: boolean;
  wouldCompactNow: boolean;
  source: "usage" | "estimate";
  messages: number;
  note?: string;
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
