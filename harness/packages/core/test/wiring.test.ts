/**
 * 接线回归测试：AgentServices → runtime 转发 → wire.ts → ToolServices → 工具
 *
 * 为什么单独一个文件：这个项目为「建好没接」栽过三次（webSearchKey / permissionMode / 日志字段名）——
 * 表现一律是**静默失效**：不报错、不打日志，工具只是永远说「服务未接入」。
 * 所以每个注入项都要有一对断言：
 *   ① 不传 → 工具必须明确说「未接入」（否则说明它没走注入，而是自己去了别处拿值）；
 *   ② 传了 → 工具必须真的拿到（说明整条链路上每一处都写了）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { EventLog } from "../src/session/event-log.ts";
import { PendingRegistry } from "../src/agent/pending.ts";
import { SteeringQueue } from "../src/loop/steering.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import type { AgentServices } from "../src/agent/runtime.ts";
import { CronScheduler } from "../src/scheduler/cron.ts";
import { makeCronOps } from "../src/scheduler/cron-ops.ts";
import { allTools, activateTools, deactivateAll } from "../src/tools/registry.ts";
import type { Tool, McpResourcePort } from "../src/tools/types.ts";
import type { Provider, StreamOptions, StreamResult } from "../src/providers/types.ts";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 跑一轮真实 runtime：模型先调一次指定工具，再把工具结果抓出来 */
async function callOnce(name: string, args: Record<string, unknown>, extra: Partial<AgentServices>): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const provider: Provider = {
    id: "stub-wiring",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      const toolMsg = opts.messages.find((m) => m.role === "tool");
      if (toolMsg) {
        captured = JSON.parse(String(toolMsg.content)) as Record<string, unknown>;
        return { text: "好", reasoning: "", toolCalls: [], usage: { ...usage }, finishReason: "stop" };
      }
      return {
        text: "", reasoning: "", usage: { ...usage }, finishReason: "tool_calls",
        toolCalls: [{ id: "call_wire", type: "function", function: { name, arguments: JSON.stringify(args) } }],
      };
    },
  };
  const db = new Db(":memory:");
  const store = new Store(db);
  store.createThread({ id: "th_wire", kind: "project", title: "接线" });
  const runtime = new AgentRuntime({
    provider, store, tools: new Map<string, Tool>(allTools().map((t) => [t.name, t])),
    eventLog: new EventLog({ dir: mkdtempSync(join(tmpdir(), "dove-wire-")) }),
    pending: new PendingRegistry(), steering: new SteeringQueue(),
    assemble: async () => ({ systemPrompt: "测试", tailContext: "", memoriesBlock: "", dualSystem: false }),
    ...extra,
  });
  activateTools([name]);
  await runtime.run({ threadId: "th_wire", userText: "跑一下这个工具", sink: () => { /* 忽略 */ } });
  deactivateAll();
  db.close();
  assert.ok(captured, name + " 没有产生工具结果");
  return captured!;
}

test("接线：cron 端口不传 → 明确说未接入；传了 → 工具真的拿到", async () => {
  const without = await callOnce("CronList", {}, {});
  assert.equal(without.error, "CRON_UNAVAILABLE");

  const cronDb = new Db(":memory:");
  const sched = new CronScheduler({ db: cronDb, configDir: mkdtempSync(join(tmpdir(), "dove-wire-cron-")), run: async () => "ok" });
  sched.create({ name: "接线用任务", type: "every", schedule: "1h", mode: "main", prompt: "报时" });
  const withCron = await callOnce("CronList", {}, { cron: makeCronOps(sched) });
  assert.equal(withCron.error, undefined, "cron 端口没到工具手上：" + JSON.stringify(withCron));
  assert.equal(withCron.count, 1);
  assert.equal((withCron.jobs as { name: string }[])[0]!.name, "接线用任务");
  assert.equal(typeof withCron.timezone, "string");
  cronDb.close();
});

test("接线：MCP 资源端口不传 → 明确说未接入；传了 → 工具真的拿到", async () => {
  const without = await callOnce("ListMcpResources", {}, {});
  assert.equal(without.error, "MCP_UNAVAILABLE");

  const port: McpResourcePort = {
    servers: () => [{ name: "fixture", connected: true, enabled: true }],
    list: async (server) => [{
      server: server ?? "fixture", ok: true,
      resources: [{ uri: "fixture://hello", name: "hello", mimeType: "text/plain" }],
      templates: [],
    }],
    read: async (uri) => [{ server: "fixture", ok: true, contents: [{ uri, mimeType: "text/plain", text: "hi" }] }],
  };
  const withMcp = await callOnce("ListMcpResources", {}, { mcp: port });
  assert.equal(withMcp.error, undefined, "mcp 端口没到工具手上：" + JSON.stringify(withMcp));
  assert.equal(withMcp.resourceCount, 1);
  assert.equal((withMcp.resources as { uri: string }[])[0]!.uri, "fixture://hello");
});

test("接线：runtime 内部服务（listAgents）在每轮都被挂上", async () => {
  // ListAgents 不需要 bootstrap 传值，它由 run-services.ts 在每轮挂到 ToolServices 上；
  // 这条断言防的是「attachRunServices 忘了调用 / 挂错了对象」。
  const out = await callOnce("ListAgents", {}, {});
  assert.equal(out.error, undefined, "listAgents 没挂上：" + JSON.stringify(out));
  assert.deepEqual(out.agents, []);
  assert.match(String(out.note), /还没有派过子代理/);
});
