/**
 * 模型展示名与用量归一化（与后端 model_pricing.py / agent_stats.py 对应）。
 *
 * 后端 usage 结构经历了一次演进：
 *   · 旧：只有 sonnet / opus 两个 Claude 档位桶
 *   · 新：models + breakdown（按真实模型 id 计费），同时保留 sonnet/opus 兼容字段
 * 这里把两种形态统一成 ModelUsageEntry[]，UI 只认这一种。
 */

export interface ModelUsageEntry {
  model: string;
  display: string;
  provider?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost: number;
  pricing_found: boolean;
}

export interface UsageLike {
  model?: string;
  models?: string[];
  model_display?: string | null;
  model_escalated?: boolean;
  pricing_found?: boolean;
  total_cost?: number;
  breakdown?: Array<Partial<ModelUsageEntry> & { model: string; raw_model?: string }>;
  sonnet?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    cost?: number;
  };
  opus?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    cost?: number;
  };
}

/** 已知模型的展示名（key 与后端 model_pricing.REGISTRY 对齐） */
const DISPLAY_NAMES: Record<string, string> = {
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-reasoner": "DeepSeek Reasoner",
  "claude-opus-4.5": "Claude Opus 4.5",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "gpt-5": "GPT-5",
  "gpt-5-mini": "GPT-5 mini",
  "gpt-4o": "GPT-4o",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  unknown: "未知模型",
  // 历史 wire 值：sonnet / opus 只是"基础档 / 升级档"的旧字段名，
  // 当前两档实际对应 deepseek-flash / deepseek-v4-pro（见 python/agent_stats.py 注释）
  sonnet: "DeepSeek V4.1 Flash",
  opus: "DeepSeek V4 Pro",
  混合: "混合模型",
  mixed: "混合模型",
};

export function modelDisplay(id?: string | null): string {
  if (!id) return "未知模型";
  return DISPLAY_NAMES[id] ?? id;
}

function entry(
  model: string,
  display: string,
  tokens: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number },
  cost: number,
  provider?: string,
  pricingFound = true
): ModelUsageEntry {
  return {
    model,
    display,
    provider,
    input_tokens: tokens.input_tokens ?? 0,
    output_tokens: tokens.output_tokens ?? 0,
    cache_read_tokens: tokens.cache_read_tokens ?? 0,
    cache_creation_tokens: tokens.cache_creation_tokens ?? 0,
    cost,
    pricing_found: pricingFound,
  };
}

const hasTokens = (e: ModelUsageEntry) =>
  e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_creation_tokens > 0;

/** 把任意版本的 usage 归一化成「按模型」的条目列表。 */
export function usageEntries(usage?: UsageLike | null): ModelUsageEntry[] {
  if (!usage) return [];

  // 新格式：后端已按模型聚合
  if (usage.breakdown?.length) {
    return usage.breakdown
      .map((item) =>
        entry(
          item.model,
          item.display ?? modelDisplay(item.model),
          item,
          item.cost ?? 0,
          item.provider,
          item.pricing_found ?? true
        )
      )
      .filter(hasTokens);
  }

  // 旧格式：只有 sonnet / opus 两桶。
  // 注意：这两个键是历史 wire 名，语义是「基础档 / 升级档」，
  // 当前对应 deepseek-flash / deepseek-v4-pro，因此按档位名展示而不是 Claude。
  const legacy: ModelUsageEntry[] = [];
  const label = usage.model ?? "sonnet";
  const single = label !== "混合" && label !== "mixed";
  if (usage.sonnet && (!single || label === "sonnet")) {
    legacy.push(entry("deepseek-flash", "DeepSeek V4.1 Flash", usage.sonnet, usage.sonnet.cost ?? 0, "deepseek"));
  }
  if (usage.opus && (!single || label === "opus")) {
    legacy.push(entry("deepseek-v4-pro", "DeepSeek V4 Pro", usage.opus, usage.opus.cost ?? 0, "deepseek"));
  }
  const filtered = legacy.filter(hasTokens);
  if (filtered.length) return filtered;

  // 兜底：只有总额，没有明细
  if (usage.total_cost) {
    return [entry(label, modelDisplay(label), {}, usage.total_cost, undefined, false)];
  }
  return [];
}

export function totalTokens(entries: ModelUsageEntry[]): number {
  return entries.reduce(
    (sum, e) => sum + e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_creation_tokens,
    0
  );
}

/** 金额格式化：小额多给两位，避免全是 $0.0000 */
export function formatCost(value: number): string {
  if (!value) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

/** 把多条消息的用量按模型汇总（用于顶部总花费的明细）。 */
export function aggregateByModel(usages: Array<UsageLike | undefined>): ModelUsageEntry[] {
  const map = new Map<string, ModelUsageEntry>();
  for (const usage of usages) {
    for (const e of usageEntries(usage)) {
      const current = map.get(e.model);
      if (!current) {
        map.set(e.model, { ...e });
        continue;
      }
      current.input_tokens += e.input_tokens;
      current.output_tokens += e.output_tokens;
      current.cache_read_tokens += e.cache_read_tokens;
      current.cache_creation_tokens += e.cache_creation_tokens;
      current.cost = Number((current.cost + e.cost).toFixed(6));
      current.pricing_found = current.pricing_found && e.pricing_found;
    }
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}
