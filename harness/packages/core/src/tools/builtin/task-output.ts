/**
 * TaskOutput —— 查看后台子代理的进度 / 等它结束
 */
import { defineTool } from "../types.ts";
import { guarded, str } from "./util.ts";

export const TaskOutputTool = defineTool({
  name: "TaskOutput",
  discoverable: "查看后台子任务的状态与结果",
  description: [
    "查看一个后台子任务的状态和结果。",
    "block=true 时会等它结束（最多 30 秒）—— 只在你**确实需要结果才能继续**时才用，否则别阻塞。",
    "注意：后台任务完成后，它的结论会**自动**出现在对话里；如果你已经看到了，就不用再查。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task 工具返回的 taskId" },
      block: { type: "boolean", description: "是否等待任务结束（最多 30 秒）" },
    },
    required: ["task_id"],
  },
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const taskId = str(input, "task_id");
    if (!ctx.services.getTask) return { error: "TASK_UNAVAILABLE", note: "任务查询服务没接上。" };

    const deadline = Date.now() + (input.block === true ? 30_000 : 0);
    for (;;) {
      const t = ctx.services.getTask(taskId);
      if (!t) return { error: "找不到任务 " + taskId };
      if (t.status !== "running" || Date.now() >= deadline) {
        return {
          taskId, label: t.label, status: t.status,
          result: t.status === "running" ? "(还在跑，暂无结果)" : (t.result ?? "(无结果)"),
          note: t.status === "running" ? "它还在跑。别阻塞，先做别的，结果会自动回来。" : "任务已结束。",
        };
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }),
});
