/**
 * ToolSearch —— 检索并按需激活工具（元工具，永远在）
 * 纪律：激活只**追加**到尾部（缓存前缀不变），绝不重排已激活工具的顺序。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str, optNum } from "./util.ts";

export const ToolSearchTool = defineTool({
  name: "ToolSearch",
  description:
    "按关键词检索「未常驻」的工具并激活它们（如 网页搜索 / 网页抓取 / 生成 PPT / 版本管理）。" +
    "激活是追加式的，不影响已有工具；同一步里检索完就能直接调用。常驻工具不需要检索。",
  parameters: S.obj({
    query: S.str("关键词，如「网页抓取」「版本回滚」「ppt」"),
    limit: S.num("最多激活几个（默认 5）"),
  }, ["query"]),
  outputTier: "compact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    // 动态 import：registry 也 import 本文件，运行期解析避免初始化期循环
    const reg = await import("../registry.ts");
    const query = str(input, "query");
    const limit = Math.max(1, Math.min(20, Math.floor(optNum(input, "limit") ?? 5)));

    const matches = reg.searchTools(query, limit);
    const activated = reg.activateTools(matches.map((t) => t.name));
    ctx.emit("tool:activated", { toolCallId: ctx.toolCallId, query, activated });

    return {
      query,
      matches: matches.map((t) => ({ name: t.name, description: t.description.slice(0, 200) })),
      activated,
      total_on_demand: reg.onDemandTools().length,
      note: matches.length
        ? "已激活：" + activated.join("、") + "。现在可以直接调用它们。"
        : "没有匹配的工具。可换关键词，或直接看常驻工具里有没有能用的。",
    };
  }),
});
