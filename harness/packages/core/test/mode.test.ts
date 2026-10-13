/**
 * 每轮模式（mode）测试：面板的 Swarm 开关到底把什么东西送上了 wire。
 *
 * 这里盯的是**契约的形状**，不是"功能大概能用"：
 *  ① swarm 轮的指令必须是**独立的一条 role:"user" 消息**，被 `<system-reminder>` 包住；
 *  ② 用户自己那句话在 wire 上**逐字节不变**（面板只在 body 里带 mode，不碰 message）；
 *  ③ 一轮只注入一次（不是每个 step 一次），且落库记录带 origin / variant；
 *  ④ 不带 mode 的请求，wire 与注入功能出现之前**完全一致**。
 *
 * 用真实 Store + 真实 runtime（只有 provider 是桩），所以断言的是真实装配结果，
 * 不是某个纯函数的返回值。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { EventLog } from "../src/session/event-log.ts";
import { PendingRegistry } from "../src/agent/pending.ts";
import { SteeringQueue } from "../src/loop/steering.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { allTools } from "../src/tools/registry.ts";
import { loadPrompt } from "../src/context/segments.ts";
import { TURN_MODES, isTurnMode, INJECTION_ORIGIN, SWARM_MODE_VARIANT } from "../src/agent/mode-injection.ts";
import type { Tool, Tool as ToolType } from "../src/tools/types.ts";
import type { ChatMessage, Provider, StreamOptions, StreamResult } from "../src/providers/types.ts";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 三步的**一轮**（Read → AttemptCompletion → 收尾）：证明「一轮注入一次」而不是「一步一次」 */
function multiStepProvider(wires: ChatMessage[][], file: string): Provider {
  let call = 0;
  return {
    id: "stub-mode",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      wires.push(opts.messages);
      call++;
      if (call === 1) {
        return {
          text: "", reasoning: "", usage: { ...usage }, finishReason: "tool_calls",
          toolCalls: [{ id: "call_read", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: file }) } }],
        };
      }
      if (call === 2) {
        return {
          text: "", reasoning: "", usage: { ...usage }, finishReason: "tool_calls",
          toolCalls: [{ id: "call_done", type: "function", function: { name: "AttemptCompletion", arguments: JSON.stringify({ summary: "做完了" }) } }],
        };
      }
      // 第三步收尾：调用过 AttemptCompletion 的一轮不再触发完成守卫（闸门②），
      // 于是整轮干净地结束 —— 后面的断言就不会被闸门的 system-reminder 干扰。
      return { text: "好", reasoning: "", toolCalls: [], usage: { ...usage }, finishReason: "stop" };
    },
  };
}

function harness(threadId: string, wires: ChatMessage[][], tailContext = "") {
  const file = join(mkdtempSync(join(tmpdir(), "dove-mode-file-")), "note.txt");
  writeFileSync(file, "测试内容");
  const db = new Db(":memory:");
  const store = new Store(db);
  store.createThread({ id: threadId, kind: "project", title: "模式" });
  const runtime = new AgentRuntime({
    provider: multiStepProvider(wires, file), store,
    tools: new Map<string, Tool>(allTools().map((t) => [t.name, t as ToolType])),
    eventLog: new EventLog({ dir: mkdtempSync(join(tmpdir(), "dove-mode-log-")) }),
    pending: new PendingRegistry(), steering: new SteeringQueue(),
    assemble: async () => ({ systemPrompt: "测试系统提示词", tailContext, memoriesBlock: "", dualSystem: false }),
  });
  return { runtime, store, db };
}

const USER_TEXT = "帮我把这三个页面的配色统一一下";
const userMessages = (wire: ChatMessage[]): ChatMessage[] => wire.filter((m) => m.role === "user");

