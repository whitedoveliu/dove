/**
 * 有序 hook 注册表 + 重复断路器（loop/hooks.ts、loop/repeat-breaker.ts、loop/gates.ts 的 planToolCalls）
 * ① 注册表：顺序（含 before/after）、重复 id、veto/allow 短路、meta 合并留痕、waitUntil 的求值时机；
 * ② 接进循环：被 veto 的调用不执行但 wire 上仍有配对结果、断路器的 8/12 档、提醒走既有注入通道。
 * 循环用例直调 runTurn（不起 AgentRuntime）：断言的就是它真正吐出的消息序列 —— 配对与顺序都在上面。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHookRegistry } from "../src/loop/hooks.ts";
import type { HookEvent } from "../src/loop/hooks.ts";
import { createRepeatBreaker, repeatKey } from "../src/loop/repeat-breaker.ts";
import { planToolCalls } from "../src/loop/gates.ts";
import { runTurn } from "../src/loop/turn.ts";
import type { TurnDeps } from "../src/loop/turn.ts";
import type { ExecDeps, ExecOutcome } from "../src/loop/tool-exec.ts";
import type { Tool } from "../src/tools/types.ts";
import type { ChatMessage, Provider, StreamOptions, StreamResult, ToolCallPayload } from "../src/providers/types.ts";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

// ── ① 注册表 ──────────────────────────────────────────

test("hooks：执行顺序 = 注册顺序 + before/after 插入", async () => {
  const reg = createHookRegistry();
  const seen: string[] = [];
  const rec = (id: string) => () => { seen.push(id); };

  reg.register("turnStart", rec("a"), { id: "a" });
  reg.register("turnStart", rec("c"), { id: "c" });
  reg.register("turnStart", rec("b"), { id: "b", before: "c" });
  reg.register("turnStart", rec("a2"), { id: "a2", after: "a" });
  assert.deepEqual(reg.list("turnStart"), ["a", "a2", "b", "c"], "list 的顺序就是执行顺序");

  await reg.fire("turnStart");
  assert.deepEqual(seen, ["a", "a2", "b", "c"]);
});

test("hooks：id 重复抛错，注销之后不再执行", async () => {
  const reg = createHookRegistry();
  let n = 0;
  const off = reg.register("stepEnd", () => { n++; }, { id: "审计" });
  assert.throws(() => reg.register("stepEnd", () => {}, { id: "审计" }), /id 重复/,
    "两个同名监听者互相覆盖是最难查的一种 bug");
  reg.register("turnEnd", () => {}, { id: "审计" });   // 跨事件同名允许：一个钩子听两个事件很正常
  assert.deepEqual(reg.list("turnEnd"), ["审计"]);
  await reg.fire("stepEnd");
  off(); off();                                        // 重复注销 = no-op
  await reg.fire("stepEnd");
  assert.equal(n, 1);
  assert.deepEqual(reg.list("stepEnd"), []);
});

test("hooks：veto 短路 —— 后面的监听者确实没跑", async () => {
  const reg = createHookRegistry();
  const seen: string[] = [];
  reg.register("beforeToolExecute", () => { seen.push("first"); }, { id: "first" });
  reg.register("beforeToolExecute", () => ({ kind: "veto", reason: "策略不允许" }), { id: "deny" });
  reg.register("beforeToolExecute", () => { seen.push("third"); }, { id: "third" });

  const r = await reg.fire("beforeToolExecute");
  assert.equal(r.vetoed, "策略不允许");
  assert.equal(r.allowed, undefined);
  assert.deepEqual(seen, ["first"], "veto 之后注册者一个都不许跑");
});

test("hooks：allow 正向短路（记住的授权不必再弹窗）", async () => {
  const reg = createHookRegistry();
  let asked = false;
  reg.register("beforeToolExecute", () => ({ kind: "allow", meta: { by: "规则" } }), { id: "rule" });
  reg.register("beforeToolExecute", () => ({
    kind: "waitUntil", factory: async () => { asked = true; },
  }), { id: "dialog" });

  const r = await reg.fire("beforeToolExecute");
  assert.equal(r.allowed, true);
  assert.equal(r.vetoed, undefined);
  assert.equal(asked, false, "有人明确放行就不该再去问人");
  assert.deepEqual(r.meta, { by: "规则" });
});

test("hooks：pass 的 meta 后写覆盖前写，但 trail 里留痕", async () => {
  const reg = createHookRegistry();
  reg.register("stepEnd", () => ({ kind: "pass", meta: { level: 1, a: "x" } }), { id: "one" });
  reg.register("stepEnd", () => ({ kind: "pass", meta: { level: 2 } }), { id: "two" });

  const r = await reg.fire("stepEnd");
  assert.deepEqual(r.meta, { level: 2, a: "x" }, "后写的覆盖前写的，没被覆盖的保留");
  assert.deepEqual(r.trail, [
    { id: "one", kind: "pass", keys: ["level", "a"] },
    { id: "two", kind: "pass", keys: ["level"] },
  ], "谁写过哪些键必须留痕（否则「谁把它改成 2 了」无从追）");
});

test("hooks：waitUntil 在所有同步监听者跑完之后才求值", async () => {
  const reg = createHookRegistry();
  const timeline: string[] = [];
  reg.register("beforeToolExecute", () => { timeline.push("sync-1"); }, { id: "s1" });
  reg.register("beforeToolExecute", () => ({
    kind: "waitUntil", factory: async () => { timeline.push("wait-1"); },
  }), { id: "w1" });
  reg.register("beforeToolExecute", () => { timeline.push("sync-2"); }, { id: "s2" });
  reg.register("beforeToolExecute", () => ({
    kind: "waitUntil", factory: async () => { timeline.push("wait-2"); return { kind: "pass", meta: { ok: true } }; },
  }), { id: "w2" });

  const r = await reg.fire("beforeToolExecute");
  assert.deepEqual(timeline, ["sync-1", "sync-2", "wait-1", "wait-2"],
    "同步段必须一次跑完；延后段按注册顺序（审批弹窗不该卡住排在它后面的注册者）");
  assert.deepEqual(r.meta, { ok: true });
});

test("hooks：监听者必须是同步函数；实例之间互相隔离（没有全局单例）", async () => {
  const reg = createHookRegistry();
  reg.register("turnStart", (() => Promise.resolve()) as never, { id: "async" });
  await assert.rejects(() => reg.fire("turnStart"), /必须是同步函数/, "异步是 waitUntil 的活");
  const a = createHookRegistry();
  const b = createHookRegistry();
  let n = 0;
  a.register("turnEnd", () => { n++; });
  await b.fire("turnEnd");
  assert.equal(n, 0);
  await a.fire("turnEnd");
  assert.equal(n, 1);
});

// ── ② 断路器 ──────────────────────────────────────────

test("断路器：3/5 提醒、8 停批、12 终止，且每档只给一次", () => {
  const b = createRepeatBreaker();
  const call = { id: "c", name: "Bash", arguments: '{"command":"npm test"}' };
  const acts: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const d = b.note({ ...call, id: `c${i}` });
    if (d.reminder) acts.push(`${i}:remind`);
    if (d.stopBatch) acts.push(`${i}:stop`);
    if (d.fail) acts.push(`${i}:fail`);
  }
  assert.deepEqual(acts, ["3:remind", "5:remind", "8:stop", "12:fail"]);
  assert.equal(b.summary()[0]!.count, 12);
  assert.deepEqual(b.note({ ...call, id: "c4" }), {}, "第 4 次不许再刷一遍提醒（提醒本身会变成噪声）");
});

test("断路器：参数键序无关，参数不同则是不同的 key；reset 清空", () => {
  const b = createRepeatBreaker();
  const a = { id: "1", name: "Read", arguments: '{"file_path":"/a","limit":5}' };
  const swapped = { id: "2", name: "Read", arguments: '{"limit":5,"file_path":"/a"}' };
  const other = { id: "3", name: "Read", arguments: '{"file_path":"/b","limit":5}' };

  assert.equal(repeatKey("Read", a.arguments), repeatKey("Read", swapped.arguments), "键序抖动必须同 key");
  assert.equal(b.note(a).reminder, undefined, "第 1 次");
  assert.equal(b.note(swapped).reminder, undefined, "第 2 次（键序反着来，照样算同一个）");
  assert.ok(b.note(swapped).reminder, "第 3 次提醒");
  assert.deepEqual(b.note(other), {}, "参数不一样的不算重复");
  assert.equal(b.summary().find((s) => s.key === repeatKey("Read", other.arguments))!.count, 1);
  assert.equal(repeatKey("Do", ""), repeatKey("Do", "{}"), "空参数串与 {} 同 key（无参调用的两种写法）");
  b.reset();
  assert.deepEqual(b.summary(), []);
  assert.deepEqual(b.note(other), {}, "reset 之后从 1 开始数");
});

test("断路器：解析失败的参数用原文比较（护栏不许因为 JSON 坏了就失效）", () => {
  const b = createRepeatBreaker();
  const bad = { id: "x", name: "Bash", arguments: '{"command":"echo hi' };   // 半截 JSON（流被截断）
  b.note(bad); b.note(bad);
  assert.ok(b.note(bad).reminder);
});

// ── ③ 预判（确定性，不经过工具调度）────────────────────

const mkCall = (id: string, name: string, args: Record<string, unknown>): ToolCallPayload =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

test("预判：10 次相同调用 → 前 7 个该跑，其余合成「停批」结果 + 两次提醒", async () => {
  const calls = Array.from({ length: 10 }, (_, i) => ({ ...mkCall(`c${i}`, "Read", { file_path: "/same" }) }));
  const plan = await planToolCalls({ calls, breaker: createRepeatBreaker(), turn: 1, step: 1 });

  assert.deepEqual(plan.runnable.map((c) => c.id), ["c0", "c1", "c2", "c3", "c4", "c5", "c6"],
    "第 8 次（下标 7）起一个都不该进 runnable");
  assert.equal(plan.pre[6], undefined, "该跑的位置必须留空（由调用方执行完填回）");
  for (const i of [7, 8, 9]) {
    assert.equal(plan.pre[i]!.ok, false);
    assert.match(plan.pre[i]!.errorText!, /重复护栏/);
    assert.equal(plan.pre[i]!.toolCallId, `c${i}`, "合成结果必须挂在**同一个** tool_call_id 上（配对）");
  }
  assert.equal(plan.reminders.length, 2, "第 3 次与第 5 次各一条");
  assert.equal(plan.fail, false);

  // 第 12 档：同一个 key 数到 12 → 整轮终止
  const many = Array.from({ length: 12 }, (_, i) => mkCall(`d${i}`, "Bash", { command: "npm test" }));
  const plan12 = await planToolCalls({ calls: many, breaker: createRepeatBreaker(), turn: 1, step: 1 });
  assert.equal(plan12.fail, true);
  assert.equal(plan12.runnable.length, 7);
});

test("预判：hook veto 的调用不进 runnable，但留下合成结果（原因原样带上）", async () => {
  const reg = createHookRegistry();
  reg.register("beforeToolExecute", (p) => (
    p.toolName === "Write" ? { kind: "veto", reason: "只读模式" } : undefined
  ));
  const calls = [mkCall("r", "Read", { file_path: "/a" }), mkCall("w", "Write", { file_path: "/a", content: "x" })];
  const plan = await planToolCalls({ calls, breaker: createRepeatBreaker(), hookRegistry: reg, turn: 1, step: 1 });

  assert.deepEqual(plan.runnable.map((c) => c.id), ["r"]);
  assert.equal(plan.pre[0], undefined);
  assert.equal(plan.pre[1]!.ok, false);
  assert.match(plan.pre[1]!.errorText!, /只读模式/);
  assert.equal(plan.pre[1]!.denied, undefined, "hook 拦下 ≠ 用户拒绝：置 denied 会把闸门③的「被用户拒绝了」说给模型听");
});

interface Script { text?: string; calls?: { name: string; args: Record<string, unknown> }[] }

/** 按脚本回放的桩 provider；记下每次 stream 收到的消息（= 当时手上的 wire） */
function stubProvider(script: Script[], wires: ChatMessage[][]): Provider {
  let n = 0;
  return {
    id: "stub-hooks",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      const s = script[n++] ?? { text: "（脚本用完了）" };
      wires.push(opts.messages);
      const calls = (s.calls ?? []).map((c, i): ToolCallPayload => ({ id: `call_${n}_${i}`, type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      if (s.text) opts.onTextDelta?.(s.text);
      return { text: s.text ?? "", reasoning: "", toolCalls: calls, usage: { ...usage },
        finishReason: calls.length > 0 ? "tool_calls" : "stop" };
    },
  };
}

function stubTool(name: string, execute: Tool["execute"], accesses?: Tool["accesses"]): Tool {
  return {
    name, description: name, parameters: { type: "object", properties: {} },
    outputTier: "exact", approval: "never", concurrencySafe: true, execute, accesses,
  };
}
/** 按 file_path 声明读路径：不同文件落进不同调度桶，用例不会被并行调度误伤 */
const readTool = (execute: Tool["execute"]): Tool => stubTool("Read", execute, (args) => ({
  kind: "paths", paths: [{ path: String(args.file_path ?? ""), operation: "read" }],
}));

function harness(script: Script[], tools: Map<string, Tool>, over: Partial<TurnDeps> = {}) {
  const wires: ChatMessage[][] = [];
  const dir = mkdtempSync(join(tmpdir(), "dove-hooks-"));
  const execDeps: Omit<ExecDeps, "tools"> = {
    ctxBase: { threadId: "th", workdir: dir, outputsDir: dir, emit: () => {}, services: {} },
    resolveApproval: async () => ({ approved: true }),
  };
  const deps: TurnDeps = {
    provider: stubProvider(script, wires), model: "stub", systemPrompt: "sys",
    history: [], userText: "干活", tools, execDeps,
    steerPending: () => false, drainSteering: () => [],
    ...over,
  };
  return { deps, wires };
}

/** 【配对不变式】每个 tool_call 都要有且只有一条配对的 tool 消息，顺序也一致（wire-history.ts 铁律一） */
function assertPaired(messages: ChatMessage[]): void {
  const declared: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) declared.push(...m.tool_calls.map((c) => c.id));
  }
  const answered = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(answered, declared, "tool_calls 与 tool 结果必须一一配对、且顺序一致");
}

