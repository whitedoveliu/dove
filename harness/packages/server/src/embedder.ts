/**
 * 选向量后端（从 bootstrap.ts 拆出来，那个文件顶到 400 行了）
 *
 * ① 本地 ONNX（packages/embedding）—— 真语义，离线，模型 24MB。
 *    实测检索正确率 5/5、最小余量 +0.14。
 *    对照：hash-1024 是 4/5、最小余量 -0.007（基本靠字面重合蒙）；
 *          macOS NLEmbedding 是 3/5（把「我用什么前端框架」匹配到「每天早上九点开会」）。
 * ② 降级 hash-1024 —— 没装 onnxruntime-node 或没下模型时用。
 *    零依赖、离线，但**只认字面重合**（「用户喜欢暖色调」↔「她偏爱偏暖的配色」只有 0.066）。
 *
 * 注意：换后端后 memories.embedding_model 会变，检索按 model 隔离，
 * 旧向量不会被污染 —— 但也不会被复用，需要重算。
 */
import type { EmbeddingProvider } from "../../core/src/memory/embedding.ts";

export interface ResolvedEmbedder {
  provider: EmbeddingProvider;
  id: string;
  note?: string;
}

export async function resolveEmbedder(): Promise<ResolvedEmbedder> {
  const { createHashEmbedding } = await import("../../core/src/memory/embedding.ts");
  const fallback = (note: string): ResolvedEmbedder => ({
    provider: createHashEmbedding(), id: "hash-" + 1024, note,
  });

  if (process.env.DOVE_EMBEDDING === "off") return fallback("已用 DOVE_EMBEDDING=off 关闭");

  try {
    const emb = await import("../../embedding/src/index.ts");
    const model = process.env.DOVE_EMBED_MODEL ?? emb.DEFAULT_MODEL;
    if (!emb.isModelReady(model)) {
      return fallback(`未下载模型 —— 跑 node --no-warnings packages/embedding/scripts/fetch-model.mjs`);
    }
    const p = await emb.createOnnxEmbedding({ modelDir: emb.resolveModelDir(model) });
    if (!p) return fallback("onnxruntime-node 不可用（可能在 packages/embedding 里没装）");
    return { provider: p, id: p.id };
  } catch (e) {
    return fallback("ONNX 加载失败: " + (e instanceof Error ? e.message.slice(0, 80) : String(e)));
  }
}