test("每轮模式：swarm 的指令是独立消息，用户原话逐字节不变，且一轮只注入一次", async () => {
  const wires: ChatMessage[][] = [];
  const { runtime, store, db } = harness("th_swarm", wires);
  await runtime.run({ threadId: "th_swarm", userText: USER_TEXT, sink: () => { /* 忽略 */ }, mode: "swarm" });

  // 这一轮真的走了三步（三次 provider 调用 = 三次 wire）
  assert.equal(wires.length, 3, "桩 provider 应该被调用三步");

  const body = (await loadPrompt("swarm-mode")).trim();
  const expected = `<system-reminder>\n${body}\n</system-reminder>`;

  for (const wire of wires) {
    const users = userMessages(wire);
    assert.equal(users.length, 2, "wire 上应该恰好有：注入 + 用户各一条");
    // ① 独立消息：内容逐字节 = <system-reminder> + 提示词资产正文 + </system-reminder>
    assert.equal(users[0]!.content, expected);
    // ② 用户原话逐字节不变（tailContext 为空时就是原文本身，没有任何前缀/后缀）
    assert.equal(users[1]!.content, USER_TEXT);
    // 不多不少：整个 wire 里只有那一条注入（三步各自的一份，内容完全相同）
    assert.equal(
      wire.filter((m) => typeof m.content === "string" && m.content === expected).length, 1,
      "每个 step 的 wire 只能有一条注入消息",
    );
  }

  // ③ 落库：注入记录带 origin / variant，模型回放时照样看得到（顺序在用户消息之前）
  const persisted = store.listMessages("th_swarm");
  const injections = persisted.filter((m) => m.origin === INJECTION_ORIGIN);
  assert.equal(injections.length, 1, "一轮只能落一条注入记录");
  assert.equal(injections[0]!.variant, SWARM_MODE_VARIANT);
  assert.equal(injections[0]!.role, "user");
  assert.equal(injections[0]!.parts[0] && (injections[0]!.parts[0] as { text: string }).text, expected);
  const order = persisted.map((m) => (m.origin === INJECTION_ORIGIN ? "injection" : m.role));
  assert.deepEqual(order, ["injection", "user", "assistant"], "注入必须排在用户消息之前");
  db.close();
});

test("每轮模式：尾上下文仍贴在用户那条消息上，不沾注入那条", async () => {
  const wires: ChatMessage[][] = [];
  const { runtime, db } = harness("th_tail", wires, "测试锚");
  await runtime.run({ threadId: "th_tail", userText: USER_TEXT, sink: () => { /* 忽略 */ }, mode: "swarm" });

  const users = userMessages(wires[0]!);
  assert.equal(users[1]!.content, `[Context: 测试锚]\n\n${USER_TEXT}`, "尾部上下文照旧 prepend 到用户消息");
  const injected = String(users[0]!.content);
  assert.ok(injected.startsWith("<system-reminder>\n") && injected.endsWith("\n</system-reminder>"));
  assert.ok(!injected.includes("[Context:"), "注入的那条不该被尾上下文污染");
  db.close();
});

test("每轮模式：不带 mode 时 wire 与之前完全一致（没有注入）", async () => {
  const wires: ChatMessage[][] = [];
  const { runtime, store, db } = harness("th_plain", wires);
  await runtime.run({ threadId: "th_plain", userText: USER_TEXT, sink: () => { /* 忽略 */ } });

  // 针：提示词资产的前 20 个字。整轮 wire 里一次都不该出现（闸门的 system-reminder 不算数）
  const needle = (await loadPrompt("swarm-mode")).trim().slice(0, 20);
  for (const wire of wires) {
    assert.ok(!wire.some((m) => String(m.content).includes(needle)), "没有 mode 就不该出现模式指令");
    assert.equal(userMessages(wire).filter((m) => m.content === USER_TEXT).length, 1);
  }
  assert.deepEqual(store.listMessages("th_plain").map((m) => m.role), ["user", "assistant"]);
  assert.equal(store.listMessages("th_plain").filter((m) => m.origin).length, 0);
  db.close();
});

test("每轮模式：plan / goal 只接受取值、一条都不注入", async () => {
  const needle = (await loadPrompt("swarm-mode")).trim().slice(0, 20);
  for (const mode of ["plan", "goal"] as const) {
    const wires: ChatMessage[][] = [];
    const { runtime, store, db } = harness("th_" + mode, wires);
    await runtime.run({ threadId: "th_" + mode, userText: USER_TEXT, sink: () => { /* 忽略 */ }, mode });
    assert.ok(!wires[0]!.some((m) => String(m.content).includes(needle)), mode + " 不该注入模式消息");
    assert.equal(store.listMessages("th_" + mode).filter((m) => m.origin).length, 0, mode + " 不该落注入记录");
    db.close();
  }
});

test("每轮模式：取值只认 plan / goal / swarm（别的值由路由回 400）", () => {
  assert.deepEqual([...TURN_MODES], ["plan", "goal", "swarm"]);
  for (const v of TURN_MODES) assert.equal(isTurnMode(v), true);
  for (const v of ["swarms", "Swarm", "", "ask", 1, null, undefined, {}]) assert.equal(isTurnMode(v), false);
});
