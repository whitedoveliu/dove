/**
 * Agent 运行时：把上下文装配 / 循环 / 工具 / 记忆 / 项目 串起来。
 * 这是 server 唯一需要调用的门面。
 */
import { randomUUID } from "node:crypto";
import type { Provider, ChatMessage, ToolCallPayload } from "../providers/types.ts";
import type { Store } from "../session/store.ts";
import type { EventLog } from "../session/event-log.ts";
import type { Message, ToolPart, Thread, Part } from "../session/types.ts";
import { isToolPart } from "../session/types.ts";
import { repairMessages } from "../session/repair.ts";
import { runTurn } from "../loop/turn.ts";
import { Watchdog } from "../loop/watchdog.ts";
import { SteeringQueue } from "../loop/steering.ts";
import { buildExecDeps } from "./wire.ts";
import { applyThreadPolicy, renderPolicyNotice } from "./tool-policy.ts";
import { normalizePermissionMode } from "../tools/approval.ts";
import { runDispatch } from "./dispatch.ts";
import { SubagentTranscript, makeSubagentThreadId } from "../agents/subagent-store.ts";
import { currentActiveNames } from "../tools/registry.ts";
import { hydrateImages } from "../context/images.ts";
import { RedactStream } from "../security/redact-stream.ts";
import { toWireHistory } from "./wire-history.ts";
import type { EventSink, AgentEvent } from "./events.ts";
import type { PendingRegistry } from "./pending.ts";
import { getModelInfo } from "../providers/index.ts";
import type { Tool, ProjectOps } from "../tools/types.ts";

export interface AssembleInput {
  thread: Thread; projectId?: string | null; userText: string;
  workdir: string; outputsDir: string;
}
export interface AssembleOutput {
  systemPrompt: string; tailContext: string; memoriesBlock: string; dualSystem?: boolean;
}
export interface MemoryPort {
  retrieveForContext(query: string, projectId?: string | null): Promise<{ context: string; usedMemories: { id: string; content: string }[] }>;
  remember(content: string, kind?: string, scope?: string): Promise<string>;
  captureDaily(content: string): Promise<void>;
  /** 把一轮对话浓缩成一行日记（LLM 总结后写进 memory/YYYY-MM-DD.md） */
  captureDiary?(exchange: string): Promise<void>;
  summarizeTurn?(threadId: string, projectId: string | null, text: string): Promise<void>;
}
export interface AgentServices {
  provider: Provider;
  store: Store;
  eventLog: EventLog;
  pending: PendingRegistry;
  steering: SteeringQueue;
  tools: Map<string, Tool>;
  assemble: (input: AssembleInput) => Promise<AssembleOutput>;
  memory?: MemoryPort;
  projectOps?: (projectId: string) => ProjectOps;
  spawnSubagent?: (opts: { prompt: string; label?: string; threadId: string; projectId?: string | null }) => Promise<string>;
  /** 后台任务注册表（结果注回用） */
  tasks?: import("../agents/task-registry.ts").TaskRegistry;
  classifier?: (cmd: string) => Promise<import("../tools/types.ts").ApprovalRequest | null>;
  /** 上下文压缩钩子（由 context 模块注入）：(messages, step, lastUsage) => 压缩后的 messages */
  compact?: (messages: ChatMessage[], step: number, usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }) => Promise<ChatMessage[]>;
  /**
   * 屏幕感知（M7）。提供 screenshot OCR 历史的检索能力 ——
   * Recall 工具的「屏幕记忆」那条通道靠它，没有它就只能查长期记忆。
   */
  activity?: { searchScreen(q: string, o?: { limit?: number }): import("../tools/types.ts").ScreenHit[] };
  /**
   * 搜索 API 的 key（Tavily）。配了优先用它，没配退回抓 HTML。
   *
   * ⚠️ 一个值要穿过 5 处才到工具手上（bootstrap → 这里 → buildExecDeps
   * → wire 的 WireInput → wire 的 services）。**漏任一处都是静默失败**。
   */
  webSearchKey?: string;
}
export interface RunOptions {
  threadId: string; userText: string; projectId?: string | null; model?: string;
  signal?: AbortSignal; sink: EventSink;
}

