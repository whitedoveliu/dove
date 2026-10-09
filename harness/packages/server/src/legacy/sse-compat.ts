/**
 * SSE 事件翻译层：新内核的事件 → control-panel 认识的**老词表**。
 *
 * 为什么要有这一层：control-panel 是已经调好的界面（用户明确要求不要动它），
 * 它消费的是老 Python 后端那套事件。内核换了，但**契约不能换** ——
 * 换契约就得改界面，改界面就是"UI 变了"。
 *
 * 老词表的权威来源是 python/agent_core.py 的 yield 语句（逐字对齐）。
 */
import type { AgentEvent } from "../agent/events.ts";

/** 老契约里前端会读的事件 */
export type LegacyEvent =
  | { type: "session_id"; content: string }
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_start"; tool: string }
  | { type: "tool_info"; info: string }
  /** 子代理/后台任务的状态与流式内容（前端顶部状态栏用） */
  | { type: "subagent"; action: "start" | "text" | "reasoning" | "tool" | "done" | "injected";
      /** 子代理线程 id —— 前端按它归户、也按它去拉历史 */
      subagentId?: string;
      label?: string; taskId?: string; content?: string; steps?: number;
      endReason?: string; background?: boolean; tool?: string; info?: string }
  | { type: "tool_params"; tool: string; params: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: string }
  | { type: "todo_update"; todos: unknown[]; merge?: boolean }
  | { type: "stats"; rounds: number; is_modified: boolean; model_escalated: boolean; usage: LegacyUsage }
  | { type: "log"; content: string }
  | { type: "build_start" }
  | { type: "build_error"; error: string }
  | { type: "preview_ready" }
  | { type: "commit"; commit_hash: string }
  | { type: "interrupted" }
  | { type: "locked" }
  | { type: "error"; message: string }
  | { type: "ask_user"; tool_use_id: string; question: string; suggestions?: string[] }
  | { type: "done" };

export interface LegacyUsage {
  total_cost_usd: number;
  pricing_complete: boolean;
  breakdown: {
    model: string; raw_model: string; display: string; provider: string;
    input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number;
  }[];
}

/** 从工具入参里挑出人类看得懂的一行摘要（老契约的 tool_info 就是干这个的） */
export function toolInfoLine(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const parts: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v.trim()) parts.push(v); };
  if (Array.isArray(input.file_paths)) for (const p of input.file_paths) push(p);
  push(input.file_path);
  push(input.path);
  push(input.query);
  // ⚠️ url 一定要有 —— 漏了它 WebFetch 那一行的说明**永远是空的**，
  //    界面上只剩「WebFetch」四个字母，看不出在抓哪个页面。实测踩过。
  push(input.url);
  push(input.command);
  if (typeof input.old_path === "string" && typeof input.new_path === "string") {
    parts.push(`${input.old_path} -> ${input.new_path}`);
  }
  // ⚠️ Task（派子代理）的参数是 { prompt, label } —— 上面一个都不匹配，
  //    于是界面上「工具调用 Task」后面**永远是空的**，看不出它让子代理去干什么。
  //    实测踩过：用户问「为什么看不到 task 的 info / 产出的 prompt」。
  //    放在 description 兜底之前，这样 label 能当标题、prompt 能当正文。
  if (parts.length === 0) {
    const label = typeof input.label === "string" ? input.label.trim() : "";
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (label) parts.push(label);
    if (prompt) parts.push(prompt);
  }
  if (parts.length === 0 && typeof input.description === "string") push(input.description);
  return parts.join("\n").slice(0, 300);
}

/** 工具结果转字符串（老契约要字符串，超长截到 500 —— 和 Python 版一致） */
export function resultToString(result: unknown, limit = 500): string {
  let s: string;
  if (typeof result === "string") s = result;
  else {
    try { s = JSON.stringify(result); } catch { s = String(result); }
  }
  return s.length > limit ? s.slice(0, limit) + "..." : s;
}

/** 只有这些工具算"改了代码"（Python 版就是这几个） */
export const MODIFYING_TOOLS = new Set([
  "Write", "Edit", "Delete", "new_file", "edit_file", "delete_file", "rename_file",
  "quick_edit_page", "str_replace_based_edit_tool",
]);

/**
 * 事件映射的跨事件状态。
 *
 * toolBurst 用来做**工具调用批处理** —— 见下面 tool_start 分支的长注释。
 * 调用方必须**每个 run 建一个**并贯穿整个事件流传进来（不能每次新建）。
 */
export interface LegacyCtx {
  hasBuilt: boolean;
  /** 当前是否处在「一串连续工具调用」中间 */
  toolBurst?: boolean;
}

