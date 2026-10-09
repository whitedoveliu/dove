/**
 * Task —— 派子代理独立完成一个任务（M6 / T6.1-T6.5）
 *
 * 为什么要有它：主代理的上下文是稀缺资源。
 * 子代理在自己的上下文里翻文件、试错、失败重来，**只把结论带回来** ——
 * 这是「上下文隔离」，不是「并行加速」（两者用法完全不同）。
 *
 * run_in_background = true 时立即返回 taskId，用 TaskOutput 查结果；
 * 完成后结果会**自动注回原线程**（TaskRegistry 的状态机保证只注一次）。
 */
import { defineTool } from "../types.ts";
import { guarded, str, optStr } from "./util.ts";

export const TaskTool = defineTool({
  name: "Task",
  discoverable: "**派一个子代理**独立完成一件明确的活（它只把结论带回来，过程不占你的上下文）",
  description: [
    "派一个子代理去独立完成一个明确的任务，它只把**结论**带回来。",
    "",
    "什么时候用：",
    "- 需要翻很多文件才能回答的问题（它翻，你不用翻）",
    "- 探索性的活：「找出这个项目里所有硬编码的颜色值」",
    "- 需要试错的任务：「试着让构建通过，告诉我你改了什么」",
    "- 耗时且你不想干等的活 → 加 run_in_background，然后继续做别的事",
    "",
    "什么时候别用：",
    "- 你已经知道要改哪个文件的简单改动 —— 直接改更快",
    "- 需要用户交互的任务（子代理不能和用户对话）",
    "",
    "写 prompt 的要点：子代理**看不到你和用户的对话**。",
    "必须把背景、目标、验收标准、涉及的文件路径都写全，否则它会瞎猜。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "给子代理的完整任务描述（背景 + 目标 + 验收标准 + 文件路径 + 边界）" },
      label: { type: "string", description: "3–5 个词的任务标签，会显示在界面上" },
      run_in_background: { type: "boolean", description: "为 true 时立即返回 taskId，用 TaskOutput 查进度；完成后结果自动回到本线程" },
      allowed_tools: {
        type: "array", items: { type: "string" },
        description: "限制它能用的工具（可选）。默认：Bash/Read/Write/Edit/Glob/Grep/WebSearch/WebFetch/Skill",
      },
    },
    required: ["prompt"],
  },
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const prompt = str(input, "prompt");
    const label = optStr(input, "label") ?? "子任务";
    const background = input.run_in_background === true;
    const allowed = Array.isArray(input.allowed_tools) ? (input.allowed_tools as string[]).map(String) : undefined;

    if (!ctx.services.spawnSubagent) {
      return { ok: false, error: "SUBAGENT_UNAVAILABLE", note: "子代理运行时没接上。你可以自己做这件事。" };
    }

    const fullPrompt = allowed ? prompt + "\n\n（可用工具限制为：" + allowed.join(", ") + "）" : prompt;
    const r = await ctx.services.spawnSubagent({ prompt: fullPrompt, label, background });

    if (r.status === "running") {
      return {
        ok: true, taskId: r.taskId, label, status: "running",
        note: "子代理已在后台开始工作。**不要在这里干等** —— 继续做别的事，或者告诉用户你在等。完成后它的结论会自动出现在这个对话里。用 TaskOutput 可以随时查进度。",
      };
    }
    return {
      ok: true, label, status: "done", output: r.output,
      note: "以上是子代理带回的结论。它的中间过程你看不到；如果结论不够，再派一次并追问更具体的点。",
    };
  }),
});
