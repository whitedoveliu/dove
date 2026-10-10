/**
 * 子代理控制面（P0）：把「派活」从一次性调用变成**可观察、可追加、可中断**的托管进程。
 *
 * 为什么单独一个文件：runtime.ts 已经贴着 400 行硬约束，而这里的
 * 启动 / 跟踪 / 注入 / 中断 / 列表面向的是同一条生命周期，独立成类才好测。
 *
 * 三条纪律：
 *  ① 每个子代理有**自己的 AbortController**，并与父回合的信号联动 ——
 *     这样 InterruptAgent 能只掐死一个子代理，而不是把整轮对话一起 abort（父信号是共用的）。
 *  ② 子代理拿到的 execDeps 里 signal 是它自己的；services 去掉 spawnSubagent /
 *     dispatchToProject / sendAgentMessage / interruptAgent / attachImage（防嵌套与自我操作）。
 *  ③ 结果注回仍然只走 TaskRegistry 的状态机（claimPendingInjections 是唯一入口）——
 *     续跑（resumed）**不建 task 记录**，因为结论已经直接回给模型了，再注一次就是重复。
 */
import type { Provider } from "../providers/types.ts";
import type { Store } from "../session/store.ts";
import type { Tool, ToolServices, AgentSummary, AgentSendResult, AgentInterruptResult } from "../tools/types.ts";
import type { ExecDeps } from "../loop/tool-exec.ts";
import type { TaskRegistry } from "../agents/task-registry.ts";
import { SubagentTranscript, makeSubagentThreadId, listSubagents } from "../agents/subagent-store.ts";
import { runSubagent } from "../agents/subagent.ts";

export interface SubagentHostOptions {
  provider: Provider;
  model: string;
  /** 子代理能用的工具（已按线程策略裁剪过） */
  tools: Map<string, Tool>;
  execDeps: Omit<ExecDeps, "tools">;
  store: Store;
  tasks?: TaskRegistry;
  parentThreadId: string;
  projectId?: string | null;
  signal?: AbortSignal;
  sink: (e: { type: string; [k: string]: unknown }) => void;
  /** 与主循环**共享同一个引用**的 ToolServices（子代理拿浅拷贝） */
  services: ToolServices;
}

interface AgentRun {
  id: string;
  label: string;
  background: boolean;
  taskId?: string;
  startedAt: number;
  status: "running" | "done" | "error" | "canceled";
  /** 已经发出中断、但还没真正停下来（status 保持 running 直到它真的收尾） */
  stopping?: boolean;
  controller: AbortController;
  /** 待注入的消息（SendMessage 塞进来，子代理每个 step 开头取走） */
  steering: string[];
  output?: string;
  endReason?: string;
  steps?: number;
  finishedAt?: number;
}

const PREVIEW_CHARS = 240;

function clip(s: string | undefined, n = PREVIEW_CHARS): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function mapTaskStatus(s: string): AgentSummary["status"] {
  if (s === "running" || s === "done" || s === "error" || s === "canceled") return s;
  return "unknown";
}

function mapMetaStatus(s: unknown): AgentSummary["status"] {
  return typeof s === "string" ? mapTaskStatus(s) : "unknown";
}

/** 父信号 → 子信号的单向联动；返回解绑函数 */
function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => { /* 无父信号 */ };
  if (parent.aborted) { child.abort("parent-aborted"); return () => { /* 已中止 */ }; }
  const onAbort = (): void => child.abort("parent-aborted");
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

export class SubagentHost {
  #provider: Provider;
  #model: string;
  #tools: Map<string, Tool>;
  #execDeps: Omit<ExecDeps, "tools">;
  #store: Store;
  #tasks: TaskRegistry | undefined;
  #parentThreadId: string;
  #projectId: string | null;
  #signal: AbortSignal | undefined;
  #sink: SubagentHostOptions["sink"];
  #services: ToolServices;
  #runs = new Map<string, AgentRun>();

  constructor(opts: SubagentHostOptions) {
    this.#provider = opts.provider;
    this.#model = opts.model;
    this.#tools = opts.tools;
    this.#execDeps = opts.execDeps;
    this.#store = opts.store;
    this.#tasks = opts.tasks;
    this.#parentThreadId = opts.parentThreadId;
    this.#projectId = opts.projectId ?? null;
    this.#signal = opts.signal;
    this.#sink = opts.sink;
    this.#services = opts.services;
  }

