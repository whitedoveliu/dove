/**
 * 工具系统类型（T3.1）
 * 一个工具 = 声明 + 执行器 + 输出档位 + 审批档位 + 并行安全性
 * 纪律（D7）：一个工具一个文件；registry.ts 只做汇总排序。
 */
import type { ToolSchema } from "../providers/types.ts";
import type { PermissionProfile } from "./permission.ts";

/** 输出档位（T3.5） */
export type OutputTier = "passthrough" | "exact" | "compact";

/** 审批档位（T3.7-T3.9）。⚠️ 这是**工具自己的**档位；权限档位见 permission.ts 的 ApprovalPolicy */
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
  /**
   * 本轮生效的权限（两轴：沙箱 × 审批），由执行器从 ExecDeps 注入。
   * 缺省 = workspace-write 语义（只写工作区）——**fail-closed**，没接线时绝不放宽。
   * `escalated`：这次调用的越界写已经被审批通道放行过（工具侧护栏据此放行）。
   */
  permission?: PermissionProfile & { escalated?: boolean };
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
  /** reason=timeout 时：实际等了多久（毫秒）。写给用户看的错误文案要用它 */
  timeoutMs?: number;
  /**
   * 「同意并**记住**」：只对 approved 有意义。
   * 设为 true 时，会话级规则表里会记下这次调用的 `Tool.approvalRule(args)`，
   * 之后同形状的调用直接放行（见 tools/rule-pattern.ts）。
   * ⚠️ 默认 absent = **不记** —— 不问自记等于偷偷扩大授权。
   */
  remember?: boolean;
}

export interface ToolServices {
  recall?: (query: string, limit?: number) => Promise<{ content: string; score: number; createdAt: number }[]>;
  remember?: (content: string, kind?: string, scope?: string) => Promise<string>;
  /** 启动子代理（M6）；background=true 时立即返回 taskId */
  spawnSubagent?: (opts: { prompt: string; label?: string; background?: boolean })
    => Promise<{ status: "running" | "done"; taskId?: string; output?: string }>;
  /**
   * 查后台任务状态（TaskOutput 用）。
   * usage 是追加字段：provider 没报时为 undefined（**不是 0** —— 0 会被读成「没花 token」）。
   */
  getTask?: (taskId: string) => { taskId: string; label: string; status: string; result?: string; usage?: { inputTokens: number; outputTokens: number } } | undefined;
  /**
   * 列出某线程派出去的后台任务（RuntimeStatus 用）。
   * 心跳自检要回答「有没有没跑完的任务」—— 没有它就只能靠猜。
   */
  listTasks?: (threadId: string) => TaskSummary[];
  /** 把任务派到项目线程（D8：Home 只读 + 调度） */
  dispatchToProject?: (projectId: string, instruction: string) => Promise<{ output: string; endReason: string }>;
  /** 项目操作 */
  project?: ProjectOps;
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

/** 后台任务的一条摘要（形状对齐 agents/task-registry.ts 的 TaskRecord） */
export interface TaskSummary {
  id: string;
  kind: string;
  status: string;
  prompt: string;
  createdAt: number;
  finishedAt?: number;
  /** token 用量；provider 没报时 undefined（**不是 0**）——展示成「未上报」，不许写 0 */
  usage?: { inputTokens: number; outputTokens: number };
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
   * resumed  = 它已经结束了，**重挂同一个子代理、接在同一段历史上**继续做。
   *            （只有作用域缓存被淘汰 / 跨进程 / 只剩库里留档时才退回
   *              「新起一个 + 旧结论当种子」，那时 note 会明说。）
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

/**
 * 工具对文件系统的访问声明 —— 并发调度的**唯一**依据。
 *
 * 为什么需要它：原先只有一个 concurrencySafe 布尔，两个方向都错：
 * 两次互不相干的 Bash 被强行串行（慢），而标了 safe 的读与同批次的写其实会重叠（危险）。
 * 声明成「碰哪些路径 + 读还是写」之后，冲突就是可计算的：
 *   任一侧 kind === "all"，或至少一侧写且路径重叠（含 recursive 覆盖子路径）→ 冲突。
 * 没有声明 accesses 的工具一律按 "all" 处理（保守串行）。
 */
export interface ToolAccesses {
  kind: "all" | "paths";
  paths?: { path: string; operation: "read" | "search" | "write" | "readwrite"; recursive?: boolean }[];
}

/**
 * 工具暴露档位（两轴模型）。
 * 「模型看得见」与「能执行」是两件事：能力裁剪时改的是**执行**，不一定要动**可见性** ——
 * 后者一改，工具表顺序/内容变化 → provider 前缀缓存整段作废。
 *   direct              可见 + 可执行（缺省）
 *   direct_model_only   可见但不可执行（本轮被裁掉，保留 schema 以维持缓存）
 *   deferred            初始不可见，可由 ToolSearch 加载
 *   deferred_model_only 加载后仍不可执行
 *   hidden              完全不上 wire
 */
export type ToolExposure = "direct" | "direct_model_only" | "deferred" | "deferred_model_only" | "hidden";

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
  /**
   * 只读 / 可并行的**保守**声明。
   * ⚠️ 新代码不要再拿它当调度依据 —— 声明 `accesses` 才会被真正用上；
   *    没声明 accesses 的工具（含 MCP / 用户自定义）一律串行。
   * 保留该字段是为了兼容未迁移的工具与既有测试。
   */
  concurrencySafe: boolean;
  /** 声明这次调用碰哪些路径（并发调度依据）。缺省 = 独占，与所有工具冲突 */
  accesses?: (args: Record<string, unknown>, workdir: string) => ToolAccesses;
  /**
   * 审批规则的**参数模式**（会话级「同意并记住」用）。
   * 返回 undefined = 该工具不支持按参数记忆，只能整工具记（MCP / 用户工具就是这种）。
   * 例：Bash 返回 `rm *`，Write 返回 `/abs/path`。
   */
  approvalRule?: (args: Record<string, unknown>) => string | undefined;
  /** 暴露档位（两轴模型）。缺省 "direct" */
  exposure?: ToolExposure;
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