test("接线：beforeToolExecute 的 veto 不执行工具，但 wire 上仍有配对结果", async () => {
  const ran: string[] = [];
  const tools = new Map<string, Tool>([
    ["Read", readTool(async () => { ran.push("Read"); return { content: "真的读了" }; })],
    ["AttemptCompletion", stubTool("AttemptCompletion", async () => ({ ok: true }))],
  ]);
  const reg = createHookRegistry();
  reg.register("beforeToolExecute", (p) => (p.toolName === "Read" ? { kind: "veto", reason: "测试策略：不许读" } : undefined),
    { id: "policy" });
  const outcomes: ExecOutcome[] = [];

  const { deps } = harness([
    { calls: [{ name: "Read", args: { file_path: "/x" } }] },
    { calls: [{ name: "AttemptCompletion", args: { summary: "完成" } }] },
    { text: "收尾" },
  ], tools, { hookRegistry: reg, hooks: { onToolResult: (o) => outcomes.push(o) } });

  const r = await runTurn(deps);
  assert.deepEqual(ran, [], "被 veto 的调用一次都不许真的跑");
  assertPaired(r.messages);

  const readMsg = r.messages.find((m) => m.role === "tool" && m.name === "Read")!;
  assert.ok(readMsg, "被拦下也必须有一条 tool 消息");
  assert.match(String(readMsg.content), /测试策略：不许读/, "原因要带给模型");
  assert.match(String(readMsg.content), /没有执行/);

  // 合成结果必须同样经过 onToolResult：runtime 靠它把 tool part 落成 output-error + errorText；
  // 少了这一步，下一轮重建的 tool 消息与实时 wire 差一个字节，前缀缓存整段作废（铁律二）
  const o = outcomes.find((x) => x.toolName === "Read")!;
  assert.equal(o.ok, false);
  assert.match(o.errorText!, /测试策略：不许读/);
  assert.equal(o.denied, undefined, "hook 拦下不等于用户拒绝（否则闸门③会说「被用户拒绝了」）");
  assert.equal(outcomes.find((x) => x.toolName === "AttemptCompletion")!.ok, true, "没被拦的工具照常执行");
});

