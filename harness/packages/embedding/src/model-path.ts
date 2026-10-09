/** 模型放哪、要下哪些文件 —— 下载脚本和运行时共用这一份定义 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 默认模型：中文场景性价比最高（int8 只 22.9MB，512 维） */
export const DEFAULT_MODEL = "Xenova/bge-small-zh-v1.5";

/** 离线运行必需的文件（其余 fp16/fp32/bnb4 变体都不下） */
export const MODEL_FILES = [
  "onnx/model_quantized.onnx",
  "vocab.txt",
  "config.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
] as const;

/** huggingface.co 在部分网络不可达，默认走镜像；可用 DOVE_HF_ENDPOINT 覆盖 */
export const DEFAULT_HF_ENDPOINT = "https://hf-mirror.com";

export function modelsRoot(): string {
  return process.env.DOVE_MODELS_DIR ?? join(homedir(), ".dove", "models");
}

export function resolveModelDir(model: string = DEFAULT_MODEL): string {
  return join(modelsRoot(), model);
}

/** 模型是否已经下全 */
export function isModelReady(model: string = DEFAULT_MODEL): boolean {
  const dir = resolveModelDir(model);
  return existsSync(join(dir, "onnx", "model_quantized.onnx")) && existsSync(join(dir, "vocab.txt"));
}
