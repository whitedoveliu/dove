/**
 * ToolSearch —— 检索并按需激活工具（元工具，永远在）
 * 纪律：激活只**追加**到尾部（缓存前缀不变），绝不重排已激活工具的顺序。
 *
 * ── 关于 Alma 的「ToolSearch 必须在 stepNumber > 0」（清单 A① / B③）──
 * 那条硬性约束在 dove 上**不按步号实现**，而是由两件结构性事实等价保证，别再按步号加拦截：
 *  ① 任何一次 provider 请求的工具表，在请求发出的那一刻就冻结了 —— 激活只可能出现在
 *     **之后**的请求上。所以「第 0 步（= 本回合第一次生成）里出现检索来的工具」在结构上
 *     不可能发生，与 Alma 里 prepareStep 等到 stepNumber > 0 才动手是同一个效果。
 *  ② Alma 拦步号的理由是「第 0 步还没有任何工具结果，无从判断搜索意图」—— 它必须在
 *     prepareStep 里替模型猜要不要搜。dove 的意图来自**模型给的 query 本身**，所以等价物
 *     是「没有关键词就不搜」（见下面空 query 的处理），而不是「第一步不许搜」。
 *  为什么不能照抄步号门：用户第一句就可能是「给我开个常驻终端」，模型在本回合第一步检索
 *  正是**正确行为**；按步号硬拦会让这个能力在第一轮完全不可达 —— 那是把 harness 侧的
 *  约束错当成模型侧的禁令。
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

    // 无从判断搜索意图 → 不执行搜索（Alma 清单 A① 的语义内核）。
    // ⚠️ 空/纯空白 query 必须在这里拦掉：registry.searchTools("") 的兜底是
    //    「返回按需工具的前 limit 个」，也就是**盲激活 5 个不相关的工具**。
    //    激活是进程级且不回收的（registry 的 activated 是全局 Set），一次盲检索
    //    会让这些工具此后一直挂在**所有线程**的 wire 上（多烧 token，还可能让模型
    //    以为自己有它其实用不了的能力）。关键词都没有就别猜，直接说出来。
    if (query.trim().length === 0) {
      ctx.emit("tool:activated", { toolCallId: ctx.toolCallId, query, activated: [] });
      return {
        query,
        matches: [],
        activated: [],
        total_on_demand: reg.onDemandTools().length,
        note: "query 是空的，没有关键词就判断不了该激活什么 —— 本次**没有激活任何工具**。" +
          "换一个具体关键词再检索（如「网页抓取」「终端」「定时任务」）。",
      };
    }

    const matches = reg.searchTools(query, limit);
    const activated = reg.activateTools(matches.map((t) => t.name));
    ctx.emit("tool:activated", { toolCallId: ctx.toolCallId, query, activated });

    // ⚠️ activated 为空但 matches 非空是**正常路径**，不是失败：检索是进程级的，
    //    第二次搜同一批工具时 activateTools 会全部跳过（返回 []）。原来这里只有
    //    「本次激活了：」一种措辞，于是这种情况下模型读到的是
    //    「已激活：。现在可以直接调用它们。」—— 一个空名单 +一句空承诺。
    //    模型据此以为激活失败，会反复换关键词重搜（每次搜索都是一次完整往返）。
    const note = matches.length === 0
      ? "没有匹配的工具。可换关键词，或直接看常驻工具里有没有能用的。"
      : activated.length === 0
        ? "命中的工具**本来就已经在你的工具表里**了（本次没有新增）：" +
          matches.map((t) => t.name).join("、") + "。可以直接调用，不用再搜。"
        : "已激活：" + activated.join("、") + "。现在可以直接调用它们。";

    return {
      query,
      matches: matches.map((t) => ({ name: t.name, description: t.description.slice(0, 200) })),
      activated,
      total_on_demand: reg.onDemandTools().length,
      note,
    };
  }),
});
