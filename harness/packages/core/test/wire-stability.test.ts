/**
 * 铁律二的可执行版本：assertWireStable（DOVE_WIRE_ASSERT=1 才开）
 *
 * 「重建 == 实时」以前只是注释：违反时没有任何东西出声，只有两种静默后果 ——
 * 缓存前缀整段作废（账单看得见、人看不见），以及模型看到的「历史」和用户以为的不一样。
 * 这组测试钉四件事：
 * ① 配对正确时**静默通过**（断言不许变成噪音）；
 * ② 三种典型违规（缺一条 tool 结果 / arguments 被重新 JSON.stringify 排版 / 顺序被调换）
 *    都要抛，且消息里带**下标**与**字段名** —— 只说「不相等」的错误信息等于让人从头再读一遍这条链；
 * ③ 缺省**关**：同一个坏输入在没设环境变量时必须悄无声息（生产路径不许因为一个断言把对话打挂）；
 * ④ 快照必须是**深拷贝**：provider 拿到的是同一个数组引用，浅拷贝会让校验变成摆设。
 *
 * 输入全部按真实路径构造：live 是「实时上过 wire 的字节」，重建走 toWireHistory，
 * 违规用 wire 层面的改动模拟（压缩丢消息 / 某处重排版 arguments / 顺序被调换）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { toWireHistory, assertWireStable, createWireSnapshot } from "../src/agent/wire-history.ts";
import type { ChatMessage } from "../src/providers/types.ts";
import type { Message, Part, ToolPart } from "../src/session/types.ts";

/** provider 逐字节给的参数串：**排版故意不是 JSON.stringify 的样子**（重建要照抄它） */
const RAW = '{"path": "note.txt",  "limit": 5}';

function userMsg(text: string): Message {
  return { id: "u1", threadId: "th", role: "user", parts: [{ type: "text", text }], createdAt: 1 };
}

function toolPart(): ToolPart {
  return {
    type: "tool-Read", toolCallId: "call_1", toolName: "Read", state: "output-available",
    inputRaw: RAW, input: { path: "note.txt", limit: 5 }, output: { ok: true, text: "hi" },
  };
}

/** 重建（走真实路径）：一步 = 文本 + 一次工具调用 */
function rebuild(parts: Part[]): ChatMessage[] {
  const assistant: Message = { id: "a1", threadId: "th", role: "assistant", parts, createdAt: 2 };
  return toWireHistory([userMsg("帮我看下这个文件"), assistant], "th");
}

/** 实时上过 wire 的那份（= 上面那一步当时真实发出去的字节） */
function liveWire(): ChatMessage[] {
  return [
    { role: "user", content: "帮我看下这个文件" },
    { role: "assistant", content: "看一下", tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: RAW } }] },
    { role: "tool", tool_call_id: "call_1", name: "Read", content: JSON.stringify({ ok: true, text: "hi" }) },
    { role: "assistant", content: "看完了" },
  ];
}

/** 一步的 parts（文本 + 工具调用），第二轮是纯文本步 —— 与 liveWire 一一对应 */
function stepParts(): Part[] {
  return [
    { type: "step-start" }, { type: "text", text: "看一下" }, toolPart(),
    { type: "step-start" }, { type: "text", text: "看完了" },
  ];
}

/** 带开关跑一段，finally 里恢复原值（测试之间不许互相污染） */
function withAssert(fn: () => void): void {
  const before = process.env.DOVE_WIRE_ASSERT;
  process.env.DOVE_WIRE_ASSERT = "1";
  try { fn(); } finally {
    if (before === undefined) delete process.env.DOVE_WIRE_ASSERT;
    else process.env.DOVE_WIRE_ASSERT = before;
  }
}

function errorOf(fn: () => void): string {
  try { fn(); } catch (e) { return e instanceof Error ? e.message : String(e); }
  assert.fail("本该抛出（重建与实时不一致）却没抛");
}

test("配对正确：重建 == 实时，逐字节相同（assertWireStable 静默通过）", () => {
  const rebuilt = rebuild(stepParts());
  // 先确认这份重建确实等于手写的实时字节（否则下面的「静默」是假的）
  assert.deepEqual(rebuilt, liveWire(), "arguments 必须照抄 inputRaw 的排版，tool 结果跟在调用之后");
  withAssert(() => assertWireStable(rebuilt, liveWire()));
});

