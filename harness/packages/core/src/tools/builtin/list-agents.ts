/**
 * ListAgents —— 本线程派出去的子代理与后台任务
 * 数据源两条：本进程还在跟踪的（能中断/追加）+ 落库的子代理线程与 TaskRegistry 记录。
 */
import { defineTool, S } from "../types.ts";
import { guarded, optBool, optNum } from "./util.ts";

const DEFAULT_LIMIT = 20;

function iso(ts: number | undefined): string | undefined {
  return typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
}

export const ListAgentsTool = defineTool({
  name: "ListAgents",
  discoverable: "列出本线程派出去的**子代理 / 后台任务**（id、标签、状态、是否后台、开始时间）",
  description: [
    "列出这个线程派出去的子代理和后台任务（含已经结束的）。",
    "",
    "用它来：确认某个后台任务还在不在跑、拿到 id 去 SendMessage / InterruptAgent、",
    "或者在向用户汇报前核对一下自己到底派过哪些活。",
    "",
    "字段：id（子代理线程 id）、taskId（后台任务 id，Task 返回的那个）、status、background、",
    "startedAt、source（live = 本进程能控制；record = 只在库里，已结束）。",
  ].join("\n"),
  parameters: S.obj({
    include_finished: S.bool("是否包含已结束的（默认 true）"),
    limit: S.num("最多返回几条（默认 " + DEFAULT_LIMIT + "）"),
  }, []),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const svc = ctx.services?.listAgents;
    if (!svc) {
      return {
        count: 0, agents: [], error: "AGENTS_UNAVAILABLE",
        note: "子代理控制面没接上（ctx.services.listAgents 为空）—— 查不到列表，也不代表没派过活。",
      };
    }
    const includeFinished = optBool(input, "include_finished", true);
    const limit = Math.max(1, Math.min(100, Math.floor(optNum(input, "limit") ?? DEFAULT_LIMIT)));
    const all = svc().slice().sort((a, b) => a.startedAt - b.startedAt);
    const running = all.filter((a) => a.status === "running").length;
    const list = (includeFinished ? all : all.filter((a) => a.status === "running")).slice(-limit);
    return {
      count: list.length,
      total: all.length,
      running,
      agents: list.map((a) => ({
        id: a.id,
        taskId: a.taskId,
        label: a.label,
        status: a.status,
        background: a.background,
        startedAt: iso(a.startedAt),
        finishedAt: iso(a.finishedAt),
        steps: a.steps,
        endReason: a.endReason,
        source: a.source,
        outputPreview: a.outputPreview,
      })),
      note: all.length === 0
        ? "这个线程还没有派过子代理。"
        : "running 的可以用 InterruptAgent 中断、SendMessage 追加消息；已结束的用 SendMessage 会**新起一个**子代理续跑。",
    };
  }),
});
