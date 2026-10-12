/**
 * 四个修复的回归测试（问题 ②④⑤⑥）。
 *
 * 为什么单独一个文件：core.test.ts 贴着 400 行硬约束，且这里的重点是**真实路径**：
 *  - ④：真的跑一轮 AgentRuntime（假 provider：工具调用后就没有下文了），
 *       断言用户拿得到 interrupted 事件 + 说明文案；
 *  - ⑤：真的走 executeOne 的审批分支，断言超时文案带时长、且发了 tool:approval_timeout；
 *  - ⑥：真的走 Heartbeat.tick，断言 "HEARTBEAT_OKHEARTBEAT_OK" 仍然被判成「安静待着」；
 *  - ②：RuntimeStatus 真的能读到 cron / 后台任务，且**不会被 Home 线程策略裁掉**。
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
import { executeOne } from "../src/loop/tool-exec.ts";
import { allTools } from "../src/tools/registry.ts";
import { applyThreadPolicy } from "../src/agent/tool-policy.ts";
import { RuntimeStatusTool } from "../src/tools/builtin/runtime-status.ts";
import { Heartbeat, isHeartbeatOk, HEARTBEAT_OK } from "../src/scheduler/index.ts";
import { approvalTimeoutMs, APPROVAL_TIMEOUT_MS, humanDuration } from "../src/constants.ts";
import { defineTool, S } from "../src/tools/types.ts";
import type { Tool, ToolServices } from "../src/tools/types.ts";
import type { Provider, StreamOptions, StreamResult } from "../src/providers/types.ts";

const zeroUsage = { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function tempDir(tag: string): string { return mkdtempSync(join(tmpdir(), "dove-fix-" + tag + "-")); }

function streamResult(text: string, toolCalls: StreamResult["toolCalls"] = []): StreamResult {
  return { text, reasoning: "", toolCalls, usage: { ...zeroUsage }, finishReason: toolCalls.length > 0 ? "tool_calls" : "stop" };
}

/** 真实 provider 是逐块回调 onTextDelta 的（见 providers/openai-compat.ts）——假 provider 也要照做，
 *  否则 parts 里不会有文本，运行时会把这一轮判成「用户什么都没看到」（那正是它该判的）。 */
function textStream(opts: StreamOptions, text: string): StreamResult {
  opts.onTextDelta?.(text);
  return streamResult(text);
}

function timeCall(): StreamResult["toolCalls"] {
  return [{ id: "call_time", type: "function", function: { name: "CurrentTime", arguments: "{}" } }];
}

interface RuntimeHarness {
  runtime: AgentRuntime;
  store: Store;
  events: { type: string; [k: string]: unknown }[];
}

function makeRuntime(provider: Provider): RuntimeHarness {
  const db = new Db(":memory:");
  const store = new Store(db);
  const events: { type: string; [k: string]: unknown }[] = [];
  const runtime = new AgentRuntime({
    provider, store,
    tools: new Map<string, Tool>(allTools().map((t) => [t.name, t])),
    eventLog: new EventLog({ dir: tempDir("log") }),
    pending: new PendingRegistry(), steering: new SteeringQueue(),
    assemble: async () => ({ systemPrompt: "测试", tailContext: "", memoriesBlock: "", dualSystem: false }),
  });
  return { runtime, store, events };
}

// ── ④-a 工具调用后模型不再说话（不 abort）→ 必须有说明文案 ──────────
test("④ 工具调用后无可见输出就结束：发 interrupted + 说明文案，落库也有", async () => {
  let step = 0;
  const provider: Provider = {
    id: "silent-stub",
    stream: async (): Promise<StreamResult> => {
      step++;
      if (step === 1) return streamResult("", timeCall());
      return streamResult("");            // 第 2 步：不说话、不调工具 → 回合静默结束
    },
  };
  const { runtime, store, events } = makeRuntime(provider);
  store.createThread({ id: "th_silent", kind: "project", title: "静默" });
  const r = await runtime.run({ threadId: "th_silent", userText: "现在几点", sink: (e) => events.push(e as never) });

  assert.equal(r.silent, true, "runtime 必须自报 silent");
  const interrupted = events.find((e) => e.type === "interrupted");
  assert.ok(interrupted, "没有 interrupted 事件：界面会停在「什么都没发生」。events=" + JSON.stringify(events.map((e) => e.type)));
  assert.equal(interrupted!.endReason, "stop");
  assert.equal(interrupted!.aborted, false);
  const texts = events.filter((e) => e.type === "text").map((e) => String(e.content));
  assert.equal(texts.length, 1, "应当**恰好**推一条说明文案");
  assert.match(texts[0]!, /没有产出答复/);
  // 落库：历史里也要看得到（刷新页面不能又变成空白）
  const last = store.listMessages("th_silent").at(-1)!;
  const stored = last.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
  assert.match(stored, /没有产出答复/);
});

