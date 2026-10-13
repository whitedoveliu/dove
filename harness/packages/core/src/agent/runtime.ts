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
import { applyThreadPolicy, renderPolicyNotice, executionBlockedReason, exposureModeFromEnv } from "./tool-policy.ts";
import { PLAN_MODE_NOTICE, planAwareMode } from "./plan-mode.ts";
import { normalizePermissionMode } from "../tools/approval.ts";
import { approvalTimeoutMs } from "../constants.ts";
import { runDispatch } from "./dispatch.ts";
import { SubagentTranscript, makeSubagentThreadId } from "../agents/subagent-store.ts";
import { renderTaskInjection } from "../agents/task-registry.ts";
import { currentActiveNames } from "../tools/registry.ts";
import { hydrateImages } from "../context/images.ts";
import { attachRunServices } from "./run-services.ts";
import { TextCollector } from "./text-collector.ts";
import { dropLastUser, attachTail } from "./wire-history.ts";
import { assembleWireHistory, persistCompactedHistory } from "./history-assembly.ts";
import { makeRunLog } from "./run-log.ts";
import { persistTurnEnd } from "./run-memory.ts";
import { beginTurnDiff, takeTurnDiff } from "../tools/turn-diff.ts";
import type { Journal } from "../session/journal.ts";
import type { HookRegistry } from "../loop/hooks.ts";
import { injectTurnMode, type TurnMode } from "./mode-injection.ts";
import { hasVisibleOutcome, noOutputNote } from "./turn-outcome.ts";
import type { EventSink, AgentEvent } from "./events.ts";
import type { PendingRegistry } from "./pending.ts";
import { getModelInfo } from "../providers/index.ts";
import type { Tool, ProjectOps } from "../tools/types.ts";

// 入参/出参/依赖的形状搬到了 runtime-ports.ts（本文件贴着 400 行上限）；这里转出以兼容既有 import
import type { AssembleInput, AssembleOutput, MemoryPort } from "./runtime-ports.ts";
export type { AssembleInput, AssembleOutput, MemoryPort } from "./runtime-ports.ts";

export interface AgentServices {
  provider: Provider;
  store: Store;
  eventLog: EventLog;
  /** 每线程可重放日志（session/journal.ts）；给了就与 eventLog **双写**（见 agent/run-log.ts）。不给只是没有恢复指针 */
  journalFor?: (threadId: string) => Journal;
  /**
   * 循环 hook 注册表（loop/hooks.ts）。**一处构造、跨轮存活** —— 每轮新建的话
   * 钩子就白注册了。不给 = 一条监听者都没有（循环里每个 fire 都退化成 await undefined）。
   */
  hooks?: HookRegistry;
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
  /** 上下文压缩钩子（由 context 模块注入）：(messages, step, lastUsage, ctx) => 压缩后的 messages */
  compact?: (messages: ChatMessage[], step: number, usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }, ctx?: { threadId?: string }) => Promise<ChatMessage[]>;
  /**
   * 搜索 API 的 key（Tavily）。配了优先用它，没配退回抓 HTML。
   *
   * ⚠️ 一个值要穿过 5 处才到工具手上（bootstrap → 这里 → buildExecDeps
   * → wire 的 WireInput → wire 的 services）。**漏任一处都是静默失败**。
   */
  webSearchKey?: string;
  /**
   * MCP 资源能力（ListMcpResources / ReadMcpResource）。
   * bootstrap 用真实的 McpManager 实现（server/mcp-wiring.ts 的 makeMcpResourcePort）。
   */
  mcp?: import("../tools/types.ts").McpResourcePort;
  /**
   * 定时任务端口（CronCreate / CronList / CronDelete）。
   * ⚠️ bootstrap 里 cron 是在 runtime **之后**创建的（它自己要用 runtime.run），
   *    所以那一处是事后补的：runtime.services.cron = makeCronOps(cron)。
   *    buildExecDeps 每轮才读这个字段，来得及。
   */
  cron?: import("../tools/types.ts").CronOps;
  goals?: import("../tools/types.ts").GoalPort;   // 长期目标：工具与面板 /goal 共用一张表
  // 计划批准后放行；实现只能放 server 层（核心层不能 import server），这里只声明形状
  exitPlanMode?: (threadId: string, plan: string) => Promise<{ ok: boolean; error?: string }>;
}
export interface RunOptions {
  threadId: string; userText: string; projectId?: string | null; model?: string;
  signal?: AbortSignal; sink: EventSink;
  /**
   * 心跳回合：跳过完成守卫。心跳的"完成"就是 HEARTBEAT_OK，没有"任务完成"这回事；
   * 让守卫开火只会白烧一轮、并把 OK 又说一遍（实测：10-11 日志的
   * "HEARTBEAT_OKHEARTBEAT_OK"、临时内核实测 "HEARTBEAT_OK…没有需要打扰你的事"）。
   */
  heartbeat?: boolean;
  /** 这一轮的模式（面板从 `/api/chat` 的 body.mode 传下来）；swarm 会另发一条独立的模式消息 */
  mode?: TurnMode;
}

