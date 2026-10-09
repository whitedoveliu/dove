/**
 * DispatchToProject —— Home 线程的调度能力（D8）
 *
 * Home 是调度台，不是工作区。它没有写类工具，要干活就派到项目线程去。
 * 派过去的指令会在**项目线程里**完整跑一轮（有完整的工具集和上下文）。
 */
import { defineTool } from "../types.ts";
import { guarded, str, optStr } from "./util.ts";

export const DispatchToProjectTool = defineTool({
  name: "DispatchToProject",
  description: [
    "把一件活派给某个项目的工作线程，它会带着完整工具集去做，做完把结论带回来。",
    "",
    "**你在 Home 线程时必须用它来干活** —— Home 没有写文件的工具。",
    "",
    "instruction 要写清楚：做什么、验收标准是什么。",
    "项目线程看不到你和 Home 用户的对话，所以背景要写全。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "目标项目 id（可用 VersionList 或问用户拿到）" },
      instruction: { type: "string", description: "给项目线程的完整指令：做什么 + 验收标准 + 背景" },
      label: { type: "string", description: "3–5 个词的任务标签" },
    },
    required: ["project_id", "instruction"],
  },
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const projectId = str(input, "project_id");
    const instruction = str(input, "instruction");
    const label = optStr(input, "label") ?? "项目任务";

    if (!ctx.services.dispatchToProject) {
      return {
        ok: false,
        error: "DISPATCH_UNAVAILABLE",
        note: "调度服务没接上。请直接告诉用户「这件事需要在项目里做」，让他切到对应项目。",
      };
    }

    const r = await ctx.services.dispatchToProject(projectId, instruction);
    return {
      ok: true,
      project_id: projectId,
      label,
      output: r.output,
      endReason: r.endReason,
      note: "以上是项目线程做完后带回的结论。",
    };
  }),
});