// ── ④-b 就是日志里那条：abort 后 endReason 停在 tool_calls ──────────
test("④ 客户端断开（abort）：endReason=tool_calls 但用户仍会收到「被中断」说明", async () => {
  const ctrl = new AbortController();
  let step = 0;
  const provider: Provider = {
    id: "abort-stub",
    stream: async (): Promise<StreamResult> => {
      step++;
      if (step === 1) {
        // 模拟「工具调用刚发完，客户端就断了」——下一 step 开头循环会 break
        queueMicrotask(() => ctrl.abort("client-gone"));
        return streamResult("", timeCall());
      }
      return streamResult("不该走到这一步");
    },
  };
  const { runtime, store, events } = makeRuntime(provider);
  store.createThread({ id: "th_abort", kind: "project", title: "断开" });
  const r = await runtime.run({ threadId: "th_abort", userText: "现在几点", signal: ctrl.signal, sink: (e) => events.push(e as never) });

  assert.equal(r.aborted === true || r.endReason === "tool_calls", true);
  assert.equal(r.silent, true);
  const interrupted = events.find((e) => e.type === "interrupted");
  assert.ok(interrupted, "断开场景没有 interrupted 事件");
  assert.match(String(interrupted!.note), /被中断/);
  assert.equal(events.filter((e) => e.type === "text").length, 1);
});

// ── ④-c 有文本 / 有 AttemptCompletion 的回合不能被误判成静默 ────────
test("④ 正常回合（有文本）不会被误报成「没有产出」", async () => {
  const provider: Provider = { id: "ok-stub", stream: async (opts): Promise<StreamResult> => textStream(opts, "你好") };
  const { runtime, store, events } = makeRuntime(provider);
  store.createThread({ id: "th_ok", kind: "project", title: "正常" });
  const r = await runtime.run({ threadId: "th_ok", userText: "在吗", sink: (e) => events.push(e as never) });
  assert.equal(r.silent, false);
  assert.equal(events.some((e) => e.type === "interrupted"), false);
  assert.equal(events.filter((e) => e.type === "text").map((e) => String(e.content)).join(""), "你好");
});

// ── ⑥ 逐步 flush：两个 step 的文本不能拼进同一条事件 ────────────────
test("⑥ 每个 step 各自 flush：短回复不再被攒到回合末尾拼成一条", async () => {
  let step = 0;
  const provider: Provider = {
    id: "multi-step",
    stream: async (opts): Promise<StreamResult> => {
      step++;
      if (step === 1) { opts.onTextDelta?.("A"); return streamResult("A", timeCall()); }
      if (step === 2) {
        opts.onTextDelta?.("B");
        return streamResult("B", [{
          id: "call_done", type: "function",
          function: { name: "AttemptCompletion", arguments: JSON.stringify({ summary: "测试完成", verified: true }) },
        }]);
      }
      return textStream(opts, "C");
    },
  };
  const { runtime, store, events } = makeRuntime(provider);
  store.createThread({ id: "th_steps", kind: "project", title: "多步" });
  await runtime.run({ threadId: "th_steps", userText: "走三步", sink: (e) => events.push(e as never) });

  const texts = events.filter((e) => e.type === "text").map((e) => String(e.content));
  // 修复前：脱敏器把 <256 字符的回复整段扣住，三个 step 合成一条 "ABC"
  assert.deepEqual(texts, ["A", "B", "C"], "每一步的文本要各自成事件：" + JSON.stringify(texts));
  // 落库仍然是同一条 assistant 消息里的同一段文本（聚合语义不变）
  const last = store.listMessages("th_steps").at(-1)!;
  assert.equal(last.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(""), "ABC");
});

// ── ②⑥ 心跳回合：跳过完成守卫 + 容忍重复的 HEARTBEAT_OK ─────────────
test("②⑥ 心跳回合跳过完成守卫：查到东西后回 HEARTBEAT_OK，不多烧一轮也不用重复", async () => {
  let step = 0;
  const provider: Provider = {
    id: "hb-stub",
    stream: async (opts): Promise<StreamResult> => {
      step++;
      if (step === 1) return streamResult("", timeCall());     // 先自检（真的查一次）
      return textStream(opts, HEARTBEAT_OK);                    // 再回 OK
    },
  };
  const { runtime, store, events } = makeRuntime(provider);
  store.createThread({ id: "th_hb", kind: "home", title: "Dove" });
  const r = await runtime.run({
    threadId: "th_hb", userText: "心跳自检", heartbeat: true, sink: (e) => events.push(e as never),
  });
  assert.equal(step, 2, "心跳不该被完成守卫再拉起来一轮，实际调了 " + step + " 次");
  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => String(e.content)), [HEARTBEAT_OK]);
  assert.equal(r.silent, false);
});

