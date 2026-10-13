/**
 * 压缩落库的**端到端**验证（store → runtime 装配 → provider 看到的 wire）
 *
 * 为什么需要它：`compaction-persist.test.ts` 测的是 store 那一侧（能不能存、能不能按检查点取历史），
 * 但「runtime 真的用了它」是接线，接线不测就等于没接 —— 而这个仓库栽过好几次「建好没接」。
 * 这里用一个注入的假 `compact` 强制走一次压缩，然后断言两件事：
 *   ① 检查点真的落库了，且**剥掉了本轮在飞的段**（否则下一轮会把这一轮重发一遍）；
 *   ② 下一轮 provider 看到的 wire 以检查点前缀开头，且上一轮的答复只出现**一次**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { EventLog } from "../src/session/event-log.ts";
import { PendingRegistry } from "../src/agent/pending.ts";
import { SteeringQueue } from "../src/loop/steering.ts";
import { AgentRuntime, type AgentServices } from "../src/agent/runtime.ts";
import { allTools } from "../src/tools/registry.ts";
import type { Provider, StreamResult, StreamOptions, ChatMessage } from "../src/providers/types.ts";
import type { Tool } from "../src/tools/types.ts";

const TEMP = mkdtempSync(join(tmpdir(), "dove-cpe2e-"));
const usage = () => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
const flat = (msgs: ChatMessage[]): string => msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");

/** 假 provider：第 1 步调个工具（为了让回合至少走到第 2 步、给压缩留出时机），之后给文本 */
function provider(seen: ChatMessage[][], reply: string): Provider {
  let step = 0;
  return {
    id: "cpe2e-stub",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      step++;
      seen.push(opts.messages);
      if (step === 1) {
        return { text: "先查时间", reasoning: "", toolCalls: [{ id: "c_t", type: "function", function: { name: "CurrentTime", arguments: "{}" } }], finishReason: "tool_calls", usage: usage() } as unknown as StreamResult;
      }
      // ⚠️ 第 3 步起换一段**不同**的文本：完成守卫会在没有 AttemptCompletion 时重试，
      //    桩若每次都回同一句，同一段文字会在一条 assistant 行里留下多个 text part ——
      //    那是桩的产物，会把「检查点有没有重复发送」这个信号淹掉。
      const text = step === 2 ? reply : "收尾";
      opts.onTextDelta?.(text);
      return { text, reasoning: "", toolCalls: [], finishReason: "stop", usage: usage() } as unknown as StreamResult;
    },
  } as unknown as Provider;
}

test("压缩落库端到端：检查点进 wire、且在飞的段不被重复发送", async () => {
  const db = new Db(":memory:");
  const store = new Store(db);
  // 塞够 21+ 条历史，让 runtime 的 `msgs.length > 20` 那道门放行
  for (let i = 0; i < 11; i++) {
    store.addMessage({ id: `th--u-${i}`, threadId: "th", role: "user", parts: [{ type: "text", text: `较早的问题 ${i}` }], createdAt: 1_000 + i * 10 } as never);
    store.addMessage({ id: `th--a-${i}`, threadId: "th", role: "assistant", parts: [{ type: "text", text: `较早的回答 ${i}` }], createdAt: 1_005 + i * 10 } as never);
  }
  const th = store.createThread({ id: "th", kind: "project", projectId: null, title: "t" });

  const seen1: ChatMessage[][] = [];
  const runtime = new AgentRuntime({
    provider: provider(seen1, "第一轮答复"),
    store, eventLog: new EventLog({ dir: TEMP }),
    pending: new PendingRegistry(), steering: new SteeringQueue(),
    tools: new Map<string, Tool>(allTools().map((t) => [t.name, t])),
    assemble: async () => ({ systemPrompt: "测试", tailContext: "", memoriesBlock: "", dualSystem: false }),
    // 注入的压缩器：只留「摘要 + 最后一条真实用户消息」，保证本轮就触发一次落库
    compact: async (msgs: ChatMessage[]) => {
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      return [{ role: "user", content: "__COMPACTED__" }, ...(lastUser ? [lastUser] : [])] as ChatMessage[];
    },
  });

  await runtime.run({ threadId: th.id, userText: "本轮的问题", sink: () => { /* 忽略 */ } });

  const cp = store.compactedHistory(th.id);
  assert.ok(cp, "压缩后必须落一条检查点，实际没有 —— 说明压缩仍然只活在轮内");
  const payload = cp!.payload as ChatMessage[];
  const payloadText = flat(payload);
  assert.ok(payloadText.includes("__COMPACTED__"), "检查点里应当有摘要");
  assert.ok(payloadText.includes("本轮的问题"), "检查点必须保住本轮的用户消息（它 createdAt ≤ at，靠 historyForWire 取不回来）");
  assert.ok(!payloadText.includes("第一轮答复"), "本轮在飞的答复不该进检查点（否则下一轮会重发一遍）");

  // 第二轮：provider 看到的 wire 必须以检查点开头，且上一轮答复只出现一次
  const seen2: ChatMessage[][] = [];
  runtime.services.provider = provider(seen2, "第二轮答复");
  await runtime.run({ threadId: th.id, userText: "第二个问题", sink: () => { /* 忽略 */ } });
  const first = flat(seen2[0]!);
  assert.ok(first.includes("__COMPACTED__"), "第二轮的 wire 没有用检查点前缀");
  assert.ok(!first.includes("较早的问题 3"), "被压缩掉的历史不该再出现");
  const hits = first.split("第一轮答复").length - 1;
  assert.ok(hits <= 1, `上一轮的答复出现了 ${hits} 次（应当 ≤1，重复即检查点没剥干净在飞段）`);
});

