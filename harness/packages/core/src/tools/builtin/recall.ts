/**
 * Recall —— 记忆检索（常驻）
 * 定位（写进 description，避免模型误判）：自动注入的「相关记忆」只是切片，
 * Recall 是补充通道；它返回的同样是**命中的若干条**，不是全部记忆。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str, optNum } from "./util.ts";

const DEFAULT_LIMIT = 5;

export const RecallTool = defineTool({
  name: "Recall",
  description:
    "在长期记忆里检索（用户偏好、项目决策、过往反馈等）。当自动注入的记忆切片不够用时用它补充。" +
    "特别注意：返回的只是**命中的若干条**，不是你的全部记忆，也可能漏掉相关的东西——不要据此断言「没有相关记忆」。",
  parameters: S.obj({
    query: S.str("检索问题或关键词（用自然语言描述你要找什么）"),
    limit: S.num("最多返回几条（默认 " + DEFAULT_LIMIT + "）"),
  }, ["query"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const query = str(input, "query");
    const limit = Math.max(1, Math.min(50, Math.floor(optNum(input, "limit") ?? DEFAULT_LIMIT)));
    const svc = ctx.services?.recall;
    if (!svc) {
      return {
        query,
        found: 0,
        memories: [],
        error: "RECALL_UNAVAILABLE",
        note: "记忆服务未接入（ctx.services.recall 为空），本次没有检索到任何东西，也不代表没有记忆。",
      };
    }

    const memories = await svc(query, limit);
    const list = (memories ?? []).map((m) => ({
      content: m.content,
      score: Number(m.score?.toFixed?.(4) ?? m.score),
      createdAt: m.createdAt,
    }));

    // 第二条通道：屏幕记忆（截图 OCR 的历史）
    const screenHits = (ctx.services?.searchScreen?.(query, Math.min(limit, 5)) ?? []).map((h) => ({
      seenAt: new Date(h.at).toISOString(),
      app: h.appName ?? null,
      window: h.windowTitle ?? null,
      matched: h.matched,
      excerpt: (h.text ?? "").replace(/\s+/g, " ").slice(0, 400),
      score: Number(h.score.toFixed(3)),
    }));

    ctx.emit("tool:memory-recalled", {
      toolCallId: ctx.toolCallId, query, found: list.length, screenFound: screenHits.length,
    });
    return {
      query,
      found: list.length,
      memories: list,
      screenFound: screenHits.length,
      screenMemories: screenHits,
      note:
        "longTerm 是沉淀下来的长期记忆，screen 是「你在屏幕上看到过的内容」（截图 OCR）。" +
        "两者都只是**命中若干条**，不是全部 —— 不要据此断言「没有相关记忆」。",
    };
  }),
});
