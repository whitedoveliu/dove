/**
 * 本轮运行的服务装配（P0）
 *
 * 把「子代理控制面 / 图片挂载 / 上下文统计」三件事从 runtime.run 里挪出来：
 * runtime.ts 已经贴着 400 行硬约束，而这里做的是同一件事 ——
 * 把运行期的能力**挂到工具最终读到的那个 ToolServices 对象上**。
 *
 * ⚠️ 这里的 services 必须是 execDeps.ctxBase.services 的同一个引用。
 *    wire.ts 造完这个对象之后不再复制，所以补字段是有效的；
 *    但也正因为是「隐式接线」，历史上漏接过三次（webSearchKey / permissionMode / 日志字段名）。
 *    谁往这里加能力，谁就要在报告里写清「四处分别加了什么」。
 */
import type { ChatMessage } from "../providers/types.ts";
import type { Provider } from "../providers/types.ts";
import type { Store } from "../session/store.ts";
import type { ExecDeps } from "../loop/tool-exec.ts";
import type { TaskRegistry } from "../agents/task-registry.ts";
import type { Tool, ToolServices } from "../tools/types.ts";
import { currentActiveNames, wireSchemas } from "../tools/registry.ts";
import { getModelInfo } from "../providers/index.ts";
import { ImageRelay } from "./image-attach.ts";
import { makeContextStats } from "./context-stats.ts";
import { SubagentHost } from "./subagent-host.ts";
import { executeOne } from "../loop/tool-exec.ts";
import { DenialMemory } from "../tools/permission.ts";
import { bindPtcRuntime, PTC_APPROVAL_PREFIX } from "../tools/builtin/run-script.ts";

export interface RunServicesInput {
  /** execDeps.ctxBase.services —— 同一个对象引用 */
  services: ToolServices;
  store: Store;
  tasks?: TaskRegistry;
  provider: Provider;
  model: string;
  /** 已按线程策略裁剪的工具表（子代理用） */
  tools: Map<string, Tool>;
  execDeps: Omit<ExecDeps, "tools">;
  parentThreadId: string;
  projectId?: string | null;
  signal?: AbortSignal;
  sink: (e: { type: string; [k: string]: unknown }) => void;
  systemPrompt: string;
  /** 当前 live 消息（GetContextRemaining 的估算输入） */
  liveMessages: () => ChatMessage[];
  /** 最近一次 provider 上报的用量 */
  usage: () => { inputTokens: number; outputTokens: number; cacheReadTokens: number } | undefined;
  /** 是否处于计划模式（硬只读）；只有为 true 时才接 ExitPlanMode */
  planMode?: boolean;
  /** 计划批准后放行（实现见 server/plan-mode-wiring.ts） */
  exitPlanMode?: (plan: string) => Promise<{ ok: boolean; error?: string }>;
  /** 长期目标存储（工具与面板 /goal 共用） */
  goals?: ToolServices["goals"];
}

export interface RunServices {
  images: ImageRelay;
  subagents: SubagentHost;
}

/**
 * 进程级的「同一形状不再重复打扰」记忆（键里带线程 id，所以跨线程共享是安全的）。
 *
 * 为什么放这儿而不是 runtime：这是**接线**（谁给执行器提供记忆），不是运行时门面的事；
 * 而且直接构造 ExecDeps 的单测拿不到它（deps.denials 为 undefined → 策略跳过），测试因此是确定的。
 */
export const processDenials = new DenialMemory();

export function attachRunServices(input: RunServicesInput): RunServices {
  const svc = input.services;
  input.execDeps.denials ??= processDenials;
  const images = new ImageRelay({
    store: input.store,
    threadId: input.parentThreadId,
    model: input.model,
    supportsImages: getModelInfo(input.model).supportsImages,
  });

  const subagents = new SubagentHost({
    provider: input.provider,
    model: input.model,
    tools: input.tools,
    execDeps: input.execDeps,
    store: input.store,
    tasks: input.tasks,
    parentThreadId: input.parentThreadId,
    projectId: input.projectId,
    signal: input.signal,
    sink: input.sink,
    services: svc,
  });

  svc.spawnSubagent = ({ prompt, label, background }) => subagents.spawn(prompt, label ?? "子任务", background === true);
  svc.getTask = (taskId) => subagents.getTask(taskId);
  // 后台任务清单（RuntimeStatus 用）：心跳自检要回答「有没有没跑完的任务」。
  // 接线是「bootstrap 传 tasks → AgentServices 声明 → runtime 转发到这里」，
  // 最后一跳就在这一行 —— 漏了它工具只会说「未接入」，代码上完全看不出问题。
  if (input.tasks) svc.listTasks = (threadId) => input.tasks!.list(threadId);
  svc.listAgents = () => subagents.list();
  svc.sendAgentMessage = (id, message) => subagents.send(id, message);
  svc.interruptAgent = (id) => subagents.interrupt(id);
  svc.attachImage = (req) => images.attach(req);
  // 计划模式：**只有处于计划模式时**才接 ExitPlanMode —— 非计划模式调它会被工具明确拒绝。
  if (input.planMode === true) svc.exitPlanMode = input.exitPlanMode;
  if (input.goals) svc.goals = input.goals;
  svc.contextStats = makeContextStats({
    model: input.model,
    systemPrompt: input.systemPrompt,
    toolDefs: () => wireSchemas(currentActiveNames()),
    usage: input.usage,
    messages: input.liveMessages,
  });

  // ── PTC（RunScript）：脚本里的 doveTool 要能回到内核执行 ────────────────
  // 只有这里同时拿得到「本轮的 execDeps」和「按线程策略裁过的工具表」，所以绑定放在这。
  // ⚠️ 脚本内每次调用都走 executeOne —— 也就是**同一条审批链**：
  //    需要审批的工具照常弹窗（绝不因为「是脚本发的」而放行），输出照样过预算，
  //    审批请求上加一句前缀，用户在弹窗里才认得出这是脚本发的。
  bindPtcRuntime(input.parentThreadId, {
    tools: input.tools,
    invoke: async (name, args, callId) => {
      const deps = input.execDeps;
      const outcome = await executeOne(
        { id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } },
        {
          ...deps,
          tools: input.tools,
          onApprovalNeeded: (id, req) =>
            deps.onApprovalNeeded?.(id, { ...req, message: PTC_APPROVAL_PREFIX + "\n" + req.message }),
        },
      );
      return { ok: outcome.ok, output: outcome.output, errorText: outcome.errorText };
    },
  });

  return { images, subagents };
}