// ── 同一轮压两次 ────────────────────────────────────────
// 为什么值得单独一条：上面那条只压一次，而「压缩当场落检查点」意味着同一轮里压完还能再压 ——
// 第二次压缩时 `messages` 已经被就地换成压缩结果（变短了），任何按**压缩前**历史长度算出来的
// 下标都会失效，剥不干净在飞段。后果是下一轮的 wire 里同一段出现两遍（重发 + 缓存全废）。

/** 假 provider：前 n 步各调一次工具（同一轮里给压缩留出第二次机会），之后一直给文本 */
function toolSteps(seen: ChatMessage[][], calls: { name: string; args: string }[]): Provider {
  let step = 0;
  return {
    id: "cpe2e-tools",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      step++;
      seen.push(opts.messages);
      const call = calls[step - 1];
      if (call) {
        return { text: "", reasoning: "", toolCalls: [{ id: `c${step}`, type: "function", function: { name: call.name, arguments: call.args } }], finishReason: "tool_calls", usage: usage() } as unknown as StreamResult;
      }
      const text = step === calls.length + 1 ? "收尾" : "还在收尾";
      opts.onTextDelta?.(text);
      return { text, reasoning: "", toolCalls: [], finishReason: "stop", usage: usage() } as unknown as StreamResult;
    },
  } as unknown as Provider;
}

/** 假 provider：只会说文本（第二轮的观察口） */
function textOnly(seen: ChatMessage[][]): Provider {
  return {
    id: "cpe2e-text",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      seen.push(opts.messages);
      opts.onTextDelta?.("收尾");
      return { text: "收尾", reasoning: "", toolCalls: [], finishReason: "stop", usage: usage() } as unknown as StreamResult;
    },
  } as unknown as Provider;
}

/** 22 条历史（11 轮问答）：让 runtime 的 `msgs.length > 20` 那道门放行 */
function seedHistory(store: Store, threadId: string): void {
  for (let i = 0; i < 11; i++) {
    store.addMessage({ id: `${threadId}--u-${i}`, threadId, role: "user", parts: [{ type: "text", text: `较早的问题 ${i}` }], createdAt: 1_000 + i * 10 } as never);
    store.addMessage({ id: `${threadId}--a-${i}`, threadId, role: "assistant", parts: [{ type: "text", text: `较早的回答 ${i}` }], createdAt: 1_005 + i * 10 } as never);
  }
}

/** wire 里每个 toolCallId 出现几条 tool 结果（配对唯一性 = 契约，不是实现细节） */
function toolTally(msgs: ChatMessage[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of msgs) if (m.role === "tool") out[String(m.tool_call_id)] = (out[String(m.tool_call_id)] ?? 0) + 1;
  return out;
}

function runtimeFor(store: Store, p: Provider, compact: AgentServices["compact"]): AgentRuntime {
  return new AgentRuntime({
    provider: p, store, eventLog: new EventLog({ dir: TEMP }),
    pending: new PendingRegistry(), steering: new SteeringQueue(),
    tools: new Map<string, Tool>(allTools().map((t) => [t.name, t])),
    assemble: async () => ({ systemPrompt: "测试", tailContext: "", memoriesBlock: "", dualSystem: false }),
    compact,
  });
}

