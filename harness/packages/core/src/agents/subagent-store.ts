/**
 * 子代理过程记录（A1）
 *
 * 为什么单独一个文件：以前子代理的过程**完全不落盘** —— `tasks` 表只有
 * prompt 和 result，推理和工具调用发完就没了。用户点不进去看，刷新也丢。
 *
 * 做法：把子代理当成**一条子线程**（kind='subagent'），过程写进 messages.parts。
 * 这样「点进去看」直接复用主对话的历史回放路径（partsToEvents），不用新写一套渲染。
 *
 * 为什么不能塞进父消息的 parts：那会污染父线程的**上下文装配** ——
 * 子代理的过程会被当成父代理自己的输出重新喂给模型。
 *
 * 另外这里放着「子代理作用域缓存」（SubagentScopeCache）：续跑（resume）要重挂**同一段历史**，
 * 而历史在我们脑子里（内存）而不是库里 —— 库里只有过程 parts，重建不出一模一样的消息序列。
 * 缓存放在这个文件是因为它和线程记录是同一条生命周期，且 agent/subagent-host.ts 贴着 400 行上限。
 */
import type { ChatMessage } from "../providers/types.ts";
import type { Message, Part, Thread } from "../session/types.ts";
import type { Store } from "../session/store.ts";
import type { AgentSummary } from "../tools/types.ts";
import type { TaskRegistry } from "./task-registry.ts";

/** 线程 id 前缀，方便一眼认出、也方便级联删除时筛选 */
export const SUBAGENT_THREAD_PREFIX = "sub_";

export interface TranscriptInit {
  store: Store;
  /** 父线程（谁派的） */
  parentThreadId: string;
  projectId?: string | null;
  label: string;
  background: boolean;
  /** 后台任务 id（前台没有） */
  taskId?: string;
  /** 线程 id 由调用方给，保证事件里的 id 和落盘的一致 */
  threadId: string;
  /** 用的是哪个角色（续跑要沿用同一个角色，不能因为历史被淘汰就悄悄放宽成 general） */
  roleId?: string;
  /**
   * 续跑（resume）：线程已经存在，**不要**再建。
   * 踩过的坑：threads.id 是主键，重挂同一个子代理时再 createThread 会撞唯一约束抛错 ——
   * 而那一下会发生在子代理刚起步时，表现得像「续跑跑不起来」，很难定位到这里。
   */
  reuse?: boolean;
}

/**
 * 一条子代理的过程记录。
 *
 * 生命周期：构造时**立刻建线程**（这样运行中就能在子代理列表里看到），
 * 收尾时把攒下的 parts 写成一条 assistant 消息，并把状态落到 metadata。
 */
export class SubagentTranscript {
  readonly threadId: string;
  readonly label: string;
  readonly startedAt = Date.now();
  #store: Store;
  #parentThreadId: string;
  #projectId: string | null;
  #background: boolean;
  #taskId: string | undefined;
  #parts: Part[] = [];
  #seq = 0;
  #finished = false;

  constructor(init: TranscriptInit) {
    this.threadId = init.threadId;
    this.label = init.label;
    this.#store = init.store;
    this.#parentThreadId = init.parentThreadId;
    this.#projectId = init.projectId ?? null;
    this.#background = init.background;
    this.#taskId = init.taskId;

    if (init.reuse) {
      // 续跑：只把状态翻回 running（ListAgents / 面板据此看得出它又跑起来了），
      // 标题保留第一次的名字，另外记一笔 resumedAt。
      const th = this.#store.getThread(this.threadId);
      try {
        this.#store.updateThread(this.threadId, {
          metadata: {
            ...(th?.metadata ?? {}),
            parentThreadId: init.parentThreadId, background: init.background,
            roleId: init.roleId ?? null, status: "running", resumedAt: Date.now(),
          },
        });
      } catch { /* 状态更新失败不影响这一次跑 */ }
    } else {
      this.#store.createThread({
        id: this.threadId,
        kind: "subagent",
        projectId: this.#projectId,
        title: init.label,
        metadata: {
          parentThreadId: init.parentThreadId, label: init.label, background: init.background,
          taskId: init.taskId ?? null, roleId: init.roleId ?? null, status: "running",
        },
      });
    }
  }

  /** 思考片段。连续 reasoning 合并进最后一条 —— 否则每个 token 一个 part 会把库撑爆 */
  reasoning(delta: string): void {
    if (this.#finished || !delta) return;
    const last = this.#parts[this.#parts.length - 1];
    if (last?.type === "reasoning") last.text += delta;
    else this.#parts.push({ type: "reasoning", text: delta, id: this.#nextId("r") });
  }

  /** 正文片段，同样连续合并 */
  text(delta: string): void {
    if (this.#finished || !delta) return;
    const last = this.#parts[this.#parts.length - 1];
    if (last?.type === "text") last.text += delta;
    else this.#parts.push({ type: "text", text: delta, id: this.#nextId("t") });
  }

  /** 一次工具调用。工具名进 type（`tool-Bash`），和主循环的 parts 形状保持一致 */
  tool(name: string, args: Record<string, unknown>): void {
    if (this.#finished || !name) return;
    this.#parts.push({
      type: `tool-${name}`,
      toolCallId: this.#nextId("c"),
      toolName: name,
      input: args,
      state: "output-available",
      startedAt: Date.now(),
    });
  }

  get partCount(): number { return this.#parts.length; }

  /**
   * 收尾：把攒下的 parts 写成一条 assistant 消息，更新线程状态。
   *
   * 一条整消息而不是多条：现有 addMessage 没有增量更新语义，
   * 一条最简单、且回放路径已验证。代价是运行中刷新看不到半截（另有实时通道兜底）。
   */
  finish(status: "done" | "error" = "done", endReason?: string): void {
    if (this.#finished) return;
    this.#finished = true;
    const now = Date.now();

    const parts: Part[] = this.#parts.length > 0
      ? this.#parts
      : [{ type: "text", text: "(子代理没有留下过程记录)", state: "output-available" }];

    const msg: Message = {
      id: `${this.threadId}--a-${now}`,
      threadId: this.threadId,
      role: "assistant",
      parts,
      createdAt: now,
    };
    try { this.#store.addMessage(msg); } catch { /* 落盘失败不能影响主流程 */ }

    try {
      const th = this.#store.getThread(this.threadId);
      this.#store.updateThread(this.threadId, {
        metadata: {
          ...(th?.metadata ?? {}),
          status,
          endReason: endReason ?? null,
          finishedAt: now,
          parts: parts.length,
        },
      });
    } catch { /* 同上 */ }
  }

  #nextId(kind: string): string {
    this.#seq += 1;
    return `${this.threadId}-${kind}${this.#seq}`;
  }
}

