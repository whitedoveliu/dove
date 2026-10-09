/**
 * 把运行时依赖接到工具执行管线上（避免 tools 直接依赖 agent/loop）
 */
import type { ExecDeps } from "../loop/tool-exec.ts";
// ExecDeps 已在上行 import（type-only），execOverrides 直接复用它
import type { Tool, ToolContext, ApprovalRequest, ApprovalResponse } from "../tools/types.ts";
import type { ToolServices } from "../tools/types.ts";

export interface WireInput {
  runtime: { services: {
    pending: import("./pending.ts").PendingRegistry;
    memory?: import("./runtime.ts").MemoryPort;
    projectOps?: (id: string) => import("../tools/types.ts").ProjectOps;
    spawnSubagent?: (o: { prompt: string; label?: string; threadId: string }) => Promise<string>;
    /** 屏幕感知（M7）：提供截图 OCR 的检索能力 */
    activity?: { searchScreen(q: string, o?: { limit?: number }): import("../tools/types.ts").ScreenHit[] };
    /** 搜索 API 的 key（Tavily）—— 见下面 services 里的转发，漏了 WebSearch 会静默退回抓 Bing */
    webSearchKey?: string;
  } };
  sink: (e: { type: string; [k: string]: unknown }) => void;
  threadId: string;
  /** 当前项目 id —— 产物工具（构建/预览/版本）靠它找到对应的 ProjectOps */
  projectId?: string | null;
  workdir: string;
  outputsDir: string;
  signal?: AbortSignal;
  onApprovalNeeded: (toolCallId: string, req: ApprovalRequest) => void;
  /**
   * 直接落到 ExecDeps 上的补充字段（**通用通道**）。
   *
   * 为什么要有它：这个接口原来是**手抄 ExecDeps 的子集** ——
   * 加一个 ExecDeps 顶层字段就得同时改「这里的类型 + 下面的 return」两处，
   * 漏一处就是静默失效（值传到一半没了，代码上完全看不出来）。
   * 实测为此栽了三次：webSearchKey、permissionMode，还有一次是日志字段名对不上。
   *
   * 现在任何 ExecDeps 顶层字段都能从这儿过去，**加字段不用再动这个文件**。
   * 注意：services 里的字段不用走这里 —— runtime 会往同一个对象引用上补（见 runtime 的 services.getTask）。
   */
  execOverrides?: Partial<Omit<ExecDeps, "tools" | "ctxBase">>;
}

export function buildExecDeps(input: WireInput): Omit<ExecDeps, "tools"> {
  const svc = input.runtime.services;

  // 产物工具需要 ProjectOps（现在只剩界面侧的预览/版本接口在用；工具都删了）。
  // ProjectOps 是**按项目**的，所以要拿当前 projectId 去换 —— 没有项目时它为 undefined，
  // 工具会返回 PROJECT_UNAVAILABLE 而不是崩掉。
  let project: ToolServices["project"];
  if (svc.projectOps && input.projectId) {
    try { project = svc.projectOps(input.projectId); }
    catch { project = undefined; }
  }

  const services: ToolServices = {
    recall: svc.memory ? (q) => svc.memory!.retrieveForContext(q).then((r) =>
      r.usedMemories.map((m) => ({ content: m.content, score: 1, createdAt: Date.now() }))) : undefined,
    remember: svc.memory ? (c, k, s) => svc.memory!.remember(c, k, s) : undefined,
    spawnSubagent: svc.spawnSubagent ? (o) => svc.spawnSubagent!({ ...o, threadId: input.threadId }) : undefined,
    // 屏幕记忆检索：截图 OCR 的历史（agent 用它回答「我屏幕上看到过什么」）
    searchScreen: svc.activity
      ? (q, n) => {
          try { return svc.activity!.searchScreen(q, { limit: n ?? 5 }); }
          catch { return []; }
        }
      : undefined,
    project,
    // ⚠️ 这个值要在**四个地方**都写对才能生效：
    //   bootstrap 传参 → AgentServices 声明 → runtime 转发 → **这里落到 ToolServices**
    // 实测踩过：前三处都改好了，**漏了这里** —— 值一路传到 buildExecDeps 后被丢掉，
    // WebSearch 静默退回抓 Bing，而代码上完全看不出问题（不报错、不打日志）。
    // 表现是模型抱怨「Bing 把 VST 认成卓佳」，查了半天才发现 key 根本没到工具手上。
    webSearchKey: svc.webSearchKey,
  };

  const ctxBase: Omit<ToolContext, "toolCallId" | "requestApproval"> = {
    threadId: input.threadId,
    workdir: input.workdir,
    outputsDir: input.outputsDir,
    signal: input.signal,
    emit: (event, data) => input.sink({ type: event, ...data }),
    services,
  };

  return {
    ctxBase,
    resolveApproval: async (req: ApprovalRequest, toolCallId: string): Promise<ApprovalResponse> => {
      return svc.pending.requestApproval(toolCallId, req, 300_000, true);
    },
    onApprovalNeeded: input.onApprovalNeeded,
    ...input.execOverrides,
  };
}

export type { Tool };