export class AgentRuntime {
  #s: AgentServices;
  constructor(services: AgentServices) { this.#s = services; }
  get services(): AgentServices { return this.#s; }

  async run(opts: RunOptions): Promise<{ assistantMessageId: string; endReason: string; usage: import("../session/types.ts").Usage }> {
    const { store, eventLog, pending, steering } = this.#s;
    const thread = store.getThread(opts.threadId);
    if (!thread) throw new Error(`线程 ${opts.threadId} 不存在`);

    const runId = randomUUID().slice(0, 8);
    const projectId = opts.projectId ?? thread.projectId ?? null;
    // 让这一轮产生的所有事件都带上项目 id（前端日志视图按它分组）
    eventLog.setProject(projectId);
    const proj = projectId ? store.getProject(projectId) : undefined;
    const workdir = proj?.path ?? this.#s.store.listProjects()[0]?.path ?? process.cwd();

    const userMsg: Message = {
      id: `${opts.threadId}--u-${randomUUID()}`, threadId: opts.threadId, role: "user",
      parts: [{ type: "text", text: opts.userText }], createdAt: Date.now(),
    };
    store.addMessage(userMsg);
    eventLog.append("turn_start", { userText: opts.userText.slice(0, 500) }, { run: runId, turn: 1 });
    opts.sink({ type: "turn_start", turn: 1 });

    const history = store.recentMessages(opts.threadId, 60);
    const repair = repairMessages(history);
    if (repair.findings.length > 0) {
      eventLog.append("repair", { findings: repair.findings }, { run: runId });
      opts.sink({ type: "repair", findings: repair.findings });
    }

    // ── 后台任务结果注回（T6.3）
    // claimPendingInjections 会**原子地**标记为已注入 —— 这是防重复注入的唯一入口。
    let taskInjection = "";
    if (this.#s.tasks) {
      const done = this.#s.tasks.claimPendingInjections(opts.threadId);
      if (done.length > 0) {
        taskInjection = [
          "<system-reminder>",
          "你之前派出去的后台任务有结果了：",
          "",
          ...done.map((t, i) => `【${i + 1}｜${t.kind}】\n${t.result ?? "(无结果)"}`),
          "",
          "这些结果用户已经在界面上看到了。**不要原样复述**，只在需要时基于它们继续推进任务。",
          "</system-reminder>",
        ].join("\n");
        eventLog.append("task_injection", { count: done.length, ids: done.map((t) => t.id) }, { run: runId });
        opts.sink({ type: "task_injected", count: done.length });
      }
    }

    const assembled = await this.#s.assemble({
      thread, projectId, userText: opts.userText, workdir, outputsDir: workdir + "/outputs",
    });

    let memoriesBlock = assembled.memoriesBlock;
    if (this.#s.memory) {
      try {
        const r = await this.#s.memory.retrieveForContext(opts.userText, projectId);
        if (r.context) memoriesBlock = r.context;
      } catch { /* 记忆失败绝不影响对话 */ }
    }

    const wireHistory = toWireHistory(history, repair.notice, opts.threadId, getModelInfo(opts.model ?? thread.model ?? "deepseek-flash").supportsImages);
    const trimmed = dropLastUser(wireHistory);

    const controller = new AbortController();
    const signal = opts.signal ?? controller.signal;
    const wd = new Watchdog(() => controller.abort("watchdog"));
    wd.start();

    // ── 收集 assistant parts（事件 = 持久化 = UI 的同一份数据）
    const parts: Part[] = [];
    const toolIndex = new Map<string, ToolPart>();
    let textPart: { type: "text"; text: string; state?: "streaming" } | null = null;
    let reasoningPart: { type: "reasoning"; text: string; state?: "streaming" } | null = null;

    const ensureText = () => { if (!textPart) { textPart = { type: "text", text: "", state: "streaming" }; parts.push(textPart as Part); } return textPart; };
    // 回复层流式脱敏（T8.1）
    const textRedactor = new RedactStream({
      onHit: (hits) => {
        eventLog.append("redacted", { where: "assistant_text", hits }, { run: runId, step: stepNo });
        opts.sink({ type: "redacted", hits });
      },
    });
    const ensureReasoning = () => { if (!reasoningPart) { reasoningPart = { type: "reasoning", text: "", state: "streaming" }; parts.push(reasoningPart as Part); } return reasoningPart; };

    const model = opts.model ?? thread.model ?? "deepseek-flash";
    let stepNo = 0;
    let compacted = false;
    let lastUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | undefined;

    // ⚠️ 必须在 buildExecDeps **之前**声明 —— const 有 TDZ，声明写后面会直接抛。
    const permissionMode = normalizePermissionMode(
      thread.metadata?.readOnly === true ? "read-only" : thread.metadata?.permissionMode,
    );

    const execDeps = buildExecDeps({
      runtime: { services: {
        pending, memory: this.#s.memory, projectOps: this.#s.projectOps,
        spawnSubagent: this.#s.spawnSubagent, activity: this.#s.activity,
        webSearchKey: this.#s.webSearchKey,
      } },
      sink: opts.sink as (e: { type: string; [k: string]: unknown }) => void,
      threadId: opts.threadId, projectId, workdir, outputsDir: workdir + "/outputs", signal,
      // 走通用通道 —— 以后再加 ExecDeps 顶层字段不用动 wire.ts（那正是栽过三次的地方）
      // classifier 同走这条通道。⚠️ 它以前只在类型里声明、从没被转发 —— auto 因此静默全放行。
      execOverrides: { permissionMode, classifier: this.#s.classifier },
      onApprovalNeeded: (id, req) => {
        wd.pause();
        eventLog.append("tool_approval", { toolCallId: id, riskLevel: req.riskLevel, title: req.title }, { run: runId });
        const tp = toolIndex.get(id);
        if (tp) { tp.state = "approval-requested"; }
        opts.sink({ type: "tool_approval", toolCallId: id, message: req.message, title: req.title, riskLevel: req.riskLevel });
      },
    });

    // ── 线程级工具策略（D8）：Home 拿不到写类工具，是能力裁剪不是提示词请求。
    const readOnly = permissionMode === "read-only";
    const policy = applyThreadPolicy(thread.kind, this.#s.tools, { readOnly });
    const policyNotice = renderPolicyNotice(
      thread.kind, policy.blocked,
      store.listProjects().map((p) => p.id),
      policy.reason,
    );
    if (policy.blocked.length > 0) {
      eventLog.append("policy", { threadKind: thread.kind, reason: policy.reason, blocked: policy.blocked }, { run: runId });
      opts.sink({ type: "policy", reason: policy.reason, blocked: policy.blocked });
    }
    const effectiveTail = [assembled.tailContext, policyNotice, taskInjection].filter(Boolean).join("\n");

    // 子代理接进工具服务
    const services = (execDeps.ctxBase.services ?? {}) as import("../tools/types.ts").ToolServices;
    const tasks = this.#s.tasks;

    const runOneSubagent = async (
      prompt: string, label: string, bg: { background: boolean; taskId?: string },
    ): Promise<{ output: string; steps: number; endReason: string; threadId: string }> => {
      const { runSubagent } = await import("../agents/subagent.ts");
      const threadId = makeSubagentThreadId(label, bg.taskId);   // 建线程 + 过程记录（A1）
      const transcript = new SubagentTranscript({
        store, parentThreadId: opts.threadId, projectId: opts.projectId ?? thread.projectId,
        label, background: bg.background, taskId: bg.taskId, threadId,
      });
      // ⚠️ 带 subagentId（A2）—— 只有 label 时同名并发子代理会串（实测过）。
      const r = await runSubagent({
        provider: this.#s.provider, model, prompt, label,
        tools: policy.tools,
        execDeps: { ...execDeps, ctxBase: { ...execDeps.ctxBase, services: { ...services, spawnSubagent: undefined, dispatchToProject: undefined } } },
        signal,
        onText: (d) => { transcript.text(d); opts.sink({ type: "subagent_text", content: d, label, subagentId: threadId }); },
        onReasoning: (d) => { transcript.reasoning(d); opts.sink({ type: "subagent_reasoning", content: d, label, subagentId: threadId }); },
        onToolUse: (name, args) => { transcript.tool(name, args); opts.sink({ type: "subagent_tool", tool: name, args, label, subagentId: threadId }); },
      });
      transcript.finish(r.endReason === "error" ? "error" : "done", r.endReason);
      return { ...r, threadId };
    };

    services.spawnSubagent = async ({ prompt, label, background }) => {
      const name = label ?? "子任务";
      if (!background || !tasks) {
        const r = await runOneSubagent(prompt, name, { background: false });
        opts.sink({ type: "subagent_done", label: name, subagentId: r.threadId, steps: r.steps, endReason: r.endReason });
        return { status: "done" as const, output: r.output };
      }
      // 后台：立刻返回 taskId，跑完写进 TaskRegistry（回合边界自动注回）
      const rec = tasks.create({ threadId: opts.threadId, prompt, kind: name });
      opts.sink({ type: "task_start", taskId: rec.id, label: name });
      void runOneSubagent(prompt, name, { background: true, taskId: rec.id }).then((r) => {
        tasks.finish(rec.id, r.output);
        opts.sink({ type: "task_done", taskId: rec.id, label: name, subagentId: r.threadId, steps: r.steps });
      }).catch((e) => {
        tasks.finish(rec.id, "子代理执行失败：" + (e instanceof Error ? e.message : String(e)), "error");
      });
      return { status: "running" as const, taskId: rec.id };
    };

    services.getTask = (taskId: string) => {
      const t = tasks?.get(taskId);
      if (!t) return undefined;
      return { taskId: t.id, label: t.kind, status: t.status, result: t.result };
    };

    // Home → 项目线程的调度（D8）：在项目线程里完整跑一轮，只把结论带回 Home
    services.dispatchToProject = (projectId, instruction) =>
      runDispatch((o) => this.run(o), { store, projectId, instruction, signal, sink: opts.sink as never });

    let result: Awaited<ReturnType<typeof runTurn>>;
    try {
      result = await runTurn({
        provider: this.#s.provider, model,
        systemPrompt: assembled.systemPrompt, dualSystem: assembled.dualSystem,
        history: trimmed, userText: opts.userText,
        tailContext: effectiveTail, memoriesBlock,
        tools: policy.tools,
        activeToolNames: () => currentActiveNames(),   // 按需工具开关（函数：中途激活要立刻生效）
        execDeps,
        steerPending: () => steering.pending(opts.threadId),
        drainSteering: () => steering.drain(opts.threadId),
        signal,
        onBeforeStep: async (st) => {
          stepNo = st.step; wd.touch();
          opts.sink({ type: "step_start", step: st.step });
          eventLog.append("step_start", { step: st.step }, { run: runId, turn: 1, step: st.step });
          // AutoCompact：在 step 之间检查
          if (this.#s.compact && st.step > 1 && st.messages.length > 20) {
            try {
              const next = await this.#s.compact(st.messages, st.step, lastUsage);
              if (next && next.length < st.messages.length) {
                compacted = true;
                eventLog.append("compaction", { from: st.messages.length, to: next.length }, { run: runId, step: st.step });
                opts.sink({ type: "compaction", from: st.messages.length, to: next.length });
                return { messages: next, compacted: true };
              }
            } catch { /* 压缩失败不影响主流程 */ }
          }
        },
        hooks: {
          onUsage: (u) => { lastUsage = u; },
          onText: (delta) => {
            // T8.1：回复层再脱敏一次 —— 密钥/凭据绝不推到界面或落进日志。
            // 逐 token 推流意味着必须用流式脱敏器（见 security/redact-stream.ts）。
            const safe = textRedactor.push(delta);
            if (safe.length === 0) return;
            const p = ensureText(); p.text += safe;
            eventLog.append("assistant_text", { delta: safe.slice(0, 400) }, { run: runId, step: stepNo });
            opts.sink({ type: "text", content: safe });
          },
          onReasoning: (delta, full) => {
            const p = ensureReasoning(); p.text = full;
            opts.sink({ type: "reasoning", content: delta });
          },
          onToolStart: (call: ToolCallPayload) => {
            wd.touch();
            const tp: ToolPart = {
              type: `tool-${call.function.name}`, toolCallId: call.id, toolName: call.function.name,
              state: "input-available", input: safeParse(call.function.arguments), startedAt: Date.now(),
            };
            toolIndex.set(call.id, tp); parts.push(tp);
            eventLog.append("tool_call", { tool: tp.toolName, toolCallId: call.id, input: tp.input }, { run: runId, step: stepNo });
            opts.sink({ type: "tool_start", tool: tp.toolName, toolCallId: call.id, input: tp.input });
          },
          onToolResult: (o) => {
            wd.touch();
            const tp = toolIndex.get(o.toolCallId);
            if (tp) {
              tp.state = o.ok ? (o.denied ? "permission-denied" : "output-available") : "output-error";
              tp.output = o.output;
              tp.errorText = o.errorText;
              tp.spillPath = o.spillPath;
              tp.finishedAt = Date.now();
            }
            eventLog.append("tool_result", {
              tool: o.toolName, toolCallId: o.toolCallId, ok: o.ok,
              preview: JSON.stringify(o.output ?? o.errorText ?? "").slice(0, 800), spillPath: o.spillPath,
            }, { run: runId, step: stepNo });
            opts.sink({ type: "tool_result", tool: o.toolName, toolCallId: o.toolCallId, ok: o.ok, result: o.output, error: o.errorText, spillPath: o.spillPath, durationMs: o.durationMs });
          },
        },
      });
    } finally { wd.stop(); }

    // 把脱敏器扣住的尾巴放出来（否则最后一段会丢）
    //
    // ⚠️ 这里也必须写事件日志。之前漏了，后果是：
    //    脱敏器有 256 字符回看窗口，**短回复整段都扣在窗口里**，
    //    只在 flush 时吐出 —— 于是「模型说过的话」几乎从来没进过日志。
    //    实测 1092 轮对话只留下 2 条 assistant_text，日志视图里 AI 全是空的。
    const tailText = textRedactor.flush();
    if (tailText.length > 0) {
      const p = ensureText(); p.text += tailText;
      eventLog.append("assistant_text", { delta: tailText.slice(0, 400) }, { run: runId, step: stepNo });
      opts.sink({ type: "text", content: tailText });
    }

    for (const p of parts) if (!isToolPart(p)) p.state = "output-available";

    const assistantMsg: Message = {
      id: `${opts.threadId}--a-${randomUUID()}`, threadId: opts.threadId, role: "assistant",
      parts: parts.length > 0 ? parts : [{ type: "text", text: "(无输出)", state: "output-available" }],
      createdAt: Date.now(), usage: result.usage,
    };
    store.addMessage(assistantMsg);

    eventLog.append("turn_end", {
      endReason: result.endReason, steps: result.steps, gates: result.gates,
      usage: result.usage, aborted: result.aborted, compacted,
    }, { run: runId, turn: result.gates.length + 1 });

    opts.sink({ type: "stats", usage: result.usage, durationMs: wd.elapsedMs, steps: result.steps, gates: result.gates, model, compacted });

    // 回合结束的记忆写入（异步，不阻塞）
    if (this.#s.memory?.summarizeTurn) {
      const text = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      this.#s.memory.summarizeTurn(opts.threadId, projectId, `用户：${opts.userText}\n\nDove：${text}`).catch(() => { /* ignore */ });
    }

    // 日记（系统提示词 S11 槽位）：每轮 LLM 浓缩一行。之前 captureDaily 从没被调用过。
    if (this.#s.memory?.captureDiary) {
      const text = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      if (text.trim()) {
        this.#s.memory.captureDiary(`用户：${opts.userText}\n\nDove：${text}`).catch(() => { /* ignore */ });
      }
    }

    return { assistantMessageId: assistantMsg.id, endReason: result.endReason, usage: result.usage };
  }
}

/** 宽松 JSON 解析：工具参数不是合法 JSON 时原样返回，交给 repairToolCall 处理 */
function safeParse(s: string): unknown {
  try { return JSON.parse(s || "{}"); } catch { return s; }
}

/** 去掉最后一条 user（runTurn 会重新加上本次消息） */
function dropLastUser(msgs: ChatMessage[]): ChatMessage[] {
  const out = [...msgs];
  for (let i = out.length - 1; i >= 0; i--) if (out[i]!.role === "user") { out.splice(i, 1); break; }
  return out;
}