/** 把新内核的事件映射成 0..n 个老事件 */
export function toLegacy(e: AgentEvent, ctx: LegacyCtx): LegacyEvent[] {
  switch (e.type) {
    case "text":
      // 开始说话了 → 这一串工具调用结束
      ctx.toolBurst = false;
      return [{ type: "text", content: String(e.content ?? "") }];

    case "reasoning":
      // 开始思考 → 同样结束这一串
      ctx.toolBurst = false;
      return [{ type: "thinking", content: String(e.content ?? "") }];

    case "tool_start": {
      const tool = String(e.tool ?? "");
      const params = (e.input ?? {}) as Record<string, unknown>;

      // 老契约的 tool_params 带完整入参 —— **每个工具都要发**，
      // 前端拿它做「继续生成」和文件树派生，漏了会出问题。
      const paramsEvent: LegacyEvent = { type: "tool_params", tool, params };

      // ── 这里**故意不做批处理** ──────────────────────
      // 曾经在数据层把连续的工具合成一条（只发第一个 tool_start）。
      // 已撤销：**数据层应该发全，展示交给视图层** ——
      // 用户要的是「折叠 + 能点开看每个工具在干什么」，
      // 数据层一旦把后面的工具吞掉，前端再想展开也没料了。
      // 现在由 MessageList.tsx 把连续的工具行渲染成一个可展开的 details。
      const out: LegacyEvent[] = [{ type: "tool_start", tool }];
      const info = toolInfoLine(params);
      if (info) out.push({ type: "tool_info", info });
      out.push(paramsEvent);
      return out;
    }

    case "tool_result": {
      const tool = String(e.tool ?? "");
      const body = e.ok ? e.result : (e.error ?? "执行失败");
      return [{ type: "tool_result", tool, result: resultToString(body) }];
    }

    case "todo_update":
      return [{ type: "todo_update", todos: (e.todos ?? []) as unknown[], merge: e.merge === true }];

    case "ask_user":
      return [{
        type: "ask_user",
        tool_use_id: String(e.toolCallId ?? ""),
        question: String(e.question ?? ""),
        suggestions: Array.isArray(e.suggestions) ? (e.suggestions as string[]) : undefined,
      }];

    // ── 工具审批 ────────────────────────────────────────
    // ⚠️ 这个分支以前**根本没有** —— 内核发 tool_approval，兼容层直接丢掉，
    //    前端就永远看不到确认框，于是**任何需要审批的工具都只能等超时被自动拒绝**。
    //    实测表现：用户看到「Bash 失败：[权限] 审批超时，命令已被自动拒绝」，
    //    而他压根没被问过。
    //
    // 复用前端已有的 ask_user 界面（带「允许 / 拒绝」两个按钮），
    // 回传走 /api/user-input，那边再按 toolCallId 解析成审批决定。
    case "tool_approval":
      return [{
        type: "ask_user",
        tool_use_id: String(e.toolCallId ?? ""),
        question: [
          String(e.title ?? "需要你的许可"),
          e.message ? String(e.message).slice(0, 600) : "",
          e.riskLevel ? `（风险等级：${e.riskLevel}）` : "",
        ].filter(Boolean).join("\n\n"),
        suggestions: ["允许", "拒绝"],
      }];

    case "compaction":
      return [{ type: "log", content: `🗜 上下文压缩：${e.from} → ${e.to} 条` }];

    case "repair":
      return [{ type: "log", content: "⚠️ 检测到上次中断，已核对未完成的动作" }];

    case "redacted":
      return [{ type: "log", content: "🔒 回复中的敏感信息已脱敏" }];

    case "policy":
      return [{ type: "log", content: "🔒 本轮为只读模式，写入类工具已禁用" }];

    // ── 子代理 / 后台任务 ────────────────────────────────
    // 原来是压成一句「🧩 后台任务状态更新」—— **信息全丢**，
    // 用户既看不到有几个子代理在跑，也看不到它们干了什么。
    // 现在原样转发给前端，由 ChatPanel 的顶部状态栏呈现。
    // ⚠️ 一律带 subagentId —— 前端靠它把内容归到正确的子代理。
    //    只有 label 时，两个同名的并发子代理会串到一起（实测过）。
    case "subagent_text":
      return [{ type: "subagent", action: "text", content: String(e.content ?? ""), label: String(e.label ?? ""), subagentId: String(e.subagentId ?? "") }];

    // 子代理的思考过程与工具调用 —— 实时流到界面（带边界框里自动滚动）
    case "subagent_reasoning":
      return [{ type: "subagent", action: "reasoning", content: String(e.content ?? ""), label: String(e.label ?? ""), subagentId: String(e.subagentId ?? "") }];

    case "subagent_tool": {
      // 复用 toolInfoLine 抽参数摘要：Task 的 prompt/label、Bash 的 command 等
      const args = (e.args ?? {}) as Record<string, unknown>;
      return [{
        type: "subagent", action: "tool",
        tool: String(e.tool ?? ""),
        info: toolInfoLine(args),
        label: String(e.label ?? ""),
        subagentId: String(e.subagentId ?? ""),
      }];
    }

    case "subagent_done":
      return [{
        type: "subagent", action: "done",
        label: String(e.label ?? "子任务"),
        steps: Number(e.steps ?? 0),
        endReason: String(e.endReason ?? "stop"),
        subagentId: String(e.subagentId ?? ""),
      }];

    case "task_start":
      return [{
        type: "subagent", action: "start",
        taskId: String(e.taskId ?? ""),
        label: String(e.label ?? "子任务"),
        background: true,
      }];

    case "task_done":
      return [{
        type: "subagent", action: "done",
        taskId: String(e.taskId ?? ""),
        label: String(e.label ?? "子任务"),
        steps: Number(e.steps ?? 0),
        background: true,
      }];

    case "task_injected":
      return [{ type: "subagent", action: "injected", content: "后台任务结果已注回" }];

    case "stats": {
      // 一轮结束 → 关闭工具批次
      ctx.toolBurst = false;
      const u = (e.usage ?? {}) as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
      const model = String(e.model ?? "deepseek-flash");
      return [{
        type: "stats",
        rounds: Number(e.steps ?? 0),
        is_modified: ctx.hasBuilt,
        model_escalated: false,
        usage: {
          total_cost_usd: estimateCost(u, model),
          pricing_complete: true,
          breakdown: [{
            model, raw_model: model, display: model, provider: "deepseek",
            input_tokens: u.inputTokens ?? 0,
            output_tokens: u.outputTokens ?? 0,
            cache_read_tokens: u.cacheReadTokens ?? 0,
            cache_creation_tokens: 0,
          }],
        },
      }];
    }

    case "error":
      return [{ type: "error", message: String(e.content ?? "未知错误") }];

    // ── 工具自己发的事件（ctx.emit → sink），老的 tool_info / todo_update 走这里 ──
    case "tool:todos": {
      const todos = Array.isArray(e.todos) ? (e.todos as unknown[]) : [];
      return [{ type: "todo_update", todos, merge: e.merge !== false }];
    }

    case "tool:ask_user": {
      const qs = Array.isArray(e.questions) ? (e.questions as { id?: string; question?: string; header?: string; options?: { label?: string }[] }[]) : [];
      const first = qs[0];
      if (!first) return [];
      return [{
        type: "ask_user",
        tool_use_id: String(e.toolCallId ?? ""),
        question: String(first.question ?? first.header ?? ""),
        suggestions: Array.isArray(first.options) ? first.options.map((o) => String(o.label ?? "")).filter(Boolean) : undefined,
      }];
    }

    case "tool:build": {
      // 内核的 ProjectBuild 工具跑完了 —— 老契约用 build_start / preview_ready / build_error 表达
      if (e.ok === true) return [{ type: "preview_ready" }];
      return [{ type: "build_error", error: String(e.error ?? "构建失败") }];
    }

    case "tool:preview":
      return [{ type: "preview_ready" }];

    case "tool:file-edited":
      return [{ type: "log", content: `✏️ ${e.path ?? "文件"}（${e.replacements ?? 0} 处）` }];

    case "tool:attempt-completion":
      return [];

    default:
      return [];
  }
}

/** 生成会话 id 事件（老契约的第一条永远是它） */
export function sessionIdEvent(threadId: string): LegacyEvent {
  return { type: "session_id", content: threadId };
}

/** 粗略成本估算（DeepSeek 定价，元 → 美元） */
export function estimateCost(u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }, _model: string): number {
  const inTok = u.inputTokens ?? 0, outTok = u.outputTokens ?? 0, cacheTok = u.cacheReadTokens ?? 0;
  // 参考价：输入 ¥1/M、缓存命中 ¥0.1/M、输出 ¥2/M（量级正确即可，前端只做展示）
  const cny = (inTok / 1e6) * 1 + (cacheTok / 1e6) * 0.1 + (outTok / 1e6) * 2;
  return Math.round((cny / 7.1) * 1e6) / 1e6;
}
