/**
 * Provider 注册表 + 模型清单
 */
import { OpenAICompatProvider } from "./openai-compat.ts";
import type { Provider } from "./types.ts";

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow: number;
  maxOutput: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
}

export const MODELS: ModelInfo[] = [
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", contextWindow: 1_048_576, maxOutput: 65_536, supportsImages: true, supportsReasoning: true },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_048_576, maxOutput: 65_536, supportsImages: false, supportsReasoning: true },
];

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  /** 工具模型（用于审批分类器 / 记忆抽取 / 查询改写） */
  toolModel?: string;
}

let cached: Provider | null = null;
let cachedKey = "";

export function getProvider(cfg: ProviderConfig): Provider {
  const key = cfg.baseUrl + "|" + cfg.apiKey;
  if (!cached || cachedKey !== key) {
    cached = new OpenAICompatProvider({
      id: "deepseek",
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      supportsReasoning: true,
    });
    cachedKey = key;
  }
  return cached;
}

export function getModelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

export type { Provider, StreamOptions, StreamResult, StreamUsage, ChatMessage, ToolSchema, ToolCallPayload, ContentBlock } from "./types.ts";
export { EmptyStreamError } from "./types.ts";