test("接线：六个事件按真实时机触发（顺序即契约）", async () => {
  const tools = new Map<string, Tool>([
    ["Read", readTool(async () => ({ content: "x" }))],
    ["AttemptCompletion", stubTool("AttemptCompletion", async () => ({}))],
  ]);
  const reg = createHookRegistry();
  const seen: HookEvent[] = [];
  for (const e of ["turnStart", "beforeStep", "beforeToolExecute", "afterToolExecute", "stepEnd", "turnEnd"] as HookEvent[]) {
    reg.register(e, () => { seen.push(e); });
  }
  const { deps } = harness([
    { calls: [{ name: "Read", args: { file_path: "/x" } }] },
    { calls: [{ name: "AttemptCompletion", args: { summary: "完成" } }] },
    { text: "收尾" },
  ], tools, { hookRegistry: reg });

  await runTurn(deps);
  // 第二步（AttemptCompletion）也是一步工具往返；第三步是纯文本步 —— 只有 beforeStep/stepEnd
  assert.equal(seen.join(" "),
    "turnStart "
    + "beforeStep beforeToolExecute afterToolExecute stepEnd "
    + "beforeStep beforeToolExecute afterToolExecute stepEnd "
    + "beforeStep stepEnd turnEnd");
});

test("接线：第 8 次相同调用停批 —— 本批剩余调用不再执行", async () => {
  const ran = new Set<string>();
  const tools = new Map<string, Tool>([
    ["Read", readTool(async (_i, ctx) => { ran.add(ctx.toolCallId); return { content: "x" }; })],
    ["AttemptCompletion", stubTool("AttemptCompletion", async () => ({}))],
  ]);
  const injected: string[] = [];
  const same = { name: "Read", args: { file_path: "/same" } };

  const { deps, wires } = harness([
    { calls: Array.from({ length: 10 }, () => same) },
    { calls: [{ name: "AttemptCompletion", args: { summary: "完成" } }] },
    { text: "收尾" },
  ], tools, { hooks: { onUserInjection: (t) => injected.push(t) } });

  const r = await runTurn(deps);
  assert.equal(wires.length, 3, "后面的步骤照常走：停批只停这一批");

  // 这一批 10 个调用全都要有配对结果：第 8 个起是护栏合成的「没有执行」，不是真的跑了
  const results = r.messages.filter((m) => m.role === "tool" && m.name === "Read");
  assert.equal(results.length, 10, "被停掉的调用同样要有配对结果（否则配对断裂）");
  assertPaired(r.messages);
  for (const m of results.slice(7)) assert.match(String(m.content), /重复护栏/, "第 8 次起一律是合成结果");
  for (const m of results.slice(0, 7)) assert.ok(!String(m.content).includes("重复护栏"), "前 7 次照常执行");
  // 按 call id 数「谁真的执行了」（不按执行次数：同参数 ⇒ 同一个调度桶，次数还受调度影响）
  for (let i = 0; i < 10; i++) {
    assert.equal(ran.has(`call_1_${i}`), i < 7, `第 ${i + 1} 个调用：前 7 个该跑、第 8 个起停批不许跑`);
  }

  // 提醒走既有的中途注入通道（user 消息 + onUserInjection → injection part）
  assert.equal(injected.length, 2, "第 3 次与第 5 次各提醒一次");
  const firstReminder = r.messages.findIndex((m) => m.role === "user" && String(m.content).startsWith("<system-reminder>"));
  assert.equal(r.messages.filter((m) => m.role === "user" && String(m.content).startsWith("<system-reminder>")).length, 2);
  // 注入位置必须在工具结果**之后**：assistant(tool_calls) 与 tool 结果之间插 user 是非法消息
  const lastRead = r.messages.map((m) => m.role === "tool" && m.name === "Read").lastIndexOf(true);
  assert.ok(firstReminder > lastRead, "提醒要排在这一步的工具结果之后");
});

