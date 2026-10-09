/**
 * ONNX 文本向量推理（BGE 系列）
 *
 * 依赖只有一个：onnxruntime-node。**不用 transformers.js** ——
 * 它会连带拖下 onnxruntime-web(90MB) 和 sharp(17MB)，而纯文本 Node 推理
 * 这两个完全用不上。分词器自己写（tokenizer.ts）。
 *
 * BGE 的池化方式是 **CLS token**（取 last_hidden_state 的第 0 个位置），再 L2 归一化。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WordPieceTokenizer } from "./tokenizer.ts";
import type { EmbeddingProvider } from "./types.ts";

/** onnxruntime-node 是可选依赖：没装时这里会返回 null，由调用方降级 */
type Ort = {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => unknown;
};
interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
}

async function loadOrt(): Promise<Ort | null> {
  try {
    // 用变量绕开打包器/类型检查对可选依赖的静态解析
    const name = "onnxruntime-" + "node";
    return (await import(name)) as unknown as Ort;
  } catch { return null; }
}

export interface OnnxEmbeddingOptions {
  /** 模型目录，需含 model_quantized.onnx（或 model.onnx）与 vocab.txt */
  modelDir: string;
  /** 显式给 provider id；缺省按目录名推断 */
  id?: string;
  maxLen?: number;
  batchSize?: number;
  /** 池化方式：cls（BGE 默认）| mean */
  pooling?: "cls" | "mean";
}

/**
 * 找模型权重文件。
 * ⚠️ HF 仓库的权重在 **onnx/ 子目录**下（不是仓库根），这里必须带上那一层 ——
 *    少写一层会导致「模型明明下载了却加载不了」，而且不报错、只是静默降级。
 */
function pickModelFile(dir: string): string | null {
  for (const f of ["model_quantized.onnx", "model_int8.onnx", "model_uint8.onnx", "model.onnx", "model_fp16.onnx"]) {
    for (const sub of ["onnx", ""]) {
      const p = sub ? join(dir, sub, f) : join(dir, f);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 创建 ONNX provider。
 * **不可用时返回 null**（而不是抛）—— 调用方据此降级到 hash 向量，
 * 保证「没有模型也能跑」这条底线不被破坏。
 */
export async function createOnnxEmbedding(opts: OnnxEmbeddingOptions): Promise<EmbeddingProvider | null> {
  const ort = await loadOrt();
  if (process.env.DOVE_EMBED_DEBUG) console.log("[onnx] loadOrt:", ort ? "ok" : "FAILED");
  if (!ort) return null;
  const modelPath = pickModelFile(opts.modelDir);
  const vocabPath = join(opts.modelDir, "vocab.txt");
  if (process.env.DOVE_EMBED_DEBUG) console.log("[onnx] model:", modelPath, "| vocab:", existsSync(vocabPath));
  if (!modelPath || !existsSync(vocabPath)) return null;

  let session: OrtSession;
  try { session = await ort.InferenceSession.create(modelPath); }
  catch (e) {
    if (process.env.DOVE_EMBED_DEBUG) console.log("[onnx] session 创建失败:", e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300));
    return null;
  }

  const maxLen = opts.maxLen ?? 512;
  const tokenizer = new WordPieceTokenizer(
    WordPieceTokenizer.fromVocabFile(vocabPath, { maxLen }).vocabMap, { maxLen },
  );
  const batchSize = Math.max(1, opts.batchSize ?? 16);
  const pooling = opts.pooling ?? "cls";
  let dim = 0;

  const runBatch = async (texts: string[]): Promise<number[][]> => {
    const enc = tokenizer.encodeBatch(texts, maxLen);
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(enc.inputIds.flat().map(BigInt)), [texts.length, enc.inputIds[0]!.length]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(enc.attentionMask.flat().map(BigInt)), [texts.length, enc.attentionMask[0]!.length]),
      token_type_ids: new ort.Tensor("int64", BigInt64Array.from(enc.tokenTypeIds.flat().map(BigInt)), [texts.length, enc.tokenTypeIds[0]!.length]),
    };
    const out = await session.run(feeds);
    const hidden = out[session.outputNames[0]!]!;
    const [, seq, d] = hidden.dims as [number, number, number];
    dim = d;
    const rows: number[][] = [];
    for (let b = 0; b < texts.length; b++) {
      const v = new Array<number>(d).fill(0);
      if (pooling === "cls") {
        for (let k = 0; k < d; k++) v[k] = hidden.data[b * seq * d + k] ?? 0;
      } else {
        let n = 0;
        for (let s = 0; s < seq; s++) {
          if ((enc.attentionMask[b]![s] ?? 0) === 0) continue;
          n++;
          for (let k = 0; k < d; k++) v[k] += hidden.data[(b * seq + s) * d + k] ?? 0;
        }
        if (n > 0) for (let k = 0; k < d; k++) v[k] /= n;
      }
      rows.push(v);
    }
    return rows;
  };

  const provider: EmbeddingProvider = {
    id: opts.id ?? `onnx:${opts.modelDir.split("/").filter(Boolean).pop() ?? "model"}`,
    get dim(): number { return dim || 512; },
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        out.push(...(await runBatch(texts.slice(i, i + batchSize))));
      }
      // BGE 要求 L2 归一化后再算余弦
      for (const v of out) {
        let sum = 0;
        for (const x of v) sum += x * x;
        if (sum > 0) { const inv = 1 / Math.sqrt(sum); for (let k = 0; k < v.length; k++) v[k] = v[k]! * inv; }
      }
      return out;
    },
  };
  return provider;
}
