/**
 * 计划模式（B5）解析 —— 纯函数，不依赖 React / DOM，方便单独验证。
 *
 * 内核侧：计划模式是**线程级**状态（thread metadata 的 planMode 字段）。模型调研完会调用
 * ExitPlanMode 工具把完整计划交上来（入参是 { plan: "<markdown>" }），用户批准后内核
 * 把 planMode 置回 false（面板侧的开关见 lib/permission.ts 的 usePlanMode）。
 *
 * 数据来源和交付物卡片（presented-files.ts）**完全一致**：只用消息里已有的 tool 事件，
 * 不新增任何 SSE 事件类型 —— 实时流和刷新后的历史回放走同一条解析路径。
 *
 *   实时流（sse-compat）：tool_start{tool} → tool_info{info}（**没有 tool 字段**）
 *                        → tool_params{tool, params} → tool_result{tool, result}
 *   历史回放：只发 tool_info{tool, info}，而且 info 被截到 300 字符
 *            —— 所以刷新后卡片正文会短很多，这是已知降级（有总比没有强）。
 */
import { normalizeToolName } from "@/lib/presented-files";

/** 计划文本从哪来：params = 实时流的完整入参；info = 摘要 / 历史回放（会被截断） */
export type SubmittedPlanSource = "params" | "info";

export interface SubmittedPlan {
  /** 计划的 markdown 正文（source === "info" 时可能被截断） */
  plan: string;
  source: SubmittedPlanSource;
}

/** 解析只需要这几个字段 —— 结构化声明，便于单测直接喂假事件 */
export interface PlanEventLike {
  type?: string;
  tool?: string;
  /** tool_info 的文本（ExitPlanMode 时就是计划本身） */
  info?: string;
  /** tool_params 的完整入参 */
  params?: Record<string, unknown>;
  /** 少数路径把入参塞在 tool_start 上 */
  input?: Record<string, unknown>;
}

/** 是不是 ExitPlanMode（大小写 / 下划线 / 连字符都不敏感：ExitPlanMode / exit_plan_mode 都认） */
export function isExitPlanModeTool(tool?: string | null): boolean {
  return normalizeToolName(tool) === "exitplanmode";
}

/** 只收非空字符串；其余（数字、对象、空白串）一律当没有 */
function readPlanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

/** 从 params / input 里取 plan 字段（两种形状都认） */
function readPlanFromParams(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  try {
    return readPlanText((params as Record<string, unknown>).plan);
  } catch {
    return null;
  }
}

/**
 * 从一条消息的 events 里抽出**最后一次** ExitPlanMode 提交的计划。
 *
 * 为什么是「最后一次」：同一个回合里模型可能先交一版、被拒后按反馈修订再交一版
 * （两次调用都在同一条 assistant 消息里）。用户要执行的是最后批准的那一版。
 *
 * 认得的形状（按优先级）：
 *   1. tool_params{tool:"ExitPlanMode", params:{plan}}   ← 主路径（实时流，全文）
 *   2. tool_start{tool:"ExitPlanMode", params/input 上带 plan}
 *   3. tool_info{info}                                   ← 实时摘要 / 历史回放（截断到 300 字符）
 *
 * 任何一步都不抛错：脏数据 / 不认识的形状 = 跳过，一条都解析不出来就返回 null。
 */
export function extractSubmittedPlan(
  events: readonly PlanEventLike[] | null | undefined
): SubmittedPlan | null {
  if (!events || typeof events.length !== "number" || events.length === 0) return null;

  /** 当前这次 ExitPlanMode 调用收集到的文本（params 优先于 info） */
  let current: { params: string | null; info: string | null } | null = null;
  /** 供不带 tool 字段的事件归属（实时流的 tool_info 就没有 tool） */
  let currentTool: string | undefined;
  let found: SubmittedPlan | null = null;

  const flush = () => {
    if (!current) return;
    if (current.params) found = { plan: current.params, source: "params" };
    else if (current.info) found = { plan: current.info, source: "info" };
    current = null;
  };

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as PlanEventLike;
    const type = String(event.type ?? "");
    if (event.tool) currentTool = event.tool;
    try {
      // 新的工具调用开始 → 上一次 ExitPlanMode（没等到 result）就此结束
      if (type === "tool_start") {
        flush();
        if (isExitPlanModeTool(event.tool ?? currentTool)) {
          // 实时流的 tool_start 不带参数，但少数路径会把入参塞在 params / input 上 —— 一并认
          current = { params: readPlanFromParams(event.params ?? event.input), info: null };
        }
        continue;
      }

      if (!isExitPlanModeTool(event.tool ?? currentTool)) continue;

      if (type === "tool_params") {
        // 历史回放里没有 tool_start，孤立出现的 tool_params 也要能开一条
        if (!current) current = { params: null, info: null };
        current.params = readPlanFromParams(event.params);
      } else if (type === "tool_info") {
        if (!current) current = { params: null, info: null };
        current.info = readPlanText(event.info);
      } else if (type === "tool_result") {
        flush();
      }
    } catch {
      /* 单条脏事件不影响整条解析 */
    }
  }
  flush();
  return found;
}

/** 计划的第一行标题（去掉 markdown 的 # 和空白）；取不到就给个兜底 */
export function planTitle(plan: string, fallback = "计划"): string {
  for (const line of String(plan ?? "").split("\n")) {
    const text = line.replace(/^\s*#{1,6}\s*/, "").trim();
    if (text) return text.length > 80 ? text.slice(0, 80) + "…" : text;
  }
  return fallback;
}
