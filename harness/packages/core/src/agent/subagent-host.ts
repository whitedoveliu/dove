/**
 * 子代理控制面（P0）：把「派活」从一次性调用变成**可观察、可追加、可中断**的托管进程。
 *
 * 为什么单独一个文件：runtime.ts 已经贴着 400 行硬约束，而这里的
 * 启动 / 跟踪 / 注入 / 中断 / 列表面向的是同一条生命周期，独立成类才好测。
 *
 * 四条纪律：
 *  ① 每个子代理有**自己的 AbortController**，并与父回合的信号联动 ——
 *     这样 InterruptAgent 能只掐死一个子代理，而不是把整轮对话一起 abort（父信号是共用的）。
 *  ② 子代理拿到的 execDeps 里 signal 是它自己的；services 按**角色**收窄：不许派活的角色
 *     连 spawn / send / interrupt / dispatchToProject / attachImage 的端口一起收掉 ——
 *     工具表收了、端口没收 = 能力还在（反之亦然，两处必须一起动）。
 *  ③ 结果注回仍然只走 TaskRegistry 的状态机（claimPendingInjections 是唯一入口）：续跑（resumed）
 *     **不建 task 记录**，因为结论已经直接回给模型了，再注一次就是重复。
 *  ④ 续跑优先**重挂同一段上下文**（#scopes 里的历史），不是新起一个 —— 新起的那个什么都不记得，
 *     只能靠「旧结论当种子」重来一遍，那是降级路而不是默认路。
 * 记录表的两条读路径（ListAgents 汇总 / id 寻址）搬去了 agents/subagent-store.ts —— 本文件贴着 400 行上限。
 */