test("缺了一条 tool 结果：抛出，消息里有下标与字段名（tool_call_id）", () => {
  const broken = createWireSnapshot(liveWire());
  broken.splice(2, 1);   // 配对断了：assistant 说了 tool_calls，后面却没有那条 tool 消息
  withAssert(() => {
    const msg = errorOf(() => assertWireStable(broken, liveWire()));
    assert.match(msg, /第 2 条/, "要报出第一个不同的下标");
    assert.match(msg, /role=assistant/, "要报出这一位的角色");
    assert.ok(msg.includes("tool_call_id"), `不同字段名要点名（tool_call_id）：${msg}`);
    assert.ok(msg.includes("content"), `字段名要列全：${msg}`);
    assert.ok(msg.includes("配对"), `要给出定向提示（配对断了）：${msg}`);
    assert.ok(msg.includes("重建=assistant") && msg.includes("实时=tool"), `两边各是什么要说清：${msg}`);
  });
});

test("arguments 被重新 JSON.stringify 排版：抛出，字段名 tool_calls + 定向提示", () => {
  const broken = createWireSnapshot(liveWire());
  const call = broken[1]!.tool_calls![0]!;
  call.function.arguments = JSON.stringify(JSON.parse(RAW));   // 内容一样，字节变了 —— 前缀缓存就从这里断
  assert.notEqual(call.function.arguments, RAW, "前提：重排版确实改了字节");
  withAssert(() => {
    const msg = errorOf(() => assertWireStable(broken, liveWire()));
    assert.match(msg, /第 1 条/, "要报出下标");
    assert.match(msg, /tool_calls/, "要点名不同的字段");
    assert.ok(msg.includes("inputRaw"), `要给出定向提示（照抄 provider 原文）：${msg}`);
  });
});

test("顺序被调换：抛出，消息里有下标与 role", () => {
  const broken = createWireSnapshot(liveWire());
  const [call, result] = [broken[1]!, broken[2]!];
  broken[1] = result; broken[2] = call;   // tool 结果排到了它的调用之前
  withAssert(() => {
    const msg = errorOf(() => assertWireStable(broken, liveWire()));
    assert.match(msg, /第 1 条/, "要报出下标");
    assert.match(msg, /role=/, "要报出角色");
    assert.ok(/role[^。]*/.test(msg) && msg.includes("tool_call_id"), `字段名要点名：${msg}`);
  });
});

test("条数对不上（尾巴少一条）：下标 + 两边各几条 + 这一位的角色", () => {
  const broken = createWireSnapshot(liveWire());
  broken.pop();
  withAssert(() => {
    const msg = errorOf(() => assertWireStable(liveWire(), broken));
    assert.ok(msg.includes("第 3 条"), `要报出第一个对不上的下标：${msg}`);
    assert.ok(msg.includes("重建 4 条 / 实时 3 条"), `要说清两边各几条：${msg}`);
    assert.ok(msg.includes("role=assistant"), `要说清这一位上是什么角色：${msg}`);
  });
});

test("缺省关：同一个坏输入在没设 DOVE_WIRE_ASSERT 时静默通过", () => {
  const before = process.env.DOVE_WIRE_ASSERT;
  delete process.env.DOVE_WIRE_ASSERT;
  try {
    const broken = createWireSnapshot(liveWire());
    broken.splice(2, 1);
    assertWireStable(broken, liveWire());   // 不抛：生产路径上断言不许把对话打挂
    // 只认 "1"：写成 true/yes/on 一律不开（半开状态比全关更难查）
    process.env.DOVE_WIRE_ASSERT = "true";
    assertWireStable(broken, liveWire());
  } finally {
    if (before === undefined) delete process.env.DOVE_WIRE_ASSERT;
    else process.env.DOVE_WIRE_ASSERT = before;
  }
});

test("快照是深拷贝：改快照 / 改原数组都影响不到对方", () => {
  const live = liveWire();
  const snap = createWireSnapshot(live);
  assert.deepEqual(snap, live, "内容一致");
  live[1]!.tool_calls![0]!.function.arguments = "被改了";
  live[0]!.content = "也被改了";
  assert.equal(snap[1]!.tool_calls![0]!.function.arguments, RAW, "原数组的改动不许漏进快照（否则校验永远通过）");
  assert.equal(snap[0]!.content, "帮我看下这个文件");
  assert.notEqual(snap[0], live[0], "连元素对象本身也必须是新的");
});
