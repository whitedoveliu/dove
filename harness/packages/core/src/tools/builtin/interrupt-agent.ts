/**
 * InterruptAgent —— 中断正在跑的子代理
 * 只对本进程派出去、还在跑的子代理有效（拿得到它的 AbortController）。
 * 已结束 / 不是本进程起的 → 结构化错误，不抛。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str } from "./util.ts";

export const InterruptAgentTool = defineTool({
  name: "InterruptAgent",
  discoverable: "中断一个**正在运行**的子代理（它已产生的输出会保留下来）",
  description: [
    "中断一个正在运行的子代理（或后台任务对应的子代理）。",
    "",
    "- 只对本进程派出去、还在跑的子代理有效；已经结束的会返回结构化错误（不用中断）。",
    "- 中断是「停在当前这一步」：它已经写下的中间输出和结论片段都会保留在它的子线程里。",
    "- 中断后它不会再有结果注回本线程；需要的话可以 SendMessage 用它的已有结论续跑。",
    "",
    "用 ListAgents 拿 id；不确定它还在不在跑就先列一下。",
  ].join("\n"),
  parameters: S.obj({
    agent_id: S.str("要中断的子代理 id（ListAgents 的 id，或 Task 返回的 taskId）"),
  }, ["agent_id"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const id = str(input, "agent_id");
    const svc = ctx.services?.interruptAgent;
    if (!svc) {
      return {
        ok: false, agent_id: id, error: "AGENTS_UNAVAILABLE",
        note: "子代理控制面没接上（ctx.services.interruptAgent 为空）—— 没有中断任何东西。",
      };
    }
    const r = svc(id);
    if (!r.ok) {
      return {
        ok: false, agent_id: id, error: r.error ?? "中断失败",
        note: r.note ?? "用 ListAgents 确认 id 和状态（已结束的不用中断）。",
      };
    }
    ctx.emit("tool:agent-interrupted", { toolCallId: ctx.toolCallId, agentId: id });
    return {
      ok: true, agent_id: id, status: r.status ?? "stopping",
      note: r.note ?? "中断信号已发出，它会在当前这一步结束后停下。",
    };
  }),
});
