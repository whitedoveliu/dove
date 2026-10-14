/**
 * 子代理的**报告视图**（只读侧）
 *
 * 两类东西，都是派生，**没有新数据源**：
 *  ① 记录表的读路径（ListAgents 汇总 / id 寻址）—— 从 agents/subagent-store.ts 搬来。
 *     搬的理由和当初从 subagent-host.ts 搬来时一样：subagent-store.ts 又贴到 400 行硬约束了，
 *     而这两件事（写过程 vs 读记录）本来就是同一张表的两面，分两个文件各自读得下去。
 *  ② 面板「后台 Agent」要的两样：**列表行**（状态 / 模型 / 用时 / 用量）与**过程条目**
 *     （思考 / 正文 / 工具调用 + 结果，带顺序）。
 *
 * 全从 threads（kind='subagent'）+ messages.parts 派生 —— 所以刷新、重启之后照样看得到，
 * 内存里那份（AgentRun）只是运行时的加速，不是另一个真相源。
 */
import type { Part, Message, Thread } from "../session/types.ts";
import type { Store } from "../session/store.ts";
import type { AgentSummary } from "../tools/types.ts";
import type { TaskRegistry } from "./task-registry.ts";

// ── ① 记录表的读路径（原 agents/subagent-store.ts）────────────────

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
  for (const th of listSubagentThreads(input.store, input.parentThreadId)) {
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

/** 某个父线程派出去的所有子代理线程（按开始时间正序） */
function listSubagentThreads(store: Store, parentThreadId: string): Thread[] {
  return store.listThreads("subagent")
    .filter((t) => String(t.metadata?.parentThreadId ?? "") === parentThreadId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ── ② 面板「后台 Agent」的列表行 ──────────────────────────────

export type SubagentStatus = "running" | "done" | "error" | "canceled" | "stale" | "unknown";

/** 「后台 Agent」列表的状态页签（最近 / 进行中 / 已完成 / 全部 —— 对齐 Kimi Code 那排） */
export type SubagentStatusFilter = "recent" | "running" | "done" | "failed" | "all";

/** 「最近」页签取多少条 —— 它是个概览，不是全量列表（全量走「全部」） */
export const RECENT_LIMIT = 20;

/**
 * 落库里只会有 running / done / error / canceled 四种（写入口是 SubagentTranscript）。
 * `stale` 是**读侧**判出来的：记录说它在跑，但它不属于当前这个进程（见 subagentItem）。
 */
const STATUSES: readonly SubagentStatus[] = ["running", "done", "error", "canceled"];

/** metadata.status 是不可信输入（老数据 / 手工写过）→ 认不出就是 unknown，不猜 */
export function normalizeStatus(raw: unknown): SubagentStatus {
  return typeof raw === "string" && (STATUSES as readonly string[]).includes(raw)
    ? raw as SubagentStatus
    : "unknown";
}

/** 面板卡片的一行 */
export interface SubagentItem {
  id: string;
  label: string;
  status: SubagentStatus;
  /** 是「后台任务」（真的异步跑）还是前台（父回合干等它） */
  background: boolean;
  taskId: string | null;
  parentId: string;
  projectId: string | null;
  /**
   * 它跑的时候用的模型。**没记录 = null** —— 界面显示「未记录」。
   * 不拿 threads.model 的默认值（deepseek-flash）冒充：那条默认值对所有没显式写过
   * model 的老线程都成立，把它当事实就是编造（见 subagent-store.ts 的写入点）。
   */
  model: string | null;
  roleId: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** 开始到结束的毫秒。还在跑 = null —— 界面拿 startedAt 自己走表，不假装已经跑完 */
  durationMs: number | null;
  /** 落盘的过程条数（parts 数，不是步数） */
  parts: number;
  endReason: string | null;
  /** token 用量；null = 没记录 / provider 没报（**不是 0**，见 task-registry.ts:finish） */
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** 一行 threads 记录 → 面板的列表行 */
export function subagentItem(
  t: Thread,
  opts: {
    usage?: { inputTokens: number; outputTokens: number } | null;
    projectPath?: string | null;
    /**
     * 读这份记录的进程 pid（路由传 `process.pid`）。**只在核验「它真的还在跑」时用**：
     * 记录说 running、而写下这条记录的进程不是当前进程 → 那次运行已经随上一个进程结束了
     * （重启 / 崩溃），状态判成 `stale` 而不是 running。不传 = 不做这个核验（老行为）。
     */
    ownerPid?: number;
  } = {},
): SubagentItem & { projectPath: string | null } {
  const meta = t.metadata ?? {};
  const startedAt = t.createdAt;
  const finishedAt = typeof meta.finishedAt === "number" ? meta.finishedAt : null;
  const recorded = normalizeStatus(meta.status);
  /**
   * 「记录说它在跑，但写下这条记录的**不是这个进程**」= 那次运行已经没了。
   *
   * 为什么必须说出来：进程被重启（或崩了）时，线程上的 status 永远停在 running ——
   * 没人有机会把它改掉。不判出来的话，面板会为一个**早已不在跑**的子代理一直转圈，
   * 而且它会永远留在「进行中」页签里。判据是 pid 而不是时间：老记录（没有 ownerPid）
   * 一律不动 —— 证明不了的事不猜（那种情况维持 running，与改动前一致）。
   */
  const stale = recorded === "running"
    && typeof meta.ownerPid === "number"
    && opts.ownerPid !== undefined
    && meta.ownerPid !== opts.ownerPid;
  const status: SubagentStatus = stale ? "stale" : recorded;
  return {
    id: t.id,
    label: String(meta.label ?? t.title ?? t.id),
    status,
    background: meta.background === true,
    taskId: typeof meta.taskId === "string" ? meta.taskId : null,
    parentId: String(meta.parentThreadId ?? ""),
    projectId: t.projectId ?? null,
    /**
     * 先看 metadata.model（**只有真记过才有**，见 subagent-store.ts 的写入点）。
     * 绝不退回 `threads.model`：那一列有 `NOT NULL DEFAULT 'deepseek-flash'`，
     * 而记录模型这件事之前的老线程从来没写过它 —— 读出来一律是那个默认值，
     * 把它显示成「这个子代理用了 flash」就是编造。没记 = null（界面显示「未记录」）。
     */
    model: typeof meta.model === "string" && meta.model ? meta.model : null,
    roleId: typeof meta.roleId === "string" ? meta.roleId : null,
    startedAt,
    finishedAt,
    durationMs: finishedAt === null ? null : Math.max(0, finishedAt - startedAt),
    parts: Number(meta.parts ?? 0),
    endReason: typeof meta.endReason === "string" ? meta.endReason : null,
    usage: opts.usage ?? null,
    projectPath: opts.projectPath ?? null,
  };
}

/** 按页签过滤（顺序沿用传入顺序；「最近」自己按开始时间倒序取前 N 条） */
export function filterSubagentItems(items: SubagentItem[], filter: SubagentStatusFilter): SubagentItem[] {
  switch (filter) {
    case "running": return items.filter((i) => i.status === "running");
    case "done": return items.filter((i) => i.status === "done");
    // 「失败」把取消也算进去：对用户来说两者都是「没干成」，分成两个页签只会让人找不着
    case "failed": return items.filter((i) => i.status === "error" || i.status === "canceled");
    case "recent": return [...items].sort((a, b) => b.startedAt - a.startedAt).slice(0, RECENT_LIMIT);
    default: return items;
  }
}

// ── ③ 过程条目（「点进去看它干了什么」）──────────────────────

/**
 * 过程条目的一行 —— 界面按 kind 渲染（思考 / 正文 / 工具调用 + 结果），**顺序就是它发生的顺序**。
 *
 * 相邻同类不在这里合并：写入侧（SubagentTranscript）已经把连续 reasoning / text 合进了同一条 part，
 * 再合一次反而会把「两段分开的思考」粘成一坨。
 */
export interface SubagentEntry {
  kind: "reasoning" | "text" | "tool";
  /** reasoning / text 的正文 */
  text?: string;
  /** 工具名（kind === "tool"） */
  tool?: string;
  /** 工具入参原样给出来 —— 抽成一句人话是展示层的事（route 里用 toolInfoLine） */
  args?: Record<string, unknown>;
  /**
   * 工具结果（截断到 ENTRY_RESULT_CHARS）。
   * ⚠️ **只有它结束、把 parts 落盘之后才有** —— 运行中那段过程走 SSE 那条实时流
   *    （见 subagent-store.ts:finish 的说明）。运行中这里看到的是空列表 + 界面上的实时时间线。
   */
  result?: string;
  /** 工具是否成功；undefined = 没留下结论（老数据 / 只记了调用） */
  ok?: boolean;
  /** 这次调用开始的时间（毫秒） */
  at?: number;
}

const ENTRY_RESULT_CHARS = 2000;

/** 工具结果 → 一行文本。对象就序列化，坏值不抛（一行坏数据不该让整段过程消失） */
function resultText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  if (!s) return undefined;
  return s.length > ENTRY_RESULT_CHARS ? s.slice(0, ENTRY_RESULT_CHARS) + "…（截断）" : s;
}

/** 一个子代理线程里落盘的过程条目，按发生顺序 */
export function subagentEntries(store: Store, threadId: string): SubagentEntry[] {
  let messages: Message[] = [];
  try { messages = store.listMessages(threadId); } catch { return []; }

  const out: SubagentEntry[] = [];
  for (const m of messages) {
    // 子线程里落盘的只有 assistant（那一条过程消息）；user / system 不该出现在过程视图里
    if (m.role !== "assistant") continue;
    for (const raw of m.parts as Part[]) {
      const p = raw as Part & { text?: string };
      if (p.type === "text" || p.type === "reasoning") {
        const text = String(p.text ?? "");
        if (text) out.push({ kind: p.type === "reasoning" ? "reasoning" : "text", text });
        continue;
      }
      // step-start / injection / file / image 都不是「过程」—— 界面要的是它想了什么、调了什么
      if (!p.type.startsWith("tool-")) continue;
      const tp = raw as Extract<Part, { type: `tool-${string}` }> & { output?: unknown; errorText?: string };
      out.push({
        kind: "tool",
        tool: String(tp.toolName ?? p.type.slice(5)),
        args: (tp.input ?? {}) as Record<string, unknown>,
        result: resultText(tp.output) ?? resultText(tp.errorText),
        ok: tp.state === "output-error" ? false : tp.output === undefined ? undefined : true,
        at: tp.startedAt,
      });
    }
  }
  return out;
}
