/**
 * @dove/embedding —— 本地 ONNX 文本向量
 *
 * **这是整个仓库唯一带 npm 依赖的包**，刻意隔离出来：
 * packages/core 只认 EmbeddingProvider 接口，永远零依赖；
 * 装不上 onnxruntime-node（或没下模型）时，core 自动降级到 hash 向量，功能不中断。
 */
export { WordPieceTokenizer } from "./tokenizer.ts";
export type { EncodeResult } from "./tokenizer.ts";
export { createOnnxEmbedding } from "./onnx.ts";
export type { OnnxEmbeddingOptions } from "./onnx.ts";
export type { EmbeddingProvider } from "./types.ts";
export {
  resolveModelDir, isModelReady, modelsRoot,
  MODEL_FILES, DEFAULT_MODEL, DEFAULT_HF_ENDPOINT,
} from "./model-path.ts";
