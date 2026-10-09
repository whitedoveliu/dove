/**
 * OpenAI 兼容 provider（DeepSeek 走这条路）
 * 手写 SSE 解析：完全控制 tool_call 增量的 index 归并、reasoning 字段、usage 统计。
 */
import type { Provider, StreamOptions, StreamResult, StreamUsage, ToolCallPayload } from "./types.ts";

interface DeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface Chunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: DeltaToolCall[] };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

export interface OpenAICompatOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  /** 附加请求头 */
  headers?: Record<string, string>;
  /** 是否把 reasoning_effort 传上去 */
  supportsReasoning?: boolean;
}

export class OpenAICompatProvider implements Provider {
  id: string;
  #baseUrl: string;
  #apiKey: string;
  #headers: Record<string, string>;
  #supportsReasoning: boolean;

  constructor(o: OpenAICompatOptions) {
    this.id = o.id;
    this.#baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.#apiKey = o.apiKey;
    this.#headers = o.headers ?? {};
    this.#supportsReasoning = o.supportsReasoning ?? false;
  }

  async stream(opts: StreamOptions): Promise<StreamResult> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? "auto";
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (this.#supportsReasoning && opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;

    const res = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#apiKey}`, ...this.#headers },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      return {
        text: "", reasoning: "", toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        finishReason: "error", error: `HTTP ${res.status}: ${txt.slice(0, 500)}`,
      };
    }

    let text = "";
    let reasoning = "";
    let finishReason = "stop";
    const toolAcc = new Map<number, ToolCallPayload>();
    let usage: StreamUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: Chunk;
        try { chunk = JSON.parse(payload) as Chunk; } catch { continue; }

        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cacheReadTokens: chunk.usage.prompt_cache_hit_tokens ?? chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
          };
        }

        const ch = chunk.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finishReason = ch.finish_reason;

        const d = ch.delta;
        if (!d) continue;

        const rc = d.reasoning_content ?? d.reasoning;
        if (rc) { reasoning += rc; opts.onReasoningDelta?.(rc); }
        if (d.content) { text += d.content; opts.onTextDelta?.(d.content); }

        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          let acc = toolAcc.get(idx);
          if (!acc) { acc = { id: tc.id ?? `call_${idx}_${Date.now()}`, type: "function", function: { name: "", arguments: "" } }; toolAcc.set(idx, acc); }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.function.name += tc.function.name;
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        }
      }
    }

    opts.onUsage?.(usage);
    return { text, reasoning, toolCalls: [...toolAcc.values()].filter((t) => t.function.name), usage, finishReason };
  }
}