test("同一轮压两次：检查点与下一轮 wire 里每个 toolCallId 只有一条结果", async () => {
  const db = new Db(":memory:");
  const store = new Store(db);
  seedHistory(store, "th2");
  const th = store.createThread({ id: "th2", kind: "project", projectId: null, title: "t" });

  const seen1: ChatMessage[][] = [];
  let compacts = 0;
  const runtime = runtimeFor(store, toolSteps(seen1, [{ name: "CurrentTime", args: "{}" }, { name: "CurrentTime", args: "{}" }]), async (msgs) => {
    compacts++;
    // 保留尾部（长度仍 > 20）：同一轮的第二道门会再开一次，这正是要覆盖的场景
    return [{ role: "user", content: "__COMPACTED__" }, ...msgs.slice(-21)] as ChatMessage[];
  });
  await runtime.run({ threadId: th.id, userText: "本轮的问题", sink: () => { /* 忽略 */ } });
  assert.ok(compacts >= 2, `这一轮必须真的压了两次才算覆盖到场景（实际 ${compacts} 次）`);

  // ① 检查点里不许有本轮在飞的段（它们回合末才落库，留着 = 下一轮重发一遍）
  const cp = store.compactedHistory(th.id);
  assert.ok(cp, "第二次压缩也必须落检查点");
  const inCp = toolTally(cp!.payload as ChatMessage[]);
  assert.deepEqual(inCp, {}, `本轮在飞的段混进了检查点：${JSON.stringify(inCp)}`);

  // ② 下一轮的 wire 里每个 toolCallId 恰好一条 tool 结果（重复即同一段进了两遍）
  const seen2: ChatMessage[][] = [];
  runtime.services.provider = textOnly(seen2);
  await runtime.run({ threadId: th.id, userText: "第二个问题", sink: () => { /* 忽略 */ } });
  assert.deepEqual(toolTally(seen2[0]!), { c1: 1, c2: 1 },
    "每个 toolCallId 必须恰好一条配对的 tool 结果（>1 = 检查点与重建各发了一遍）");
});

// ── 压缩 + ReadImage 挂图 ───────────────────────────────
// 图为什么会被压缩吃掉：图片消息在**挂载时刻**取 createdAt（回合末才落库），而检查点的 at 更晚 ——
// `historyForWire` 的 `created_at > at` 取不回它；它又是本轮的「在飞段」尾，剥在飞段时一并被剥掉。
// 两边都取不到 = 模型此后每一轮都看不到那张图，而工具结果里写着「图片已经挂进这次对话了」。
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** wire 里出现几次图片块（data URL）—— 0 = 图丢了，2 = 图重复了 */
function imageCount(msgs: ChatMessage[]): number {
  return (JSON.stringify(msgs).match(/data:image\/png/g) ?? []).length;
}

test("压缩 + 挂图：下一轮 wire 里图片还在，而且只有一份", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dove-cpe2e-img-"));
  const png = join(dir, "shot.png");
  writeFileSync(png, PNG_1x1);

  const db = new Db(":memory:");
  const store = new Store(db);
  seedHistory(store, "th3");
  const th = store.createThread({ id: "th3", kind: "project", projectId: null, title: "t" });

  const seen1: ChatMessage[][] = [];
  const runtime = runtimeFor(store, toolSteps(seen1, [{ name: "ReadImage", args: JSON.stringify({ file_path: png }) }]), async (msgs) =>
    [{ role: "user", content: "__COMPACTED__" }, ...msgs.slice(-21)] as ChatMessage[]);
  await runtime.run({ threadId: th.id, userText: "看这张图", sink: () => { /* 忽略 */ } });

  assert.equal(imageCount(seen1[1]!), 1, "下一步就该看到图（挂图的既有语义，不许被压缩改动）");
  const stored = store.listMessages(th.id, 200).filter((m) => m.parts.some((p) => p.type === "image"));
  assert.equal(stored.length, 1, "回合末必须落库（否则下一轮连引用都没有）");

  const seen2: ChatMessage[][] = [];
  runtime.services.provider = textOnly(seen2);
  await runtime.run({ threadId: th.id, userText: "再说说那张图", sink: () => { /* 忽略 */ } });
  assert.equal(imageCount(seen2[0]!), 1, "压缩之后图片仍在模型视野里，且不重复（0 = 被剥掉，2 = 检查点与库各一份）");
});
