/**
 * Remember —— 写入长期记忆（常驻）
 * 只存**稳定高价值**的东西（事实 / 偏好 / 决策 / 反馈 / 参考），不存临时状态。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str, optStr } from "./util.ts";

/** kind 取值（创意场景特化，见设计稿 §6.2） */
export const MEMORY_KINDS = ["fact", "preference", "taste", "decision", "feedback", "reference"] as const;

export const RememberTool = defineTool({
  name: "Remember",
  description:
    "把一条值得长期记住的信息写进记忆（用户偏好、稳定事实、项目决策、对产物的反馈、外部参考）。" +
    "只存稳定的高价值信息；临时状态、一次性任务细节不要写。" +
    "kind 取值：" + MEMORY_KINDS.join(" / ") + "；scope 默认 global，项目内的事用 project:<id>。",
  parameters: S.obj({
    content: S.str("要记住的内容（一句话，自包含，不要代词）"),
    kind: S.str("类型：" + MEMORY_KINDS.join(" | ")),
    scope: S.str("作用域：global（默认）或 project:<id>"),
  }, ["content"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const content = str(input, "content").trim();
    if (content.length < 4) return { saved: false, error: "内容太短，写进去没有价值。" };
    const kind = optStr(input, "kind") ?? "fact";
    const scope = optStr(input, "scope") ?? "global";
    const svc = ctx.services?.remember;
    if (!svc) {
      return { saved: false, error: "REMEMBER_UNAVAILABLE", note: "记忆服务未接入（ctx.services.remember 为空），这条没有被保存。" };
    }
    const id = await svc(content, kind, scope);
    ctx.emit("tool:memory-written", { toolCallId: ctx.toolCallId, id, kind, scope });
    return { saved: true, id, kind, scope, chars: content.length };
  }),
});