/** 造一个子代理线程 id。label 里的非安全字符会被压掉，保证 id 可读又合法 */
export function makeSubagentThreadId(label: string, taskId?: string): string {
  const slug = (label || "task").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "task";
  const uniq = (taskId ?? Math.random().toString(36).slice(2, 8)).replace(/[^A-Za-z0-9_-]/g, "");
  return `${SUBAGENT_THREAD_PREFIX}${slug}_${uniq}`;
}

/** 列出某个父线程派出去的所有子代理（按开始时间正序） */
export function listSubagents(store: Store, parentThreadId: string): Thread[] {
  return store.listThreads("subagent")
    .filter((t) => String(t.metadata?.parentThreadId ?? "") === parentThreadId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ── 记录表的两条读路径（从 agent/subagent-host.ts 搬来） ──────
// 为什么搬：这里写的是「子代理的记录怎么被读出来」，和 SubagentTranscript 是同一张表的两面；
// 而 agent/subagent-host.ts 贴着 400 行硬约束，那边只留**生命周期**（启动 / 注入 / 中断 / 续跑）。

/** 本进程还在跟踪的一次运行（host 里的 AgentRun 结构上就是它） */
export interface LiveRunRef {
  id: string;
  label: string;
  background: boolean;
  taskId?: string;
  status: "running" | "done" | "error" | "canceled";
  startedAt: number;
  finishedAt?: number;
  steps?: number;
  endReason?: string;
  output?: string;
}

export interface AgentRef<T extends LiveRunRef = LiveRunRef> {
  run?: T;
  threadId?: string;
  output?: string;
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

/** 子线程里最后一条 assistant 文本（结论预览 / 降级续跑的种子） */
export function threadOutput(store: Store, threadId: string): string | undefined {
  try {
    const msgs = store.listMessages(threadId).filter((m) => m.role === "assistant");
    const last = msgs[msgs.length - 1];
    if (!last) return undefined;
    const text = last.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把一个 id 解析成「本进程正在跟踪的运行 / 落库的子线程 / 后台任务记录」。
 * 三处都要看：id 可能是子代理线程 id、Task 返回的 taskId，也可能是**只有库里留档**的旧子代理。
 * ⚠️ 归属校验也在这一层：不是本父线程的子代理一律当「不存在」返回 —— 跨线程操作别人家的子代理
 *    会让 A 项目的代理去改 B 项目的东西。
 */
export function resolveAgent<T extends LiveRunRef>(input: {
  runs: Map<string, T>;
  store: Store;
  tasks?: TaskRegistry;
  parentThreadId: string;
}, id: string): AgentRef<T> {
  const direct = input.runs.get(id);
  if (direct) return { run: direct, threadId: direct.id, output: direct.output };
  const byTask = [...input.runs.values()].find((r) => r.taskId === id);
  if (byTask) return { run: byTask, threadId: byTask.id, output: byTask.output };
  const th = input.store.getThread(id);
  if (th && th.kind === "subagent" && String(th.metadata?.parentThreadId ?? "") === input.parentThreadId) {
    return { threadId: id, output: threadOutput(input.store, id) };
  }
  const sub = input.store.listThreads("subagent").find((t) =>
    String(t.metadata?.taskId ?? "") === id && String(t.metadata?.parentThreadId ?? "") === input.parentThreadId);
  if (sub) return { threadId: sub.id, output: threadOutput(input.store, sub.id) };
  const rec = input.tasks?.get(id);
  if (rec && rec.threadId === input.parentThreadId) return { output: rec.result ?? "" };
  return {};
}

/**
 * ListAgents 的合并视图：本进程跟踪的 + TaskRegistry 的 + 落库子线程的，按开始时间排序。
 * 三个来源各有一条理由：live 能中断/追加；record 是「已经结束但用户还看得到」；
 * task 是后台任务（它的 id 是 taskId，用户点得进去）。
 */
export function listAgentSummaries(input: {
  runs: Map<string, LiveRunRef>;
  store: Store;
  tasks?: TaskRegistry;
  parentThreadId: string;
}): AgentSummary[] {
  const byId = new Map<string, AgentSummary>();
  for (const run of input.runs.values()) {
    byId.set(run.id, {
      id: run.id, label: run.label, status: run.status, background: run.background,
      taskId: run.taskId, startedAt: run.startedAt, finishedAt: run.finishedAt,
      steps: run.steps, endReason: run.endReason, source: "live",
      outputPreview: clip(run.output),
    });
  }
  const linkedTaskIds = new Set([...input.runs.values()].map((r) => r.taskId).filter(Boolean) as string[]);
  for (const t of input.tasks?.list(input.parentThreadId) ?? []) {
    if (linkedTaskIds.has(t.id) || byId.has(t.id)) continue;
    byId.set(t.id, {
      id: t.id, label: t.kind, status: mapTaskStatus(t.status), background: true,
      taskId: t.id, startedAt: t.createdAt, finishedAt: t.finishedAt, source: "record",
      outputPreview: clip(t.result),
    });
  }
  for (const th of listSubagents(input.store, input.parentThreadId)) {
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
      outputPreview: clip(threadOutput(input.store, th.id)),
    });
  }
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * 「旧结论当种子」的降级 prompt：只在历史已被淘汰（或跨进程续跑）时才走这条路 ——
 * 拿旧结论重新讲一遍再继续，比原地重挂多花一遍上下文，所以它不是默认路。
 */
export function seedPrompt(prev: string, message: string): string {
  return [
    "（续跑）你之前被派去做的任务已经结束，你的最终答复是：",
    "-----",
    prev.trim() || "(它没有留下最终答复)",
    "-----",
    "",
    "主代理现在追加了新的要求，请在这个基础上继续（必要时重新查证，不要凭空推断）：",
    message,
  ].join("\n");
}

/** 一段可续跑的子代理上下文（resume 的全部依据） */
export interface AgentScope {
  /** 子代理线程 id —— 同时也是 resume 的 key */
  id: string;
  label: string;
  roleId: string;
  /** 上一次跑到结束时的完整消息序列（含 system 与最终答复） */
  history: ChatMessage[];
  /** 最后一次的最终答复（历史被淘汰时当种子用） */
  output?: string;
  /** 最后一次使用时间（淘汰顺序用） */
  at: number;
}

/**
 * 作用域缓存：最近结束的子代理，可以原地续跑。
 *
 * 为什么不落库：resume 要的是**逐字节一致的消息序列**（前缀缓存的前提），
 * 而库里存的是 parts，重建出来的序列和实时上过 wire 的那份不一定一致 ——
 * 拿重建成的那份续跑，等于把整段历史按全价重付一遍，还可能踩到配对规则。
 *
 * 淘汰纪律：超过上限时丢最老的，但**正在跑的跳过** —— 它的历史随时会更新，
 * 淘汰了它下次 resume 就只剩「旧结论当种子」这条降级路。
 * 上限管的是**条数**（SUBAGENT_SCOPE_CACHE_SIZE=32）；单条历史跟着 SUBAGENT_MAX_STEPS 走，
 * 100 步封顶，不会无穷长。
 */
export class SubagentScopeCache {
  #max: number;
  #scopes = new Map<string, AgentScope>();

  constructor(max: number) {
    this.#max = Math.max(1, Math.floor(max));
  }

  get size(): number { return this.#scopes.size; }

  /** 取一段作用域；命中即刷新使用时间（LRU） */
  get(id: string): AgentScope | undefined {
    const s = this.#scopes.get(id);
    if (s) s.at = Date.now();
    return s;
  }

  /**
   * 记住一段作用域。`busy` 用来识别「还在跑」的 id：淘汰时跳过它们。
   * 注意 put 的语义是**覆盖**（续跑后历史变长了，必须用新的那份）。
   */
  put(scope: AgentScope, busy: (id: string) => boolean = () => false): void {
    this.#scopes.delete(scope.id);
    this.#scopes.set(scope.id, scope);
    while (this.#scopes.size > this.#max) {
      const victims = [...this.#scopes.values()]
        .filter((s) => s.id !== scope.id && !busy(s.id))
        .sort((a, b) => a.at - b.at);
      const victim = victims[0];
      if (!victim) break;   // 全都在跑：暂时超一点，跑完就会被淘汰
      this.#scopes.delete(victim.id);
    }
  }
}