export class AgentRuntime {
  #s: AgentServices;
  constructor(services: AgentServices) { this.#s = services; }
  get services(): AgentServices { return this.#s; }

  async run(opts: RunOptions): Promise<{
    assistantMessageId: string; endReason: string; usage: import("../session/types.ts").Usage;
    /** true = 本轮**没有任何用户可见产出**，运行时补了一条说明（问题 ④） */
    silent?: boolean;
  }> {
    const { store, eventLog, pending, steering } = this.#s;
    // 双写门面：按天日志（面板契约）+ 每线程日志（可重放 / 恢复指针），见 run-log.ts
    const logs = makeRunLog({ eventLog, journal: this.#s.journalFor?.(opts.threadId) });
    const thread = store.getThread(opts.threadId);
    if (!thread) throw new Error(`线程 ${opts.threadId} 不存在`);

    const runId = randomUUID().slice(0, 8);
    const projectId = opts.projectId ?? thread.projectId ?? null;
    // 让这一轮产生的所有事件都带上项目 id（前端日志视图按它分组）
    eventLog.setProject(projectId);
    const proj = projectId ? store.getProject(projectId) : undefined;
    const workdir = proj?.path ?? this.#s.store.listProjects()[0]?.path ?? process.cwd();

    // 每轮模式（mode）：模式指令走**独立消息**，用户原话逐字节不动（见 agent/mode-injection.ts）
    if (opts.mode) await injectTurnMode({ store, eventLog, runId, threadId: opts.threadId }, opts.mode);

    const userMsg: Message = { id: `${opts.threadId}--u-${randomUUID()}`, threadId: opts.threadId, role: "user", createdAt: Date.now(),
      parts: [{ type: "text", text: opts.userText }] };
    store.addMessage(userMsg);
    // 面板要截断（够用就行），journal 要**完整**（恢复指针承诺「完整内容在日志里」）→ 两份各一条，形状不同
    logs.split("turn_start",
      { userText: opts.userText.slice(0, 500) + (opts.userText.length > 500 ? `\n…[${opts.userText.length - 500} 字符已省略]` : "") },
      { userText: opts.userText, chars: opts.userText.length }, { run: runId, turn: 1 });
    opts.sink({ type: "turn_start", turn: 1 }); beginTurnDiff(opts.threadId);   // 净 diff 清零（漏调只会把上轮改动重复算进来，不报错）

    const history = store.recentMessages(opts.threadId, 60);
    const repair = repairMessages(history);
    if (repair.findings.length > 0) {
      logs.append("repair", { findings: repair.findings }, { run: runId });
      opts.sink({ type: "repair", findings: repair.findings });
    }

    // ── 后台任务结果注回（T6.3）。claimPendingInjections 是防重复注入的唯一入口（原子标记）；这里管「上轮结束后才就绪」的，轮中就绪的走 steering 通道。
    let taskInjection = "";
    if (this.#s.tasks) {
      const done = this.#s.tasks.claimPendingInjections(opts.threadId);
      if (done.length > 0) {
        taskInjection = renderTaskInjection(done);
        logs.append("task_injection", { count: done.length, ids: done.map((t) => t.id) }, { run: runId });
        opts.sink({ type: "task_injected", count: done.length });
      }
    }

    const assembled = await this.#s.assemble({ thread, projectId, userText: opts.userText, workdir, outputsDir: workdir + "/outputs" });
    // AGENTS.md 本轮变了 → 记一条：提示词真的换了，前缀缓存断在这一点（这是**该断**的，不是 bug）
    if (assembled.instructionsChanged) logs.append("instructions_changed", { workdir }, { run: runId });

    let memoriesBlock = assembled.memoriesBlock;
    if (this.#s.memory) {
      try {
        const r = await this.#s.memory.retrieveForContext(opts.userText, projectId);
        if (r.context) memoriesBlock = r.context;
      } catch { /* 记忆失败绝不影响对话 */ }
    }

    const wireHistory = assembleWireHistory({ store, threadId: opts.threadId, limit: 60, supportsImages: getModelInfo(opts.model ?? thread.model ?? "deepseek-flash").supportsImages });
    const trimmed = dropLastUser(wireHistory);

    const controller = new AbortController();
    const signal = opts.signal ?? controller.signal;
    const wd = new Watchdog(() => controller.abort("watchdog"));
    wd.start();

    // ── 收集 assistant parts（事件 = 持久化 = UI 的同一份数据）
    const parts: Part[] = [];
    const toolIndex = new Map<string, ToolPart>();

    const model = opts.model ?? thread.model ?? "deepseek-flash";
    let stepNo = 0;
    // 文本聚合 / 流式脱敏 / 逐步 flush：见 agent/text-collector.ts 顶部（问题 ④⑥ 都栽在这里）
    const texts = new TextCollector({
      parts, eventLog: logs, sink: opts.sink as (e: { type: string; [k: string]: unknown }) => void,
      runId, step: () => stepNo,
    });
    let compacted = false;
    let compactAt = 0;   // 最近一次检查点的边界；回合末落库的 assistant 必须晚于它（同毫秒会让下一轮取不回这一轮，见 persistCompactedHistory）
    let lastUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | undefined;

    // ⚠️ 必须在 buildExecDeps **之前**声明 —— const 有 TDZ，声明写后面会直接抛。
    const { planMode, permissionMode } = planAwareMode(thread.metadata);   // 计划模式 = 硬只读

    // ── 线程级工具策略（D8）：Home 拿不到写类工具，是能力裁剪不是提示词请求。⚠️ 必须排在 buildExecDeps 之前（见上：TDZ —— 它依赖的 planAwareMode 是上面那条 const）
    const exposure = exposureModeFromEnv();   // DOVE_TOOL_EXPOSURE=visible 才开新轴；缺省 cut（工具真被删掉）
    const readOnly = permissionMode === "read-only";
    const policy = applyThreadPolicy(thread.kind, this.#s.tools, { readOnly, exposure });
    const policyNotice = renderPolicyNotice(thread.kind, policy.blocked, store.listProjects().map((p) => p.id), policy.reason, policy.exposure);
    const blockedNames: ReadonlySet<string> = new Set(policy.blockedFromExecution);
    if (policy.blocked.length > 0) {
      logs.append("policy", { threadKind: thread.kind, reason: policy.reason, blocked: policy.blocked }, { run: runId });
      opts.sink({ type: "policy", reason: policy.reason, blocked: policy.blocked });
    }

    const execDeps = buildExecDeps({
      runtime: { services: {
        pending, memory: this.#s.memory, projectOps: this.#s.projectOps,
        spawnSubagent: this.#s.spawnSubagent,
        webSearchKey: this.#s.webSearchKey,
        mcp: this.#s.mcp, cron: this.#s.cron,   // P0：这是「四处接线」的第三处，漏了工具只会说「未接入」（wiring.test.ts 盯着）
      } },
      sink: opts.sink as (e: { type: string; [k: string]: unknown }) => void,
      threadId: opts.threadId, projectId, workdir, outputsDir: workdir + "/outputs", signal,
      // 走通用通道 —— 以后再加 ExecDeps 顶层字段不用动 wire.ts（栽过三次的地方）；classifier 也走这里，它曾只声明没转发
      execOverrides: { permissionMode, classifier: this.#s.classifier, store: this.#s.store,
        // exposure=visible 时工具还在表里：这里把被裁名单拦成 ok:false（**不置 denied**，见 gates.ts）
        blockedFromExecution: (name: string) => executionBlockedReason(name, blockedNames, policy.reason) },
      onApprovalNeeded: (id, req) => {
        wd.pause();
        const timeoutMs = approvalTimeoutMs();   // 问题 ⑤：等多久一起发，界面能提前提示
        logs.append("tool_approval", { toolCallId: id, riskLevel: req.riskLevel, title: req.title, timeoutMs }, { run: runId });
        const tp = toolIndex.get(id);
        if (tp) { tp.state = "approval-requested"; }
        opts.sink({ type: "tool_approval", toolCallId: id, message: req.message, title: req.title, riskLevel: req.riskLevel, timeoutMs });
      },
    });

    // 崩溃修复交代（repair.notice）**走尾上下文**，贴到最新一条 user 消息上 ——
    // 契约见 session/repair.ts（「注入到最后一条 user 消息前」）。
    // ⚠️ 以前它被 prepend 到会话**第一条** user 消息上（wire-history 里），
    //    等于把整个缓存前缀从第一个 user 消息起全部作废，而且几天后还在说「上一轮被中断了」。
    //    「不许重放、结果未知」的语义一字未改，只是换到了对的位置（tail-context）。
    const effectiveTail = [assembled.tailContext, repair.notice, planMode ? PLAN_MODE_NOTICE : "", policyNotice, taskInjection,
      assembled.instructionsChanged ? "项目指令（AGENTS.md）在本轮发生了变更，以下规则已是最新 —— 之前按旧规则做的事不必回滚，但后续请按新规则来。" : ""].filter(Boolean).join("\n");
    // 尾上下文落库 + 值比较门：贴上去的每一字节都存进这条消息的 metadata，下一轮原样重放（attachTail）
    const tail = attachTail({ store, messageId: userMsg.id, history, tailContext: effectiveTail, memoriesBlock });

    // ── 子代理控制面 / 图片挂载 / 上下文统计（P0）──────────────────
    // ⚠️ services 就是 execDeps.ctxBase.services 的**同一个对象引用**（wire.ts 造完之后不再复制），
    //    往它上面补字段工具才读得到 —— 「建好没接」栽过三次，接线清单见 run-services.ts 顶部。
    const services = (execDeps.ctxBase.services ?? {}) as import("../tools/types.ts").ToolServices;
    /** 最近一次装配给 provider 的 live 消息（GetContextRemaining 估算输入） */ let liveMessages: ChatMessage[] = [];
    const { images } = attachRunServices({
      services, store, tasks: this.#s.tasks, provider: this.#s.provider, model,
      tools: policy.tools, execDeps,
      parentThreadId: opts.threadId, projectId: opts.projectId ?? thread.projectId,
      signal, sink: opts.sink as (e: { type: string; [k: string]: unknown }) => void,
      systemPrompt: assembled.systemPrompt,
      liveMessages: () => liveMessages,
      usage: () => lastUsage,
      planMode, goals: this.#s.goals, exitPlanMode: this.#s.exitPlanMode ? (plan) => this.#s.exitPlanMode!(opts.threadId, plan) : undefined,
    });

    // Home → 项目线程的调度（D8）：在项目线程里完整跑一轮，只把结论带回 Home
    services.dispatchToProject = (projectId, instruction) =>
      runDispatch((o) => this.run(o), { store, projectId, instruction, signal, sink: opts.sink as never });

    let result: Awaited<ReturnType<typeof runTurn>>;
    try {
      result = await runTurn({
        provider: this.#s.provider, model,
        systemPrompt: assembled.systemPrompt, dualSystem: assembled.dualSystem,
        history: trimmed, userText: opts.userText,
        tailContext: tail.tailContext, memoriesBlock: tail.memoriesBlock,
        tools: policy.tools,
        skipCompletionGuard: opts.heartbeat === true,
        activeToolNames: () => currentActiveNames(),   // 按需工具开关（函数：中途激活要立刻生效）
        execDeps,
        hookRegistry: this.#s.hooks,
        steerPending: () => steering.pending(opts.threadId),
        drainSteering: () => steering.drain(opts.threadId),
        signal,
        onBeforeStep: async (st) => {
          stepNo = st.step; wd.touch();
          opts.sink({ type: "step_start", step: st.step });
          logs.append("step_start", { step: st.step }, { run: runId, turn: 1, step: st.step });
          // 步边界记号：并行多调用与两步各一次调用只能靠它分（见 wire-history.ts 切步规则；不上 wire）
          parts.push({ type: "step-start" });
          let msgs = st.messages;
          let changed = false;

          // ReadImage 挂上的图片：在**下一步**注入（user 消息 + image block）。不塞进 role:"tool" 的结果里是因为
          // OpenAI 兼容协议要求它是字符串，图片只能走既有的 image part 通道（见 agent/image-attach.ts 的说明）。
          const pendingImages = images.takePending();
          if (pendingImages.length > 0) {
            msgs = [...msgs, ...pendingImages]; changed = true;
            logs.append("image_injected", { count: pendingImages.length }, { run: runId, step: st.step }); opts.sink({ type: "image_injected", count: pendingImages.length });
          }
          liveMessages = msgs;

          // 后台任务在本轮内就绪 → 走**中途注入**通道（steering），这一轮不结束就能用上它。不直接 append 进 msgs：
          // 中途注入必须落成 injection part 才能原位置重放（铁律二），而 steering 通道已经是对的；闸门①见到待插话还会把这一轮**续上**（这就是「通知给回合续命」，去重靠 injected 标志）。
          if (this.#s.tasks) {
            const done = this.#s.tasks.claimPendingInjections(opts.threadId);
            if (done.length > 0) {
              steering.push(opts.threadId, renderTaskInjection(done));
              logs.append("task_injection", { count: done.length, ids: done.map((t) => t.id), midTurn: true }, { run: runId, step: st.step });
              opts.sink({ type: "task_injected", count: done.length, midTurn: true });
            }
          }

          // AutoCompact：在 step 之间检查
          if (this.#s.compact && st.step > 1 && msgs.length > 20) {
            try {
              const next = await this.#s.compact(msgs, st.step, lastUsage, { threadId: opts.threadId });
              if (next && next.length < msgs.length) {
                compacted = true;
                // 落库检查点（否则压缩只活在轮内）。剥在飞段按**对象身份**（st.inFlight = 循环自己推的那些，理由见 persistCompactedHistory）
                compactAt = persistCompactedHistory({ store, threadId: opts.threadId, compacted: next, inFlight: st.inFlight }).at;
                this.#s.journalFor?.(opts.threadId)?.markWindowStart(`compact step=${st.step} ${msgs.length}→${next.length}`);   // 让恢复指针的行号落在**被摘要**那一段上
                logs.append("compaction", { from: msgs.length, to: next.length }, { run: runId, step: st.step }); opts.sink({ type: "compaction", from: msgs.length, to: next.length });
                return { messages: next, compacted: true };
              }
            } catch { /* 压缩失败不影响主流程 */ }
          }
          if (changed) return { messages: msgs, compacted: false };
        },
        hooks: {
          onUsage: (u) => { lastUsage = u; },
          onText: (delta) => texts.push(delta),
          onReasoning: (delta, full) => texts.reasoning(delta, full),
          onStreamEnd: () => texts.flush(),   // 每个 step 都要放尾巴，见 text-collector.ts（问题 ⑥）
          // 中途注入的 user 消息（steering / 闸门提醒）落成 injection part，下一轮在同一位置重放（铁律二④）
          onUserInjection: (text) => { parts.push({ type: "injection", text }); },
          onToolStart: (call: ToolCallPayload) => {
            wd.touch();
            const tp: ToolPart = {
              type: `tool-${call.function.name}`, toolCallId: call.id, toolName: call.function.name,
              state: "input-available", input: safeParse(call.function.arguments), startedAt: Date.now(),
              // 原参数串必须原样留档：重建时 JSON.stringify(parse(raw)) 会重新排版，缓存前缀就废了
              inputRaw: call.function.arguments,
            };
            toolIndex.set(call.id, tp); parts.push(tp);
            logs.append("tool_call", { tool: tp.toolName, toolCallId: call.id, input: tp.input }, { run: runId, step: stepNo });
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
            // 面板只看 800 字符 preview，journal 拿**完整正文**（恢复指针承诺「完整内容在磁盘上」；
            // 截断的一份喂给 journal 就永远触发不了它的 blob 机制 —— 两份载荷形状**故意不同**）
            logs.split("tool_result",
              { tool: o.toolName, toolCallId: o.toolCallId, ok: o.ok, preview: JSON.stringify(o.output ?? o.errorText ?? "").slice(0, 800), spillPath: o.spillPath },
              { tool: o.toolName, toolCallId: o.toolCallId, ok: o.ok, output: o.output, error: o.errorText, spillPath: o.spillPath }, { run: runId, step: stepNo });
            opts.sink({ type: "tool_result", tool: o.toolName, toolCallId: o.toolCallId, ok: o.ok, result: o.output, error: o.errorText, spillPath: o.spillPath, durationMs: o.durationMs });
          },
        },
      });
    } finally { wd.stop(); }

    // 尾巴兜底：每个 step 已经 flush 过，这里再放一次（幂等，防止 provider 报错提前退出那一步）
    texts.flush();

    // ── 空回合兜底（问题 ④）：为什么会有这种结局，见 agent/turn-outcome.ts 顶部
    const silent = !hasVisibleOutcome(parts);
    if (silent) {
      const note = noOutputNote(result.endReason, result.aborted);
      logs.append("interrupted", {
        endReason: result.endReason, aborted: result.aborted, steps: result.steps, note,
      }, { run: runId });
      // 先报「被中断了」，再补一条 text 说明：只发 interrupted，用户只看到"已暂停"
      opts.sink({ type: "interrupted", endReason: result.endReason, aborted: result.aborted, note });
      texts.annotate(note);
    }

    for (const p of parts) if (!isToolPart(p)) p.state = "output-available";

    const td = takeTurnDiff(opts.threadId);   // 必须在构造消息**之前**取（要写进它的 metadata），取完即清
    const assistantMsg: Message = { id: `${opts.threadId}--a-${randomUUID()}`, threadId: opts.threadId, role: "assistant", createdAt: Math.max(Date.now(), compactAt + 1), usage: result.usage, turnDiff: td.files.length > 0 ? { files: td.files, truncated: td.truncated } : undefined,
      parts: parts.length > 0 ? parts : [{ type: "text", text: "(无输出)", state: "output-available" }] };
    store.addMessage(assistantMsg);
    // 图片在**回合末**落库，历史顺序才是 [assistant(调 ReadImage)] [tool(结果)] [user(图)]（见 agent/image-attach.ts 顶部）
    if (images.pendingCount > 0 || images.attachedCount > 0) images.flush();

    logs.append("turn_end", { endReason: result.endReason, steps: result.steps, gates: result.gates, usage: result.usage, aborted: result.aborted, compacted }, { run: runId, turn: result.gates.length + 1 });

    opts.sink({ type: "stats", usage: result.usage, durationMs: wd.elapsedMs, steps: result.steps, gates: result.gates, model, compacted });

    await persistTurnEnd({ memory: this.#s.memory, store, threadId: opts.threadId, projectId, userText: opts.userText, parts, workdir });

    // 本轮**净 diff**（只覆盖自报的 Write/Edit，见 tools/turn-diff.ts 的边界说明）。取完即清，cap 20k 防 SSE 帧过大；正文在这里被切片，truncated 必须跟着置位 —— 老契约（legacy/CONTRACT.md）写的是「文件条目**或正文**被截断」，只报 td.truncated 会让面板拿着半截正文当完整的展示。
    if (td.files.length > 0) opts.sink({ type: "turn_diff", files: td.files, truncated: td.truncated || td.diffText.length > 20_000, diff: td.diffText.slice(0, 20_000) });

    return { assistantMessageId: assistantMsg.id, endReason: result.endReason, usage: result.usage, silent };
  }
}

/** 宽松 JSON 解析：工具参数不是合法 JSON 时原样返回，交给 repairToolCall 处理 */
function safeParse(s: string): unknown {
  try { return JSON.parse(s || "{}"); } catch { return s; }
}
