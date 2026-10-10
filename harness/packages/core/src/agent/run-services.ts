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

export function attachRunServices(input: RunServicesInput): RunServices {
  const svc = input.services;
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

  return { images, subagents };
}
