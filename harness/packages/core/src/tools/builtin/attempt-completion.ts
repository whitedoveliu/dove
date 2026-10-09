/**
 * AttemptCompletion —— 声明任务完成（元工具，永远在）
 * 它只是**声明**：真正的收尾由 loop 的完成守卫校验（未验证会被要求继续）。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str, optBool } from "./util.ts";

export const AttemptCompletionTool = defineTool({
  name: "AttemptCompletion",
  description:
    "声明任务已完成并给出总结，本轮随之结束。完成守卫会检查是否真的做完（未验证可能被要求继续）。" +
    "需要用户拍板时不要用它，改用 AskUserQuestion。",
  parameters: S.obj({
    summary: S.str("给用户的最终总结：做了什么、结果在哪、还有什么没做"),
    verified: S.bool("是否已实际验证（跑过构建 / 预览 / 测试），默认 false"),
  }, ["summary"]),
  outputTier: "passthrough",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const summary = str(input, "summary");
    const verified = optBool(input, "verified", false);
    ctx.emit("tool:attempt-completion", { toolCallId: ctx.toolCallId, threadId: ctx.threadId, summary, verified });
    return {
      completed: true,
      verified,
      summary,
      note: verified ? "已按「已验证」提交。" : "未声明已验证：完成守卫可能要求你实际验证后再收尾。",
    };
  }),
});