  get runningCount(): number {
    let n = 0;
    for (const r of this.#runs.values()) if (r.status === "running") n++;
    return n;
  }

  /** Task 工具的入口：background=false 时同步等结论，true 时立刻返回 taskId */
  async spawn(prompt: string, label: string, background: boolean): Promise<{ status: "running" | "done"; taskId?: string; output?: string }> {
    if (!background || !this.#tasks) {
      const r = await this.#launch(prompt, label, { background: false });
      this.#sink({ type: "subagent_done", label, subagentId: r.threadId, steps: r.steps, endReason: r.endReason });
      return { status: "done", output: r.output };
    }
    const rec = this.#tasks.create({ threadId: this.#parentThreadId, prompt, kind: label });
    this.#sink({ type: "task_start", taskId: rec.id, label });
    void this.#launch(prompt, label, { background: true, taskId: rec.id }).then((r) => {
      const status = r.endReason === "aborted" ? "canceled" : "done";
      this.#tasks!.finish(rec.id, r.output, status);
      this.#sink({ type: "task_done", taskId: rec.id, label, subagentId: r.threadId, steps: r.steps, status });
    }).catch((e) => {
      this.#tasks!.finish(rec.id, "子代理执行失败：" + (e instanceof Error ? e.message : String(e)), "error");
    });
    return { status: "running", taskId: rec.id };
  }

  /** TaskOutput 用：查后台任务记录 */
  getTask(taskId: string): { taskId: string; label: string; status: string; result?: string } | undefined {
    const t = this.#tasks?.get(taskId);
    if (!t) return undefined;
    return { taskId: t.id, label: t.kind, status: t.status, result: t.result };
  }

  /** ListAgents 用：本进程在跟踪的 + TaskRegistry 的 + 落库子线程的，按开始时间排序 */
  list(): AgentSummary[] {
    const byId = new Map<string, AgentSummary>();
    for (const run of this.#runs.values()) {
      byId.set(run.id, {
        id: run.id, label: run.label, status: run.status, background: run.background,
        taskId: run.taskId, startedAt: run.startedAt, finishedAt: run.finishedAt,
        steps: run.steps, endReason: run.endReason, source: "live",
        outputPreview: clip(run.output),
      });
    }
    const linkedTaskIds = new Set([...this.#runs.values()].map((r) => r.taskId).filter(Boolean) as string[]);
    for (const t of this.#tasks?.list(this.#parentThreadId) ?? []) {
      if (linkedTaskIds.has(t.id) || byId.has(t.id)) continue;
      byId.set(t.id, {
        id: t.id, label: t.kind, status: mapTaskStatus(t.status), background: true,
        taskId: t.id, startedAt: t.createdAt, finishedAt: t.finishedAt, source: "record",
        outputPreview: clip(t.result),
      });
    }
    for (const th of listSubagents(this.#store, this.#parentThreadId)) {
      if (byId.has(th.id)) continue;
      const meta = th.metadata ?? {};
      byId.set(th.id, {
        id: th.id,
        label: String(meta.label ?? th.title ?? "子代理"),
        status: mapMetaStatus(meta.status),
        background: meta.background === true,
        taskId: typeof meta.taskId === "string" ? meta.taskId : undefined,
        startedAt: th.createdAt,
        finishedAt: typeof meta.finishedAt === "number" ? meta.finishedAt : undefined,
        source: "record",
        outputPreview: clip(this.#threadOutput(th.id)),
      });
    }
    return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** SendMessage 用：运行中 → 真注入；已结束 → 带旧结论续跑一个新子代理 */
  async send(id: string, message: string): Promise<AgentSendResult> {
    const r = this.#resolve(id);
    if (r.run && r.run.status === "running") {
      if (r.run.stopping) {
        return {
          ok: false,
          error: "子代理 " + r.run.id + " 正在停止中（已经发过中断）",
          note: "等它真的结束（ListAgents 里 status 变成 canceled）再用 SendMessage —— 那时会带着它已产生的结论续跑。",
        };
      }
      r.run.steering.push(message);
      return {
        ok: true, mode: "injected", subagentId: r.run.id,
        note: "它会在下一步读到。" + (r.run.steering.length > 3 ? "（已经积压了 " + r.run.steering.length + " 条待读消息）" : ""),
      };
    }
    // 完全找不到任何痕迹 → 结构化错误；找到了但没留下答复 → 照样能续跑（说明白就行）
    if (!r.run && r.threadId === undefined && r.output === undefined) {
      return { ok: false, error: "找不到子代理 " + id + "（id 不存在，或不属于本线程）" };
    }
    const prev = (r.output ?? "").trim() || "(它没有留下最终答复)";
    const prompt = [
      "（续跑）你之前被派去做的任务已经结束，你的最终答复是：",
      "-----",
      prev,
      "-----",
      "",
      "主代理现在追加了新的要求，请在这个基础上继续（必要时重新查证，不要凭空推断）：",
      message,
    ].join("\n");
    const label = (r.run?.label ?? this.#labelOf(r.threadId) ?? "子任务") + "·续";
    const out = await this.#launch(prompt, label, { background: false });
    this.#sink({ type: "subagent_resumed", label, fromId: id, subagentId: out.threadId, steps: out.steps });
    return {
      ok: true, mode: "resumed", subagentId: out.threadId, output: out.output,
      note: "新子代理的结论见 output；它不会被自动注回本线程（你已经在这里拿到了）。",
    };
  }

  /** InterruptAgent 用：只掐死这一个子代理，父回合继续 */
  interrupt(id: string): AgentInterruptResult {
    const r = this.#resolve(id);
    if (!r.run) {
      return {
        ok: false,
        error: "找不到正在运行的子代理 " + id + "（可能已经结束，或不是本进程起的）",
        note: r.threadId ? "它在库里已经结束，不需要中断；要接着做就用 SendMessage。" : "用 ListAgents 核对 id。",
      };
    }
    if (r.run.status !== "running") {
      return { ok: false, error: "子代理 " + r.run.id + " 已经结束（" + r.run.status + "），无需中断", note: "要接着做就用 SendMessage（会带旧结论续跑）。" };
    }
    // ⚠️ 这里**不**把 status 改成 canceled：那只是「我们发出了信号」，
    //    不等于它已经停了（工具可能还要跑一会儿才能到 step 边界）。
    //    真实状态由 #launch 在它收尾时写。否则 ListAgents 会撒谎，测试也测了个假的东西。
    r.run.stopping = true;
    r.run.controller.abort("interrupt-agent");
    return {
      ok: true, status: "stopping",
      note: "中断信号已发出：它会停在当前这一步（已产生的中间输出保留在它的子线程）；父回合不受影响。用 ListAgents 确认它真的变成了 canceled。",
    };
  }

  // ── 内部 ──────────────────────────────────────────────
  async #launch(prompt: string, label: string, bg: { background: boolean; taskId?: string }): Promise<{ output: string; steps: number; endReason: string; threadId: string }> {
    const threadId = makeSubagentThreadId(label, bg.taskId);
    const controller = new AbortController();
    const unlink = linkAbort(this.#signal, controller);
    const run: AgentRun = {
      id: threadId, label, background: bg.background, taskId: bg.taskId,
      startedAt: Date.now(), status: "running", controller, steering: [],
    };
    this.#runs.set(threadId, run);
    try {
      const transcript = new SubagentTranscript({
        store: this.#store, parentThreadId: this.#parentThreadId, projectId: this.#projectId,
        label, background: bg.background, taskId: bg.taskId, threadId,
      });
      const r = await runSubagent({
        provider: this.#provider, model: this.#model, prompt, label,
        tools: this.#tools,
        execDeps: this.#childDeps(controller.signal),
        signal: controller.signal,
        drainSteering: () => run.steering.splice(0, run.steering.length),
        onText: (d) => { transcript.text(d); this.#sink({ type: "subagent_text", content: d, label, subagentId: threadId }); },
        onReasoning: (d) => { transcript.reasoning(d); this.#sink({ type: "subagent_reasoning", content: d, label, subagentId: threadId }); },
        onToolUse: (name, args) => { transcript.tool(name, args); this.#sink({ type: "subagent_tool", tool: name, args, label, subagentId: threadId }); },
      });
      transcript.finish(r.endReason === "error" ? "error" : "done", r.endReason);
      run.status = r.endReason === "aborted" ? "canceled" : r.endReason === "error" ? "error" : "done";
      run.endReason = r.endReason;
      run.steps = r.steps;
      run.output = r.output;
      run.finishedAt = Date.now();
      return { ...r, threadId };
    } catch (e) {
      run.status = "error";
      run.endReason = "error";
      run.finishedAt = Date.now();
      throw e;
    } finally {
      unlink();
    }
  }

  /** 子代理的 execDeps：自己的 signal + 去掉「能派活 / 能操作别的子代理 / 能挂图」的服务 */
  #childDeps(signal: AbortSignal): Omit<ExecDeps, "tools"> {
    return {
      ...this.#execDeps,
      ctxBase: {
        ...this.#execDeps.ctxBase,
        signal,
        services: {
          ...this.#services,
          spawnSubagent: undefined,
          dispatchToProject: undefined,
          sendAgentMessage: undefined,
          interruptAgent: undefined,
          // 图片挂的是**主线程**的对话，子代理挂会串台 → 让它拿到 VISION_UNAVAILABLE 的明确说明
          attachImage: undefined,
        },
      },
    };
  }

  #resolve(id: string): { run?: AgentRun; threadId?: string; output?: string } {
    const direct = this.#runs.get(id);
    if (direct) return { run: direct, threadId: direct.id, output: direct.output };
    const byTask = [...this.#runs.values()].find((r) => r.taskId === id);
    if (byTask) return { run: byTask, threadId: byTask.id, output: byTask.output };
    const th = this.#store.getThread(id);
    if (th && th.kind === "subagent" && String(th.metadata?.parentThreadId ?? "") === this.#parentThreadId) {
      return { threadId: id, output: this.#threadOutput(id) };
    }
    const sub = this.#store.listThreads("subagent").find((t) =>
      String(t.metadata?.taskId ?? "") === id && String(t.metadata?.parentThreadId ?? "") === this.#parentThreadId);
    if (sub) return { threadId: sub.id, output: this.#threadOutput(sub.id) };
    const rec = this.#tasks?.get(id);
    if (rec && rec.threadId === this.#parentThreadId) return { output: rec.result ?? "" };
    return {};
  }

  #threadOutput(threadId: string): string | undefined {
    try {
      const msgs = this.#store.listMessages(threadId).filter((m) => m.role === "assistant");
      const last = msgs[msgs.length - 1];
      if (!last) return undefined;
      const text = last.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  #labelOf(threadId: string | undefined): string | undefined {
    if (!threadId) return undefined;
    try { return this.#store.getThread(threadId)?.title; } catch { return undefined; }
  }
}
