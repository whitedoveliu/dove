/**
 * smoke-loop-audit 的共用脚手架：脚本化 provider + 一批绑定到本次 bootstrap 的助手。
 *
 * 为什么单独一个文件：那份审计要逐条覆盖 19 条约束，光把脚手架摆齐就顶到 400 行硬约束
 * （tools/lint-file-size.mjs 对 scripts/ 一样生效）。这里只放**与断言无关**的东西 ——
 * 假 provider、事件收集、审批代答；每条约束的用例与断言都留在 smoke-loop-audit.ts 里，
 * 要读「测了什么」不需要看这个文件。
 */
import { join } from "node:path";
import type { Services } from "../packages/server/src/bootstrap.ts";
import { AgentRuntime } from "../packages/core/src/agent/runtime.ts";
import type { ExecDeps } from "../packages/core/src/loop/tool-exec.ts";
import type { Tool, ToolServices } from "../packages/core/src/tools/types.ts";
import type {
  ChatMessage, Provider, StreamOptions, StreamResult, ToolCallPayload,
} from "../packages/core/src/providers/types.ts";

export type Step = (n: number, opts: StreamOptions) => StreamResult;
export interface CallLog { role: "parent" | "child"; wire: string[]; messages: ChatMessage[] }
export interface Ev { type: string; [k: string]: unknown }

export function res(text: string, toolCalls: ToolCallPayload[] = []): StreamResult {
  return {
    text, reasoning: "", toolCalls,
    usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}
/** 错误流：真 provider 的 HTTP 非 2xx 走这条（不是抛异常） */
export function errRes(message: string): StreamResult { return { ...res(""), finishReason: "error", error: message }; }
export function call(name: string, args: Record<string, unknown>): ToolCallPayload {
  return { id: `c_${name}_${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
/** 上一条工具结果 —— 脚本要「看见」模型实际收到什么时才用 */
export function lastToolContent(opts: StreamOptions): string {
  for (let i = opts.messages.length - 1; i >= 0; i--) if (opts.messages[i]!.role === "tool") return String(opts.messages[i]!.content ?? "");
  return "";
}
/** 发给 provider 的消息里有没有出现某段文本（验「模型真的被告知了」） */
export function sawInRequest(opts: StreamOptions, needle: RegExp): boolean {
  return opts.messages.some((m) => needle.test(typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}
export function makeProvider(scripts: { parent?: Step[]; child?: Step[] }): { provider: Provider; log: CallLog[] } {
  const log: CallLog[] = [];
  const n = { parent: 0, child: 0 };
  return {
    log,
    provider: {
      id: "audit-stub",
      stream: async (opts: StreamOptions): Promise<StreamResult> => {
        const system = String(opts.messages.find((m) => m.role === "system")?.content ?? "");
        // 子代理的系统提示词是 agents/subagent.ts 的 DEFAULT_SYSTEM —— 靠它区分两条路径
        const role: "parent" | "child" = system.includes("通用子代理") ? "child" : "parent";
        const i = n[role]++;
        log.push({ role, wire: (opts.tools ?? []).map((t) => t.function.name), messages: opts.messages });
        const list = scripts[role] ?? [];
        const step = list[Math.min(i, list.length - 1)];
        if (!step) throw new Error("脚本 provider 没给 " + role + " 配脚本（第 " + (i + 1) + " 次调用）");
        const r = step(i, opts);
        // 逐块回调对齐真 provider：不回调的话 parts 里不会有文本，运行时会（正确地）把这一轮
        // 判成「用户什么都没看到」—— 断言就测错了对象。
        if (r.text) opts.onTextDelta?.(r.text);
        return r;
      },
    },
  };
}
export function collector(onEvent?: (e: Ev) => void): { ev: (t: string) => Ev[]; sink: (e: Ev) => void } {
  const events: Ev[] = [];
  return { ev: (t) => events.filter((e) => e.type === t), sink: (e) => { events.push(e); onEvent?.(e); } };
}

export type TurnResult = {
  p: { provider: Provider; log: CallLog[] };
  c: ReturnType<typeof collector>;
  r: Awaited<ReturnType<AgentRuntime["run"]>>;
  th: string;
};

/** 脚本化 provider 之外的一切都是生产代码：真 store / 事件日志 / 审批注册表 / 子代理宿主 */
export function makeAuditEnv(svc: Services, proj: { path: string }) {
  const base = svc.runtime.services;
  /** 只换 provider、去掉会打真网络的 memory / classifier（它们的开关不在这张清单上） */
  const runtimeWith = (provider: Provider): AgentRuntime =>
    new AgentRuntime({ ...base, provider, memory: undefined, classifier: undefined });
  let seq = 0;
  const newThread = (): string => {
    const id = `th_audit_${++seq}`;
    svc.store.createThread({ id, kind: "project", projectId: proj.id ?? undefined, title: "审计 " + seq });
    return id;
  };
  /**
   * 跑一轮**真实**回合。大多数用例只要「provider 调用日志 + 事件 + run 的返回值」这三样，
   * 每个用例自己摆一遍会把脚本撑爆 400 行。
   */
  const turn = async (
    parent: Step[], userText: string,
    o: { child?: Step[]; signal?: AbortSignal; onEvent?: (e: Ev) => void } = {},
  ): Promise<TurnResult> => {
    const p = makeProvider({ parent, ...(o.child ? { child: o.child } : {}) });
    const c = collector(o.onEvent);
    const th = newThread();
    const r = await runtimeWith(p.provider).run({ threadId: th, userText, signal: o.signal, sink: c.sink });
    return { p, c, r, th };
  };
  /** 面板侧的回答：审批是「先发事件、再注册等待」，所以必须延到下一个宏任务才答得上 */
  const answerLater = (id: string, approved: boolean): void => {
    const t = setInterval(() => { if (svc.pending.resolveApproval(id, approved)) clearInterval(t); }, 5);
    setTimeout(() => clearInterval(t), 3000).unref?.();
  };
  const minimalExecDeps = (tools: Map<string, Tool>, approvals: { title: string }[] = [], approve = false): ExecDeps => ({
    tools,
    ctxBase: {
      threadId: "th_audit_exec", workdir: proj.path, outputsDir: join(proj.path, "outputs"),
      emit: () => { /* 审计不关心工具内部事件 */ }, services: {} as ToolServices,
    },
    resolveApproval: async (req) => {
      approvals.push({ title: req.title });
      return approve ? { approved: true, decision: "allow" } : { approved: false, decision: "deny" };
    },
  });
  const logCount = (type: string): number => svc.eventLog.readAll().filter((l) => l.type === type).length;
  const lastAssistantText = (th: string): string => {
    const msgs = svc.store.listMessages(th).filter((m) => m.role === "assistant");
    const last = msgs[msgs.length - 1];
    return last ? last.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("") : "";
  };
  return { base, runtimeWith, newThread, turn, answerLater, minimalExecDeps, logCount, lastAssistantText };
}