test("⑥ 对照：普通回合不跳守卫时，HEARTBEAT_OK 会被重复 4 遍（= 日志里那条重复）", async () => {
  let step = 0;
  const provider: Provider = {
    id: "repeat-stub",
    stream: async (opts): Promise<StreamResult> => {
      step++;
      if (step === 1) return streamResult("", timeCall());
      return textStream(opts, HEARTBEAT_OK);      // 每轮被守卫拉起来就再说一遍
    },
  };
  const { runtime, store } = makeRuntime(provider);
  store.createThread({ id: "th_rep", kind: "project", title: "重复" });
  await runtime.run({ threadId: "th_rep", userText: "干活", sink: () => { /* 忽略 */ } });
  const last = store.listMessages("th_rep").at(-1)!;
  const joined = last.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
  assert.equal(joined, HEARTBEAT_OK.repeat(4), "对照组的重复次数变了，说明守卫行为变了");
  // 兜底：即便真出现重复，判定也必须当「安静待着」，不能推给用户
  assert.equal(isHeartbeatOk(joined), true);
});

// ── ⑤ 审批超时：文案带时长 + 非静默事件 + 可配置 ────────────────────
test("⑤ 审批超时：错误文案说清等了多久，并发 tool:approval_timeout 事件", async () => {
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  const danger = defineTool({
    name: "FakeDanger", description: "测试用", parameters: S.obj({ command: S.str("命令") }, ["command"]),
    outputTier: "exact", approval: "always", concurrencySafe: false,
    execute: async () => ({ ran: true }),
  });
  const outcome = await executeOne(
    { id: "call_1", type: "function", function: { name: "FakeDanger", arguments: JSON.stringify({ command: "rm -rf /tmp/x" }) } },
    {
      tools: new Map([[danger.name, danger]]),
      ctxBase: {
        threadId: "th_appr", workdir: process.cwd(), outputsDir: tmpdir(),
        emit: (type, data) => emitted.push({ type, data }),
        services: {} as ToolServices,
      },
      // 真 PendingRegistry 的最短超时不好等，这里直接构造「超时返回」
      resolveApproval: async () => ({ approved: false, reason: "timeout", decision: "deny", timeoutMs: 30_000 }),
    } as never,
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.denied, true);
  assert.match(outcome.errorText!, /等待审批超时/);
  assert.match(outcome.errorText!, /30 秒/, "文案必须说清等了多久：" + outcome.errorText);
  assert.match(outcome.errorText!, /DOVE_APPROVAL_TIMEOUT_MS/, "文案要告诉用户「这个能调」");
  const ev = emitted.find((e) => e.type === "tool:approval_timeout");
  assert.ok(ev, "超时是静默的：没有发 tool:approval_timeout");
  assert.equal(ev!.data.timeoutMs, 30_000);
});

test("⑤ 审批等待上限可配置：DOVE_APPROVAL_TIMEOUT_MS 生效，非法值退回默认", () => {
  const before = process.env.DOVE_APPROVAL_TIMEOUT_MS;
  try {
    delete process.env.DOVE_APPROVAL_TIMEOUT_MS;
    assert.equal(approvalTimeoutMs(), APPROVAL_TIMEOUT_MS);
    assert.equal(APPROVAL_TIMEOUT_MS, 300_000, "默认必须保持现状：5 分钟");
    process.env.DOVE_APPROVAL_TIMEOUT_MS = "60000";
    assert.equal(approvalTimeoutMs(), 60_000);
    process.env.DOVE_APPROVAL_TIMEOUT_MS = "abc";
    assert.equal(approvalTimeoutMs(), APPROVAL_TIMEOUT_MS, "非法值不能把审批掐成 0");
    process.env.DOVE_APPROVAL_TIMEOUT_MS = "0";
    assert.equal(approvalTimeoutMs(), APPROVAL_TIMEOUT_MS);
    assert.equal(humanDuration(300_000), "5 分钟");
  } finally {
    if (before === undefined) delete process.env.DOVE_APPROVAL_TIMEOUT_MS;
    else process.env.DOVE_APPROVAL_TIMEOUT_MS = before;
  }
});

test("⑤ PendingRegistry：超时返回值带 timeoutMs，不再是一个裸 timeout", async () => {
  const p = new PendingRegistry();
  const res = await p.requestApproval("call_x", { title: "t", message: "m", riskLevel: "medium" }, 20);
  assert.equal(res.approved, false);
  assert.equal(res.reason, "timeout");
  assert.equal(res.timeoutMs, 20);
});

