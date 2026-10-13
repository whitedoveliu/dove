/**
 * 用量桶映射与缓存命中率口径（Fix 1 回归）
 *
 * 契约：prompt 侧的三个桶**互不相交** —— inputTokens = 未命中部分、cacheReadTokens = 命中部分、
 *       cacheWriteTokens = 写缓存部分，计费 prompt = 三者之和。
 * DeepSeek / OpenAI 兼容的 usage.prompt_tokens **已经包含**命中缓存的 token，
 * 所以 inputTokens 直接取 prompt_tokens 就等于把命中数数了两遍：命中率分母变成
 * (prompt + hit)，真实 80% 会显示成 44%，而且越命中越"亏"。
 *
 * 这里走的是真实的 provider.stream（SSE 解析那一整段），只把 globalThis.fetch 换成桩 ——
 * 不联网、不起端口、不碰真实 provider。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenAICompatProvider } from "../src/providers/openai-compat.ts";
import { cacheMetrics } from "../src/context/assemble.ts";

/**
 * 用一段脚本化的 SSE 跑一次真实 stream()，返回 usage。
 * 形态照抄 DeepSeek 的流：正文在 choices 的 delta 里，usage 在**最后一个 chunk**（choices 为空）。
 */
async function usageFrom(usageJson: string) {
  const real = globalThis.fetch;
  const body = [
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    "data: " + JSON.stringify({ choices: [], usage: JSON.parse(usageJson) as unknown }),
    "data: [DONE]",
    "",
  ].join("\n\n");
  globalThis.fetch = (async () => new Response(body, {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as unknown as typeof fetch;
  try {
    const p = new OpenAICompatProvider({ id: "stub", baseUrl: "http://stub.invalid/v1", apiKey: "test" });
    const r = await p.stream({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] });
    return r.usage;
  } finally {
    globalThis.fetch = real;
  }
}

test("用量：prompt_tokens 已含命中，inputTokens 必须只算未命中（三个桶互不相交）", async () => {
  // DeepSeek 形状：prompt 1000 = 命中 800 + 未命中 200
  const u = await usageFrom(
    '{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050,"prompt_cache_hit_tokens":800,"prompt_cache_miss_tokens":200}',
  );
  assert.equal(u.inputTokens, 200, "inputTokens 是**未命中**的部分，不是 prompt_tokens");
  assert.equal(u.cacheReadTokens, 800);
  assert.equal(u.cacheWriteTokens, 0);
  assert.equal(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens, 1000, "三桶之和 = 计费 prompt");
  assert.equal(cacheMetrics(u).cacheHitRate, 0.8, "命中率 = 800 / (200+800)");

  // 只给命中、不给未命中：自己减出来（老网关常见）
  const derived = await usageFrom('{"prompt_tokens":1000,"completion_tokens":50,"prompt_cache_hit_tokens":800}');
  assert.equal(derived.inputTokens, 200);
  assert.equal(derived.cacheReadTokens, 800);

  // OpenAI 形状：命中藏在 prompt_tokens_details.cached_tokens 里
  const openai = await usageFrom('{"prompt_tokens":500,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":400}}');
  assert.equal(openai.inputTokens, 100);
  assert.equal(openai.cacheReadTokens, 400);

  // 有写入桶的网关（Anthropic 形状）：写入也要单独记，不能并进 inputTokens
  const written = await usageFrom(
    '{"prompt_tokens":1000,"completion_tokens":10,"prompt_cache_hit_tokens":800,"prompt_cache_write_tokens":100}',
  );
  assert.equal(written.inputTokens, 200);
  assert.equal(written.cacheWriteTokens, 100);
  assert.equal(written.inputTokens + written.cacheReadTokens + written.cacheWriteTokens, 1100, "计费 prompt = 三桶之和");
});

test("用量：命中率的分母是三个桶之和（旧口径会把命中数两遍）", async () => {
  const metrics = cacheMetrics({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 });
  assert.equal(metrics.cacheHitRate, 0.8);
  // 旧口径：input 里含命中时 800/(1000+800) = 0.444 —— 这条断言钉死「分母不许回退到 input + cacheRead」
  assert.notEqual(metrics.cacheHitRate, 800 / (1000 + 800));

  const withWrite = cacheMetrics({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 200 });
  assert.equal(withWrite.cacheHitRate, 0.6666666666666666, "写入桶也要进分母");
  assert.equal(cacheMetrics({ inputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }).cacheHitRate, 0, "没有 prompt 侧用量时不除以 0");
});