import type { Provider } from "../providers/types.ts";
import type { Store } from "../session/store.ts";
import type { Tool, ToolServices, AgentSummary, AgentSendResult, AgentInterruptResult } from "../tools/types.ts";
import type { ExecDeps } from "../loop/tool-exec.ts";
import type { TaskRegistry, TaskUsage } from "../agents/task-registry.ts";
import {
  SubagentTranscript, makeSubagentThreadId, SubagentScopeCache, listAgentSummaries, resolveAgent, seedPrompt,
} from "../agents/subagent-store.ts";
import type { AgentScope } from "../agents/subagent-store.ts";
import { runSubagent } from "../agents/subagent.ts";
import type { SubagentRole, SubagentSpawnResult, SubagentSpawnRequest } from "../agents/roles.ts";
import {
  applyRolePolicy, defaultRole, getRole, installSpawnRequestPort, renderRoleListing, roleCanDelegate, DEFAULT_SUBAGENT_ROLE_ID,
} from "../agents/roles.ts";
import { withGitContext } from "../agents/git-context.ts";
import { SUBAGENT_MAX_CONCURRENT, SUBAGENT_SCOPE_CACHE_SIZE } from "../constants.ts";

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
  /** 最近结束的子代理上下文（resume 重挂用）；上限 SUBAGENT_SCOPE_CACHE_SIZE */
  #scopes = new SubagentScopeCache(SUBAGENT_SCOPE_CACHE_SIZE);

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

    // 把「带 role/resume 的完整入口」挂到共享的 services 对象上（同一个引用）。
    // 为什么要这样接：run-services 那一跳按 spawnSubagent 的三参数签名解构，多余字段会被**静默丢掉**
    // —— 而丢角色等于把角色限制偷偷放宽成 general。挂载点定义在 tools/builtin/task.ts
    //（tools 层不能 import agents，所以只能反着挂）；构造在任何工具调用之前，Task 工具一定读得到它。
    installSpawnRequestPort(this.#services, (req: SubagentSpawnRequest) => this.spawn(
      req.prompt, req.label ?? "子任务", req.background === true, { role: req.role, resume: req.resume },
    ));
  }

  get runningCount(): number {
    let n = 0;
    for (const r of this.#runs.values()) if (r.status === "running") n++;
    return n;
  }

  /** Task 工具的入口：background=false 时同步等结论，true 时立刻返回 taskId。
   *  extra.role / extra.resume 由完整端口（spawnSubagentRequest）带进来；三参数调用等价于 general。 */
  async spawn(
    prompt: string, label: string, background: boolean, extra: { role?: string; resume?: string } = {},
  ): Promise<SubagentSpawnResult> {
    const explicitRole = (extra.role ?? "").trim();
    let roleId = explicitRole || DEFAULT_SUBAGENT_ROLE_ID;
    let full = prompt;
    let scope: AgentScope | undefined;

    // ── resume：优先重挂**同一段上下文** ───────────────────
    if (extra.resume) {
      const known = this.#resolve(extra.resume);
      // 作用域按**线程 id** 存，而调用方给的可能是 taskId（后台派活的 id）→ 先解析再查一次
      scope = this.#scopes.get(extra.resume) ?? (known.threadId ? this.#scopes.get(known.threadId) : undefined);
      if (scope) {
        // 显式换角色 = 拒绝（悄悄加权限 / 悄悄砍掉它要用的工具，都是不能接受的）；
        // 没显式指定就**沿用原角色** —— 否则每追问一次都要让模型把角色名再写一遍
        if (explicitRole && explicitRole !== scope.roleId) {
          return {
            status: "done", error: "子代理 " + scope.id + " 是 " + scope.roleId + " 角色，不能按 " + explicitRole + " 续跑",
            note: "要换角色就新派一个（resume 省略掉）。",
          };
        }
        roleId = scope.roleId;
      } else if (known.run?.status === "running") {
        // 还在跑的不能「续跑」：那会并行出第二段历史。追加消息请走 SendMessage（真注入）
        return {
          status: "done", error: "子代理 " + known.run.id + " 还在运行，不能 resume",
          note: "运行中的追加用 SendMessage（消息真注入，它在下一步就能读到）。",
        };
      } else if (!known.run && known.threadId === undefined && known.output === undefined) {
        // 不明归属的 id **必须报错**：静默新起一个，调用方以为在追问，实际换了个什么都不记得的代理
        return {
          status: "done", error: "找不到子代理 " + extra.resume + "（id 不存在，或不属于本线程）",
          note: "用 ListAgents 核对本线程的 id。",
        };
      } else {
        // 归属对，但历史已被淘汰（超过作用域缓存上限）或它是上一个进程跑的 → 退回种子路
        full = seedPrompt(known.output ?? "", prompt);
      }
    }

    const role = getRole(roleId);
    if (!role) {
      return { status: "done", error: "未知角色 \"" + roleId + "\"", note: "可用角色：\n" + renderRoleListing() };
    }

    // 并发上限：到顶就**直接报错**，不排队（排队会让调用方干等到天荒地老还拿不到原因）
    if (this.runningCount >= SUBAGENT_MAX_CONCURRENT) {
      return {
        status: "done", error: "同时运行的子代理已达上限（" + SUBAGENT_MAX_CONCURRENT + " 个）",
        note: "等一个跑完（ListAgents 看 status）再派；或者把它拆小一点自己做完。",
      };
    }

    // 续跑一律前台：后台结果的注回通道只挂在父线程身上，续跑的结论必须当场拿回来
    if (!background || !this.#tasks || scope) {
      const r = await this.#launch(full, label, { background: false }, { role, scope });
      this.#sink({
        type: "subagent_done", label: r.label, subagentId: r.threadId, steps: r.steps,
        endReason: r.endReason, roleId: role.id, resumed: scope !== undefined, usage: r.usage,
      });
      return { status: "done", output: r.output, subagentId: r.threadId, role: role.id, resumed: scope !== undefined, usage: r.usage };
    }
    const rec = this.#tasks.create({ threadId: this.#parentThreadId, prompt: full, kind: label });
    this.#sink({ type: "task_start", taskId: rec.id, label, roleId: role.id });
    void this.#launch(full, label, { background: true, taskId: rec.id }, { role }).then((r) => {
      const status = r.endReason === "aborted" ? "canceled" : "done";
      // usage 落进 tasks 记录（和 task_done 事件同源）：面板 / TaskOutput 之后才看得到「这个后台任务烧了多少 token」
      this.#tasks!.finish(rec.id, r.output, status, r.usage);
      this.#sink({
        type: "task_done", taskId: rec.id, label: r.label, subagentId: r.threadId,
        steps: r.steps, status, roleId: role.id, usage: r.usage,
      });
    }).catch((e) => {
      this.#tasks!.finish(rec.id, "子代理执行失败：" + (e instanceof Error ? e.message : String(e)), "error");
    });
    return { status: "running", taskId: rec.id, role: role.id };
  }

  /** TaskOutput 用：查后台任务记录（usage 是追加字段：provider 没报时 undefined，不是 0） */
  getTask(taskId: string): { taskId: string; label: string; status: string; result?: string; usage?: TaskUsage } | undefined {
    const t = this.#tasks?.get(taskId);
    if (!t) return undefined;
    return { taskId: t.id, label: t.kind, status: t.status, result: t.result, usage: t.usage };
  }

  /** ListAgents 用：本进程在跟踪的 + TaskRegistry 的 + 落库子线程的，按开始时间排序 */
  list(): AgentSummary[] {
    return listAgentSummaries({
      runs: this.#runs, store: this.#store, tasks: this.#tasks, parentThreadId: this.#parentThreadId,
    });
  }

  /** SendMessage 用：运行中 → 真注入；已结束 → **重挂同一段上下文**续跑（历史被淘汰才退回种子路） */
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
    // 优先：重挂同一个子代理上下文（同一段历史、同一个 id）—— 它记得自己做过什么，
    // 不用把旧结论再讲一遍（那是种子路，只在历史被淘汰时才走）。
    const scopeId = r.run?.id ?? r.threadId;
    const scope = scopeId ? this.#scopes.get(scopeId) : undefined;
    // 续跑也是「再起一次运行」，同样受并发上限约束（否则 send 就成了绕过上限的后门）
    if (this.runningCount >= SUBAGENT_MAX_CONCURRENT) {
      return { ok: false, error: "同时运行的子代理已达上限（" + SUBAGENT_MAX_CONCURRENT + " 个）", note: "等一个跑完再追加消息；它已经结束，跑不掉。" };
    }
    if (scope) {
      const out = await this.#launch(message, scope.label, { background: false }, { role: this.#roleOf(scope.roleId), scope });
      this.#sink({
        type: "subagent_resumed", label: out.label, fromId: id, subagentId: out.threadId,
        steps: out.steps, roleId: scope.roleId, reused: true, usage: out.usage,
      });
      return {
        ok: true, mode: "resumed", subagentId: out.threadId, output: out.output,
        note: "重挂了**同一个**子代理（id " + out.threadId + "），它接着自己之前的历史继续 —— 不是新起的。"
          + "结论见 output；它不会被自动注回本线程（你已经在这里拿到了）。",
      };
    }
    // 降级：缓存里没有它（超过上限被淘汰，或它是上一个进程跑的）→ 新起一个，把旧结论当种子。
    // 角色从子线程 metadata 里读回来 —— 降级也不能把只读的 explore 悄悄换成有写权限的 general。
    const prev = (r.output ?? "").trim() || "(它没有留下最终答复)";
    const th = r.threadId ? this.#store.getThread(r.threadId) : undefined;
    const label = (r.run?.label ?? th?.title ?? "子任务") + "·续";
    const role = this.#roleOf(th?.metadata?.roleId as string | undefined);
    const out = await this.#launch(seedPrompt(prev, message), label, { background: false }, { role });
    this.#sink({ type: "subagent_resumed", label: out.label, fromId: id, subagentId: out.threadId, steps: out.steps, reused: false, usage: out.usage });
    return {
      ok: true, mode: "resumed", subagentId: out.threadId, output: out.output,
      note: "它的历史已经不在作用域缓存里了（超过上限被淘汰，或它是上一个进程跑的），所以这是**新起的一个**子代理带着旧结论续跑的结果。",
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
      return { ok: false, error: "子代理 " + r.run.id + " 已经结束（" + r.run.status + "），无需中断", note: "要接着做就用 SendMessage（会重挂它那段历史续跑）。" };
    }
    // ⚠️ 这里**不**把 status 改成 canceled：那只是「我们发出了信号」，不等于它已经停了
    //    （工具可能还要跑一会儿才能到 step 边界）。真实状态由 #launch 在它收尾时写。
    //    否则 ListAgents 会撒谎，测试也测了个假的东西。
    r.run.stopping = true;
    r.run.controller.abort("interrupt-agent");
    return {
      ok: true, status: "stopping",
      note: "中断信号已发出：它会停在当前这一步（已产生的中间输出保留在它的子线程）；父回合不受影响。用 ListAgents 确认它真的变成了 canceled。",
    };
  }

  // ── 内部 ──────────────────────────────────────────────
  /** #scopes 里缺这个角色 id（表被改过 / 老数据）时的兜底：退回默认角色，别让续跑直接失败 */
  #roleOf(roleId: string | undefined): SubagentRole {
    return (roleId ? getRole(roleId) : undefined) ?? defaultRole() ?? getRole(DEFAULT_SUBAGENT_ROLE_ID)!;
  }

  /**
   * 真正跑一次子代理。
   * opt.scope 给了就是续跑：沿用它的线程 id 与历史（不新建线程 —— 主键会撞）。
   */
  async #launch(
    prompt: string, label: string, bg: { background: boolean; taskId?: string },
    opt: { role: SubagentRole; scope?: AgentScope },
  ): Promise<{ output: string; steps: number; endReason: string; threadId: string; label: string; usage: { inputTokens: number; outputTokens: number } }> {
    const role = opt.role;
    const scope = opt.scope;
    // 续跑沿用原来的标签（界面上那条子代理不该因为追问就改名）
    const runLabel = scope?.label ?? label;
    const threadId = scope?.id ?? makeSubagentThreadId(runLabel, bg.taskId);
    const controller = new AbortController();
    const unlink = linkAbort(this.#signal, controller);
    const run: AgentRun = {
      id: threadId, label: runLabel, background: bg.background, taskId: bg.taskId,
      startedAt: Date.now(), status: "running", controller, steering: [],
    };
    this.#runs.set(threadId, run);
    try {
      const transcript = new SubagentTranscript({
        store: this.#store, parentThreadId: this.#parentThreadId, projectId: this.#projectId,
        label: runLabel, background: bg.background, taskId: bg.taskId, threadId, roleId: role.id,
        reuse: scope !== undefined,
      });
      // 角色裁剪在这里落地：父线程策略结果 ∩ 角色白名单（角色只能削减，见 agents/roles.ts）
      const tools = applyRolePolicy(this.#tools, role).tools;
      const r = await runSubagent({
        provider: this.#provider, model: this.#model,
        // git-context 拼在**任务 prompt** 上（不是系统提示词 —— 那会作废前缀缓存）
        prompt: role.gitContext ? withGitContext(prompt, this.#execDeps.ctxBase.workdir) : prompt,
        label: runLabel,
        tools,
        history: scope?.history,
        execDeps: this.#childDeps(controller.signal, role),
        signal: controller.signal,
        drainSteering: () => run.steering.splice(0, run.steering.length),
        onText: (d) => { transcript.text(d); this.#sink({ type: "subagent_text", content: d, label: runLabel, subagentId: threadId }); },
        onReasoning: (d) => { transcript.reasoning(d); this.#sink({ type: "subagent_reasoning", content: d, label: runLabel, subagentId: threadId }); },
        onToolUse: (name, args) => { transcript.tool(name, args); this.#sink({ type: "subagent_tool", tool: name, args, label: runLabel, subagentId: threadId }); },
      });
      transcript.finish(r.endReason === "error" ? "error" : "done", r.endReason);
      run.status = r.endReason === "aborted" ? "canceled" : r.endReason === "error" ? "error" : "done";
      run.endReason = r.endReason;
      run.steps = r.steps;
      run.output = r.output;
      run.finishedAt = Date.now();
      // 记住这一段上下文：下一次 resume 就能原地接着跑（而不是拿旧结论当种子重开）
      this.#scopes.put(
        { id: threadId, label: runLabel, roleId: role.id, history: r.messages, output: r.output, at: Date.now() },
        (id) => this.#runs.get(id)?.status === "running",
      );
      return { output: r.output, steps: r.steps, endReason: r.endReason, threadId, label: runLabel, usage: r.usage };
    } catch (e) {
      run.status = "error";
      run.endReason = "error";
      run.finishedAt = Date.now();
      throw e;
    } finally {
      unlink();
    }
  }

  /** 子代理的 execDeps：自己的 signal + 按角色收窄的服务。
   *  ⚠️ 工具表和端口**必须一起收**：只收表 = 模型看不到但能力还在（能被提示词诱导出来），
   *     只收端口 = 模型看得见却每次报「未接入」（浪费步数，还会以为是自己用错了）。 */
  #childDeps(signal: AbortSignal, role: SubagentRole): Omit<ExecDeps, "tools"> {
    const canDelegate = roleCanDelegate(role);
    return {
      ...this.#execDeps,
      ctxBase: {
        ...this.#execDeps.ctxBase,
        signal,
        services: {
          ...this.#services,
          // 出厂角色全都不带派活工具 → 今天的结果仍是「子代理不能再派子代理」（防无限套娃）。
          // 要开放嵌套：把 Task 等名字加进角色白名单，这两处门会一起打开。
          spawnSubagent: canDelegate ? this.#services.spawnSubagent : undefined,
          spawnSubagentRequest: canDelegate ? this.#services.spawnSubagentRequest : undefined,
          sendAgentMessage: canDelegate ? this.#services.sendAgentMessage : undefined,
          interruptAgent: canDelegate ? this.#services.interruptAgent : undefined,
          // dispatchToProject：子代理去改**别的项目**，超出它的授权范围（父线程才有项目清单）
          dispatchToProject: undefined,
          // 图片挂的是**主线程**的对话，子代理挂会串台 → 让它拿到 VISION_UNAVAILABLE 的明确说明
          attachImage: undefined,
        },
      },
    };
  }

  #resolve(id: string): { run?: AgentRun; threadId?: string; output?: string } {
    return resolveAgent({ runs: this.#runs, store: this.#store, tasks: this.#tasks, parentThreadId: this.#parentThreadId }, id);
  }

}