test("接线：第 12 次相同调用直接终止这一轮", async () => {
  const ran = new Set<string>();
  const tools = new Map<string, Tool>([
    ["Read", readTool(async (_i, ctx) => { ran.add(ctx.toolCallId); return { content: "x" }; })],
  ]);
  const same = { name: "Read", args: { file_path: "/same" } };
  const { deps, wires } = harness([{ calls: Array.from({ length: 12 }, () => same) }], tools);

  const r = await runTurn(deps);
  assert.equal(r.endReason, "repeat-breaker");
  assert.equal(wires.length, 1, "整轮在第一批就结束了，不许再往下走");
  for (const id of ran) assert.match(id, /^call_1_[0-6]$/, `只许前 7 个真跑（第 8 起停批、第 12 终止），实际跑了 ${id}`);
  assertPaired(r.messages);
});

test("接线：换参数就不算重复（不同的工作照常跑）", async () => {
  const seen = new Set<string>();
  const tools = new Map<string, Tool>([
    ["Read", readTool(async (i) => { seen.add(String(i.file_path)); return { content: "x" }; })],
    ["AttemptCompletion", stubTool("AttemptCompletion", async () => ({}))],
  ]);
  const reads = ["/a", "/b", "/c"].map((file_path) => ({ name: "Read", args: { file_path } }));
  const { deps } = harness([
    { calls: reads },
    { calls: [{ name: "AttemptCompletion", args: { summary: "完成" } }] },
    { text: "收尾" },
  ], tools);

  const r = await runTurn(deps);
  assert.deepEqual([...seen].sort(), ["/a", "/b", "/c"], "不同参数完全不受护栏影响");
  assertPaired(r.messages);
});