// ── ⑥ 心跳重复输出：判定要容忍重复/空白，且不能误判「有事」 ──────────
test("⑥ isHeartbeatOk：重复/空白/大小写都算「安静待着」，夹带内容仍然算有事", () => {
  assert.ok(isHeartbeatOk(HEARTBEAT_OK));
  assert.ok(isHeartbeatOk(" heartbeat_ok。 "));
  assert.ok(isHeartbeatOk("HEARTBEAT_OKHEARTBEAT_OK"), "重复的 OK 不能当成要汇报的内容");
  assert.ok(isHeartbeatOk("HEARTBEAT_OK\nHEARTBEAT_OK\n"));
  assert.ok(isHeartbeatOk("HEARTBEAT_OK！"));
  assert.equal(isHeartbeatOk("HEARTBEAT_OK 但是我发现构建挂了"), false);
  assert.equal(isHeartbeatOk("HEARTBEAT_OK 构建挂了"), false);
  assert.equal(isHeartbeatOk(""), false);
});

test("⑥ 心跳回归：模型重复回 HEARTBEAT_OK，仍然不打扰用户", async () => {
  const delivered: string[] = [];
  const prompts: string[] = [];
  const hb = new Heartbeat({
    configDir: tempDir("hb"),
    now: () => new Date(2026, 9, 11, 10, 0, 0),
    deliver: (t) => delivered.push(t),
    run: async (p) => { prompts.push(p); return "HEARTBEAT_OKHEARTBEAT_OK"; },
  });
  const tick = await hb.tick();
  assert.equal(tick.ran, true);
  assert.equal(tick.suppressed, true, "重复的 HEARTBEAT_OK 被当成了汇报：" + JSON.stringify(tick));
  assert.equal(tick.reason, "heartbeat-ok");
  assert.equal(delivered.length, 0);
  // 提示词必须告诉模型「你只能用这些只读工具查」（问题 ②）
  assert.match(prompts[0]!, /RuntimeStatus/);
  assert.match(prompts[0]!, /没有 Bash/);
  // 清单里问的每一项都要有工具能答
  assert.match(hb.checklist(), /RuntimeStatus/);
});

// ── ② RuntimeStatus：只读自检工具真的能查，且不被 Home 策略裁掉 ──────
test("② RuntimeStatus：Home 线程拿得到，能查到定时任务与未跑完的后台任务", async () => {
  const homeTools = applyThreadPolicy("home", new Map(allTools().map((t) => [t.name, t])));
  assert.ok(homeTools.tools.has("RuntimeStatus"), "心跳自检工具被 Home 策略裁掉了：" + homeTools.blocked.join(","));
  assert.equal(homeTools.blocked.includes("RuntimeStatus"), false);
  assert.ok(homeTools.blocked.includes("Bash"), "Bash 仍然要被裁掉（不放宽写类能力）");

  const services: ToolServices = {
    listTasks: () => [
      { id: "task_1", kind: "subagent", status: "running", prompt: "跑一个长任务", createdAt: Date.now() - 90_000 },
    ],
    listAgents: () => [
      { id: "sub_1", label: "长任务", status: "running", background: true, startedAt: Date.now() - 90_000, source: "live" },
    ],
    cron: {
      create: () => ({ ok: false }),
      remove: () => ({ ok: false }),
      timezone: () => "Asia/Shanghai",
      list: () => [{
        id: "cron_1", name: "喝水提醒", type: "every", schedule: "1h", mode: "main", prompt: "喝水",
        enabled: true, createdAt: Date.now(), nextRunAt: Date.now() + 30 * 60_000, lastRunAt: null, runCount: 3,
      }],
    },
  };
  const ctx = {
    toolCallId: "call_rs", threadId: "th_home", workdir: tmpdir(), outputsDir: tmpdir(),
    emit: () => { /* 测试不关心 */ },
    requestApproval: async () => ({ approved: true, decision: "allow" as const }),
    services,
  };
  const out = await RuntimeStatusTool.execute({}, ctx as never) as Record<string, any>;
  assert.equal(out.background_tasks.available, true);
  assert.equal(out.background_tasks.unfinished, 1);
  assert.equal(out.agents.running, 1);
  assert.equal(out.cron.available, true);
  assert.equal(out.cron.jobs[0].name, "喝水提醒");
  assert.equal(out.now != null, true, "快照要有当前时间");

  // 服务没接时必须明说，不能假装查过
  const bare = await RuntimeStatusTool.execute({}, { ...ctx, services: {} } as never) as Record<string, any>;
  assert.equal(bare.background_tasks.available, false);
  assert.equal(bare.cron.available, false);
});
