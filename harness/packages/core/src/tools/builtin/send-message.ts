/**
 * SendMessage —— 给子代理追加消息
 *
 * 语义（**必须如实写进描述**，否则模型会以为「发完它一定看得到」）：
 *  ① 子代理还在跑 → 真注入：消息进它的消息队列，它在**下一步**读到；
 *     如果它正好在收尾那一步，可能来不及看（返回值里会说明）。
 *  ② 已经结束 → **重挂它那段历史**继续跑（同一个子代理 id，它记得自己做过什么），
 *     返回新的结论；只有历史已经被淘汰（超过作用域缓存上限 / 跨进程）时才会
 *     退回「新起一个 + 旧结论当种子」—— 是哪条路写在返回值 note 里。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str } from "./util.ts";

export const SendMessageTool = defineTool({
  name: "SendMessage",
  discoverable: "给一个子代理追加消息：还在跑的会**真注入**，已结束的会**重挂它那段历史**继续跑",
  description: [
    "给一个子代理追加消息。两种语义，返回值 mode 里写清楚是哪一种：",
    "",
    "【mode=injected】它还在跑 → 消息真的注入进去，它在**下一步**就能看到。",
    "  注意：如果它正好在收尾那一步，可能来不及读；那就等它结束后再发一次（走 mode=resumed）。",
    "【mode=resumed】它已经结束 → **重挂它那段历史**继续跑（同一个 id，不用把旧结论再讲一遍）。",
    "  返回的是新一轮的结论；这个结论**不会**自动注回本线程（你在这里已经拿到了）。",
    "  少数情况下返回值 note 会说「新起了一个」——那是它的历史已被淘汰（超过作用域缓存上限，",
    "  或它是上一个进程跑的），只能带着旧结论重开。",
    "",
    "id 用 ListAgents 给的 id，或用 Task 返回的 taskId。id 不存在/不属于本线程 → 结构化错误。",
  ].join("\n"),
  parameters: S.obj({
    agent_id: S.str("子代理 id（ListAgents 的 id，或 Task 返回的 taskId）"),
    message: S.str("要追加的内容（写全：子代理看不到你和用户的对话）"),
  }, ["agent_id", "message"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const id = str(input, "agent_id");
    const message = str(input, "message");
    const svc = ctx.services?.sendAgentMessage;
    if (!svc) {
      return {
        ok: false, agent_id: id, error: "AGENTS_UNAVAILABLE",
        note: "子代理控制面没接上（ctx.services.sendAgentMessage 为空）—— 消息没发出去。",
      };
    }
    const r = await svc(id, message);
    if (!r.ok) {
      return { ok: false, agent_id: id, error: r.error ?? "发送失败", note: r.note ?? "先用 ListAgents 确认 id 与状态。" };
    }
    ctx.emit("tool:agent-message", { toolCallId: ctx.toolCallId, agentId: id, mode: r.mode });
    if (r.mode === "injected") {
      return {
        ok: true, agent_id: id, mode: "injected",
        note: "消息已注入，它会在下一步读到。" + (r.note ? " " + r.note : "") +
          "不要在这里干等 —— 继续做别的事，它的最终结论会按原有方式回来（后台任务会自动注回本线程）。",
      };
    }
    return {
      ok: true, agent_id: id, mode: "resumed", subagentId: r.subagentId, output: r.output,
      // 走的是哪条路（重挂同一段历史 / 新起一个带种子）由 host 写在 note 里，原样透传 ——
      // 这里手写一句会撒谎：工具层不知道缓存命没命中。
      note: (r.note ?? "已结束的子代理被续跑，结论见 output。") + "（已经结束，不会再有后续）",
    };
  }),
});
