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
 */
import type { Message, Part, Thread } from "../session/types.ts";
import type { Store } from "../session/store.ts";

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

    this.#store.createThread({
      id: this.threadId,
      kind: "subagent",
      projectId: this.#projectId,
      title: init.label,
      metadata: {
        parentThreadId: init.parentThreadId,
        label: init.label,
        background: init.background,
        taskId: init.taskId ?? null,
        status: "running",
      },
    });
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
