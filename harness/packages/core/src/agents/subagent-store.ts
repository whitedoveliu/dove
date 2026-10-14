/**
 * 子代理过程记录（A1）
 *
 * 为什么单独一个文件：以前子代理的过程**完全不落盘** —— `tasks` 表只有
 * prompt 和 result，推理和工具调用发完就没了。用户点不进去看，刷新也丢。
 *
 * 做法：把子代理当成**一条子线程**（kind='subagent'），过程写进 messages.parts。
 * 这样「点进去看」直接复用主对话的历史回放路径（partsToEvents），不用新写一套渲染。
 * 读侧（列表 / 过程条目）在 agents/subagent-report.ts —— 本文件只写不读。
 *
 * 为什么不能塞进父消息的 parts：那会污染父线程的**上下文装配** ——
 * 子代理的过程会被当成父代理自己的输出重新喂给模型。
 *
 * 另外这里放着「子代理作用域缓存」（SubagentScopeCache）：续跑（resume）要重挂**同一段历史**，
 * 而历史在我们脑子里（内存）而不是库里 —— 库里只有过程 parts，重建不出一模一样的消息序列。
 * 缓存放在这个文件是因为它和线程记录是同一条生命周期，且 agent/subagent-host.ts 贴着 400 行上限。
 */
import type { ChatMessage } from "../providers/types.ts";
import type { Message, Part } from "../session/types.ts";
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
  /** 用的是哪个角色（续跑要沿用同一个角色，不能因为历史被淘汰就悄悄放宽成 general） */
  roleId?: string;
  /**
   * 它这次跑用的模型（`provider.stream` 的 model）。
   * 落进 metadata.model —— 面板「后台 Agent」卡片上那一行「模型」只认这一个字段，
   * **没记 = 显示未记录**，不拿 threads.model 的默认值冒充（见 subagent-report.ts 的 subagentItem）。
   */
  model?: string;
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
      // 标题保留第一次的名字，另外记一笔 resumedAt。模型按这次的写（续跑可能换了模型）。
      const th = this.#store.getThread(this.threadId);
      try {
        this.#store.updateThread(this.threadId, {
          model: init.model ?? th?.model,
          metadata: {
            ...(th?.metadata ?? {}),
            parentThreadId: init.parentThreadId, background: init.background,
            roleId: init.roleId ?? null, status: "running", resumedAt: Date.now(),
            model: init.model ?? th?.metadata?.model ?? null,
            // 谁在跑这条子代理（进程号）—— 读侧据此认出「重启后永远停在 running 的那条」
            ownerPid: process.pid,
          },
        });
      } catch { /* 状态更新失败不影响这一次跑 */ }
    } else {
      this.#store.createThread({
        id: this.threadId,
        kind: "subagent",
        projectId: this.#projectId,
        title: init.label,
        // model 只在调用方给了的时候才落列 —— 不给就让 schema 默认值留在那儿，
        // 而 metadata.model 缺席 = 面板显示「未记录」（拿默认值当事实就是编造）
        ...(init.model ? { model: init.model } : {}),
        metadata: {
          parentThreadId: init.parentThreadId, label: init.label, background: init.background,
          taskId: init.taskId ?? null, roleId: init.roleId ?? null, status: "running",
          model: init.model ?? null,
          // 这条子代理是**哪个进程**起的。读侧（agents/subagent-report.ts 的 subagentItem）
          // 用它把「重启后永远停在 running 的僵尸」判成 stale，而不是让面板一直转圈。
          ownerPid: process.pid,
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

  /**
   * 一次工具调用。工具名进 type（`tool-Bash`），和主循环的 parts 形状保持一致。
   *
   * `toolCallId` 用**调用方给的那个**（provider 的 call id）—— 结果回来时按它配对。
   * 不给才自己造一个（没有 provider id 的调用方：老代码 / 测试）。
   */
  tool(name: string, args: Record<string, unknown>, toolCallId?: string): void {
    if (this.#finished || !name) return;
    this.#parts.push({
      type: `tool-${name}`,
      toolCallId: toolCallId ?? this.#nextId("c"),
      toolName: name,
      input: args,
      // 和主循环一致：调用时是 input-available，结果回来了才 output-available（见 toolResult）
      state: "input-available",
      startedAt: Date.now(),
    });
  }

  /**
   * 一次工具调用的结果，补进那次调用对应的 part。
   *
   * 为什么必须补：面板「后台 Agent」点进去要看的是「它调了什么、拿到了什么」——
   * 只有调用没有结果，读起来就是一串悬空的命令（用户明确要求带结果）。
   * 实时那条流（SSE 的 subagent_tool）仍然只发调用：结果是**落盘之后**才有的，
   * 运行中的过程由面板的实时时间线兜底（见 finish 的说明）。
   */
  toolResult(toolCallId: string, ok: boolean, output?: unknown, errorText?: string): void {
    if (this.#finished) return;
    // 从后往前找：同一个 toolCallId 只会有一条，而从后往前命中更快（刚调完的那个多半就在尾巴上）
    for (let i = this.#parts.length - 1; i >= 0; i--) {
      const p = this.#parts[i]!;
      if (p.type.startsWith("tool-") && (p as { toolCallId?: string }).toolCallId === toolCallId) {
        const tp = p as { state?: string; output?: unknown; errorText?: string; finishedAt?: number };
        tp.state = ok ? "output-available" : "output-error";
        if (ok) tp.output = output ?? {};
        else tp.errorText = errorText ?? "执行失败";
        tp.finishedAt = Date.now();
        return;
      }
    }
    // 找不到对应的调用（part 被裁掉 / id 对不上）→ 什么都不做，不新造一条孤立的「结果」行
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

// ── 记录表的读路径都搬去了 agents/subagent-report.ts ──────────
// 为什么再搬一次：本文件写在 400 行硬约束上（写过程 + 生命周期），而「记录怎么被读出来」
// 和面板的列表 / 过程条目是同一件事（派生视图），放一起才读得完。

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
