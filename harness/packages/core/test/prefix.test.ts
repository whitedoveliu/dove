/**
 * 前缀缓存纪律回归（借鉴 DSH 的 request-reconstruction.spec.ts）
 *
 * 为什么值得单独一组测试：前缀缓存是 Dove 最省钱的机制，而它的敌人全是**静默**的 ——
 * 插入一个工具、重写一条历史消息、把每轮都变的文本塞进系统提示词，模型看不出差别、
 * 界面看不出差别，只有账单看得见。所以这里把「请求只能从尾部生长」写成可执行断言：
 *
 *  ① 同一轮内：后一步的 wire **严格**以上一步为前缀（连最后一条 user 都不许变）；
 *  ② 跨轮：上一轮的 messages 是下一轮的前缀，整段逐字节相同 —— **没有例外**。
 *     尾上下文（`[Context: …]`）在贴上去的那一刻就落库（attachTail），下一轮原样重放；
 *     它只贴在「当轮最新那条 user 消息」上，不再回头改写任何一条旧消息
 *     （以前重建时把它丢掉，导致从那条消息往后全部按全价重付）。
 *  ③ 工具数组：动态激活只能追加到尾部（Fix 2 的回归点，靠前目录的工具晚激活也不行）；
 *  ④ 崩溃修复交代（repair notice）贴在**当前** user 消息上，历史里的消息逐字节不动（Fix 3）；
 *  ⑤ **重建 == 实时**：一轮里每一步（文本 + 工具调用 + 结果 + 中途注入）在下一轮从库里
 *     重建时必须逐字节再现 —— 包括带着尾上下文的那条最新 user 消息（整段前缀，无例外）。
 *
 * 用真实 Store + 真实 runtime + 真实 registry（只有 provider 是桩、tailContext 固定），
 * 所以断言的是真实装配出来的 wire，不是某个纯函数的返回值。全程不联网、不使用真实 provider。
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
import { toWireHistory, dropLastUser } from "../src/agent/wire-history.ts";
import { allTools, activateTools, deactivateAll } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/types.ts";
import type { ChatMessage, Provider, StreamOptions, StreamResult, ToolSchema } from "../src/providers/types.ts";
import type { Message, ToolPart } from "../src/session/types.ts";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 固定尾上下文：不带时间锚 —— 测试不许依赖墙上时钟（否则跨轮断言会随机飘） */
const TAIL = "测试锚";

interface Script {
  text?: string;
  calls?: { name: string; args: Record<string, unknown>; raw?: string }[];
  /** 这一步开流之前先往 steering 队列塞一条（覆盖「中途插话」路径） */
  steer?: string;
}
interface Wire { messages: ChatMessage[]; tools: string[]; }

/** 按脚本回放的桩 provider：每次 stream 记下真实 wire（messages + 工具名数组） */
function scriptedProvider(script: Script[], wires: Wire[], steer?: (text: string) => void): Provider {
  let call = 0;
  return {
    id: "stub-prefix",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      const s = script[call++] ?? { text: "（脚本用完了）" };
      // 插话要在**这一步的信发出去之前**进队：它会在这一步的工具批次之后被折叠
      if (s.steer) steer?.(s.steer);
      wires.push({ messages: opts.messages, tools: (opts.tools ?? []).map((t: ToolSchema) => t.function.name) });
      const calls = (s.calls ?? []).map((c, i) => ({
        id: `call_${call}_${i}`, type: "function" as const,
        // raw：provider 逐字节给的参数串（可能与 JSON.stringify 的排版不同 —— 正是重建要照抄原文的原因）
        function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args) },
      }));
      // ⚠️ 文本必须走 onTextDelta（真实 provider 就是这么逐 token 推的）：
      //    TextCollector 只认增量回调，落库的 parts 里的 text 全靠它 ——
      //    不喂增量的话库里根本没有 text part，重建时会缺掉「模型说过的话」。
      if (s.text) opts.onTextDelta?.(s.text);
      opts.onUsage?.({ ...usage });
      return {
        text: s.text ?? "", reasoning: "", toolCalls: calls, usage: { ...usage },
        finishReason: calls.length > 0 ? "tool_calls" : "stop",
      };
    },
  };
}

function harness(threadId: string, script: (file: string) => Script[], wires: Wire[]) {
  const file = join(mkdtempSync(join(tmpdir(), "dove-prefix-")), "note.txt");
  writeFileSync(file, "测试内容");
  const db = new Db(":memory:");
  const store = new Store(db);
  store.createThread({ id: threadId, kind: "project", title: "前缀" });
  const steering = new SteeringQueue();
  const runtime = new AgentRuntime({
    provider: scriptedProvider(script(file), wires, (t) => steering.push(threadId, t)), store,
    tools: new Map<string, Tool>(allTools().map((t) => [t.name, t as Tool])),
    eventLog: new EventLog({ dir: mkdtempSync(join(tmpdir(), "dove-prefix-log-")) }),
    pending: new PendingRegistry(), steering,
    assemble: async () => ({ systemPrompt: "测试系统提示词", tailContext: TAIL, memoriesBlock: "", dualSystem: false }),
  });
  const run = (userText: string) => runtime.run({ threadId, userText, sink: () => { /* 忽略 */ } });
  return { runtime, store, db, file, run };
}

/** 前缀断言：prev 必须是 next 的前缀；diff 只允许出现在 next 多出来的尾巴上 */
function assertIsPrefix(prev: ChatMessage[], next: ChatMessage[], hint: string): void {
  assert.ok(next.length > prev.length, `${hint}：请求必须比上一份长（旧 ${prev.length} → 新 ${next.length}）`);
  assert.deepEqual(next.slice(0, prev.length), prev, `${hint}：前 ${prev.length} 条必须逐字节不变（否则整段缓存前缀作废）`);
}

/** 最后一条 user 在数组里的下标（尾上下文只贴它，找不到返回 -1） */
function lastUserIndex(msgs: ChatMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === "user") return i;
  return -1;
}

/**
 * 跨轮的前缀断言：prev 的**每一条**都要在 next 的同一位置逐字节相同 —— 没有例外。
 * 尾上下文在它被贴上的那一刻就落库（attachTail），下一轮由 toWireHistory 原样重放；
 * 它只出现在「当轮最新那条 user 消息」上，不再回头改写任何一条旧消息。
 * 少一个字节都要报错：那正是「缓存前缀作废、从那里往后按全价重付」的现场。
 */
function assertPrefixAcrossTurns(prev: ChatMessage[], next: ChatMessage[], hint: string): void {
  assert.ok(lastUserIndex(prev) >= 0, `${hint}：prev 里必须有 user 消息`);
  assertIsPrefix(prev, next, hint);
}

/**
 * 「重建 == 实时」断言（前缀缓存的真正不变式，⑤）：
 * 下一轮从库里重建出来的历史，必须与上一轮**实时上过 wire 的消息**逐字节相同 ——
 * **整段，无例外**：带着尾上下文的那条最新 user 消息也在内（它贴的原文已落库，重建原样重放）。
 * 每步的 assistant / tool 消息、tool_calls 的参数字节、结果 JSON、中途注入的消息，
 * 差一个字节都算前缀作废：缓存命中的长度就是「当前请求与历史请求逐字节相同的那个前缀」的长度。
 */
function assertRebuiltMatchesLive(live: ChatMessage[], rebuilt: ChatMessage[], hint: string): void {
  assert.equal(rebuilt.length, live.length, `${hint}：条数必须一致（实时 ${live.length} → 重建 ${rebuilt.length}）`);
  assert.ok(lastUserIndex(live) >= 0, `${hint}：实时 wire 里必须有 user 消息`);
  for (let i = 0; i < live.length; i++) {
    assert.deepEqual(rebuilt[i], live[i], `${hint}：第 ${i} 条（${live[i]!.role}）必须逐字节不变`);
  }
}

test("前缀纪律：同一轮内每一步都以上一步为前缀（严格，无例外）", async () => {
  deactivateAll();
  const wires: Wire[] = [];
  const { run, db } = harness("th_prefix_step", (file) => [
    { calls: [{ name: "Read", args: { file_path: file } }] },
    { calls: [{ name: "AttemptCompletion", args: { summary: "读完了" } }] },
    { text: "读完了" },
  ], wires);
  await run("看一眼这个文件");

  assert.equal(wires.length, 3, "桩 provider 应该被调用三步");
  // 尾上下文在**一轮开始时**注入一次，之后每一步都是同一条消息 —— 所以轮内不许有任何例外
  assertIsPrefix(wires[0]!.messages, wires[1]!.messages, "step1→step2");
  assertIsPrefix(wires[1]!.messages, wires[2]!.messages, "step2→step3");
  // 工具数组在这一轮里没变过：逐字相同
  assert.deepEqual(wires[2]!.tools, wires[0]!.tools, "没有激活动作时工具数组必须逐字不变");
  db.close();
});

test("前缀纪律：下一轮的历史逐字节等于上一轮（尾上下文原样重放，整段无例外）", async () => {
  deactivateAll();
  const wires: Wire[] = [];
  const { run, db } = harness("th_prefix_turn", (file) => [
    // 第 1 轮：读文件 → 声明完成 → 收尾
    { calls: [{ name: "Read", args: { file_path: file } }] },
    { calls: [{ name: "AttemptCompletion", args: { summary: "读完了" } }] },
    { text: "读完了" },
    // 第 2 轮、第 3 轮：纯聊天（不触发完成守卫）
    { text: "好的" },
    { text: "好的" },
  ], wires);
  await run("第一轮：看一眼这个文件");
  await run("第二轮：换个说法");
  await run("第三轮：再来一次");

  assert.equal(wires.length, 5, "三轮分别用了 3 / 1 / 1 次 provider 调用");

  // 第 1 轮第一步 → 第 2 轮第一步：这一对是**同一重建口径**下的两份请求
  // （都是"某轮的第一步"），所以前缀性质必须**严格**成立 —— 一条都不许被改写。
  assertPrefixAcrossTurns(wires[0]!.messages, wires[3]!.messages, "第1轮首步→第2轮首步");

  // 第 2 轮 → 第 3 轮：历史更长，能盖住 assistant / tool 消息
  assertPrefixAcrossTurns(wires[3]!.messages, wires[4]!.messages, "第2轮→第3轮");

  // ── 整段重建 == 实时（老「已知分歧」的回归点，⑤）：
  //    第 2 轮的第一步请求就是从库里重建出来的历史；它必须以第 1 轮最后一步的实时请求
  //    为前缀，只多出「收尾那段文本 + 新一轮 user」两条。
  const live1 = wires[2]!.messages;   // [system, u1(尾), assistant(Read), tool, assistant(AC), tool]
  const next1 = wires[3]!.messages;   // 上面 + [assistant(收尾文本), u2]
  assert.equal(next1.length, live1.length + 2, "第 2 轮只许比第 1 轮最后一步多两条（收尾文本 + 新 user）");
  assert.deepEqual(next1[0], live1[0], "系统提示词逐字节不变");
  // 以前这里是「唯一允许的差异」：u1 带着尾上下文上过一次 wire，重建时却还原成裸文本，
  // 从它往后全部按全价重付。现在尾上下文在贴上去的那一刻就落库，重建原样重放 —— 同一个字节。
  assert.equal(next1[1]!.content, `[Context: ${TAIL}]\n\n第一轮：看一眼这个文件`,
    "u1 的尾上下文必须逐字节重放（不许丢，也不许重贴成两份）");
  for (let i = 2; i < live1.length; i++) {
    assert.deepEqual(next1[i], live1[i], `第 ${i} 条（${live1[i]!.role}）必须逐字节不变 —— 分叉就是在这里发生的`);
  }
  assert.deepEqual(next1[2]!.tool_calls?.map((c) => c.function.name), ["Read"], "一步一条 assistant：第 1 步只带 Read");
  assert.deepEqual(next1[4]!.tool_calls?.map((c) => c.function.name), ["AttemptCompletion"], "一步一条 assistant：第 2 步只带 AttemptCompletion");
  assert.deepEqual(next1[live1.length], { role: "assistant", content: "读完了" }, "收尾那段文本自成一个纯文本步");
  // 值比较门（DSH 纪律）：本轮渲染出来的尾上下文与上一条带尾上下文的消息逐字节相同 → 不重贴。
  assert.equal(String(next1[live1.length + 1]!.content), "第二轮：换个说法", "尾上下文没变 → 跳过重贴，只有原文");
  assert.equal(wires[4]!.messages.filter((m) => String(m.content).startsWith("[Context:")).length, 1,
    "整段历史里尾上下文只该有一份（u1 的那一份）；每轮重贴一遍才是白烧 token");
  db.close();
});

test("前缀纪律：一轮两步两次工具调用，下一轮从库里重建的历史与实时 wire 逐字节一致", async () => {
  deactivateAll();
  const wires: Wire[] = [];
  const { run, store, db, file } = harness("th_prefix_identity", (file) => [
    // 两步各一次工具调用 —— 正是老实现会把两个 call 压到一条 assistant 上的形状。
    // 第一步的参数故意带非规范排版（空格）：重建若走 JSON.stringify(parse(raw)) 就会重排版 → 差字节
    { calls: [{ name: "Read", args: { file_path: file }, raw: `{ "file_path" : ${JSON.stringify(file)} }` }] },
    { calls: [{ name: "Read", args: { file_path: file } }] },
    // 第三步 AttemptCompletion 是完成守卫的契约：少了它，收尾那一步之后守卫会往
    // wire 里补一条系统提醒（那是另一条缓存缺口，本用例覆盖不到）。
    { calls: [{ name: "AttemptCompletion", args: { summary: "读了两遍" } }] },
    { text: "读了两遍" },
  ], wires);
  await run("读两遍这个文件");

  assert.equal(wires.length, 4, "两次 Read + 收尾：四次 provider 调用");
  // 这个回合实时上过 wire 的全部消息 = 最后一次请求 + 最后一步 push 的收尾文本。
  // 收尾那条这一步没被发出去，但**下一轮请求**会把它带上 —— 重建错一个字节，
  // 缓存就从那里分叉（下一步到下一步的请求必须严格是同一份历史 + 尾部追加）。
  const live = wires[3]!.messages.slice(1).concat([{ role: "assistant", content: "读了两遍" }]);

  // 下一轮从库里重建：先把下一轮 user 落库（runtime 就是这么做的），再重建 + dropLastUser。
  // 这一对调用与 agent/runtime.ts 的 toWireHistory/dropLastUser 完全同径。
  store.addMessage({
    id: "th_prefix_identity--u-next", threadId: "th_prefix_identity", role: "user",
    parts: [{ type: "text", text: "下一轮" }], createdAt: Date.now(),
  });
  const rebuilt = dropLastUser(toWireHistory(store.recentMessages("th_prefix_identity", 60), "th_prefix_identity"));

  // 整段逐字节（含 u1 的尾上下文，见 assertRebuiltMatchesLive 的说明）
  assertRebuiltMatchesLive(live, rebuilt, "实时 wire → 下一轮重建");
  // 逐字节了就必须同时满足：每步一条 assistant、每条调用紧跟自己的结果
  assert.deepEqual(rebuilt.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"],
    "两步工具 + 收尾文本的重建序列");
  assert.equal(rebuilt[1]!.tool_calls?.[0]?.function.arguments, `{ "file_path" : ${JSON.stringify(file)} }`,
    "tool_calls 的 arguments 必须照抄 provider 原文（inputRaw），不许 JSON.stringify 重排版");
  db.close();
});

test("前缀纪律：靠前目录的按需工具晚激活，也只能追加在工具数组尾部（Fix 2 回归）", async () => {
  deactivateAll();
  const wires: Wire[] = [];
  const { run, db } = harness("th_prefix_tools", () => [
    // 先激活**目录里靠后**的终端工具（TerminalSend → 连带 open/read/close/list）
    { calls: [{ name: "ToolSearch", args: { query: "TerminalSend", limit: 3 } }] },
    // 再激活**目录里靠前**的 WebSearch —— 正是这一步在「按目录顺序过滤」的旧实现里会插入到终端工具之前
    { calls: [{ name: "ToolSearch", args: { query: "WebSearch", limit: 3 } }] },
    { calls: [{ name: "AttemptCompletion", args: { summary: "搜完了" } }] },
    { text: "好了" },
  ], wires);
  await run("给我开个常驻终端，再搜一下资料");

  assert.equal(wires.length, 4, "桩 provider 应该被调用四步");
  const [w0, w1, w2, w3] = wires.map((w) => w.tools);
  const prefixOf = (a: string[], b: string[]) => assert.deepEqual(b.slice(0, a.length), a,
    `工具数组只能尾部增长：\n  上一份 ${JSON.stringify(a)}\n  这一份 ${JSON.stringify(b)}`);

  prefixOf(w0!, w1!);   // 没激活：逐字不变
  prefixOf(w1!, w2!);   // 激活 TerminalSend：尾部追加
  prefixOf(w2!, w3!);   // 激活 WebSearch：仍只许尾部追加
  assert.deepEqual(w3, w2, "激活完就不再变");
  assert.ok(w1!.includes("TerminalSend") && w2!.includes("WebSearch"), "两个工具都要在表里");
  assert.ok(w2!.indexOf("TerminalSend") < w2!.indexOf("WebSearch"),
    "晚激活的 WebSearch 必须排在已激活的终端工具**之后**（插到前面 = 后面的 schema 全部位移，缓存作废）");
  // WebSearch 是在第 2 步的 ToolSearch 里激活的，所以它**只允许**出现在 w2 比 w1 多出来的那一段里
  const added = w2!.slice(w1!.length);
  assert.ok(added.includes("WebSearch"), `WebSearch 必须是新追加的那一段：${JSON.stringify(added)}`);
  assert.equal(w1!.indexOf("WebSearch"), -1, "激活前它不该在表里");
  db.close();
});

test("前缀纪律：崩溃修复交代贴在当前 user 消息上，历史第一条逐字节不动（Fix 3）", async () => {
  deactivateAll();
  const wires: Wire[] = [];
  const { run, store, db } = harness("th_prefix_repair", () => [{ text: "好的" }, { text: "好的" }], wires);
  await run("第一轮：先说一句");
  // 造一条「调用了但没有结果」的历史（输入已给、状态还没落地 = 上一次崩溃的位置）
  const dangling: Message = {
    id: "th_prefix_repair--a-crash", threadId: "th_prefix_repair", role: "assistant", createdAt: 0,
    parts: [{ type: "tool-Write", toolCallId: "c_orphan", toolName: "Write", state: "input-available", input: { file_path: "/tmp/x" } } as ToolPart],
  };
  store.addMessage(dangling);
  await run("接着刚才的活儿干");

  const wire = wires[1]!.messages;
  const users = wire.filter((m) => m.role === "user");
  assert.equal(users.length, 2, "历史一条 + 本轮一条");
  const first = String(users[0]!.content);
  const last = String(users[1]!.content);

  // 历史第一条逐字节 = 它**当轮**上过 wire 的那份（尾上下文贴上去时就落库、之后原样重放）。
  // Fix 3 的实质一字未变：它绝不能被**这一轮**的修复交代改写 —— 交代说的是「刚发生」的事。
  assert.equal(first, `[Context: ${TAIL}]\n\n第一轮：先说一句`, "历史第一条必须逐字节等于它上过 wire 的原文");
  assert.ok(!first.includes("没有拿到结果"), "修复交代只属于当前这一轮，不许回头改写历史消息");
  assert.match(last, /没有拿到结果/, "交代必须贴在当前这条 user 消息上（契约：注入到最后一条 user 消息前）");
  assert.match(last, /不要直接重放/, "「不许重放、结果未知」的语义一字不改");
  assert.ok(last.endsWith("接着刚才的活儿干"), "交代在原文之前，用户原话逐字节在末尾");
  db.close();
});

test("前缀纪律：并行多调用是一步、串行是两步 —— 步记号把它们分开（item 5 回归）", async () => {
  deactivateAll();
  const wires: Wire[] = [];
  const { run, store, db } = harness("th_prefix_parallel", (file) => [
    // 第一步并行两次 Read（一条 assistant 消息、两个调用）—— parts 里与「两步各一次」一模一样，只有记号分得开
    { text: "我读一下", calls: [{ name: "Read", args: { file_path: file } }, { name: "Read", args: { file_path: file } }] },
    { calls: [{ name: "AttemptCompletion", args: { summary: "读完了" } }] },
    { text: "都读完了" },
  ], wires);
  await run("两个都读一下");

  assert.equal(wires.length, 3, "并行一步 + 声明完成 + 收尾：三次 provider 调用");
  const live = wires[2]!.messages.slice(1).concat([{ role: "assistant", content: "都读完了" }]);
  store.addMessage({
    id: "th_prefix_parallel--u-next", threadId: "th_prefix_parallel", role: "user",
    parts: [{ type: "text", text: "下一轮" }], createdAt: Date.now(),
  });
  const rebuilt = dropLastUser(toWireHistory(store.recentMessages("th_prefix_parallel", 60), "th_prefix_parallel"));
  assertRebuiltMatchesLive(live, rebuilt, "并行调用：实时 wire → 下一轮重建");

  // 并行的一步必须还原成**一条** assistant 消息带两个调用 + 两条结果，而不是两步各一个调用
  assert.deepEqual(rebuilt[1]!.tool_calls?.map((c) => c.function.name), ["Read", "Read"], "一步两个调用不许拆开重建");
  assert.deepEqual(rebuilt.map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant", "tool", "assistant"],
    "并行一步 → 收尾两步的重建序列");
  db.close();
});

test("前缀纪律：闸门提醒 / 中途插话按原位置重放（不再凭空消失，item 4 回归）", async () => {
  deactivateAll();
  const wires: Wire[] = [];
  const { run, store, db } = harness("th_prefix_inject", (file) => [
    // 第 1 步：读文件（有产出但没声明完成）→ 收尾时完成守卫往 wire 里插一条提醒。
    // 这条提醒以前**不落库**：下一轮重建时它凭空消失，从它往后整段按全价重付。
    { text: "我先看看", calls: [{ name: "Read", args: { file_path: file } }] },
    { text: "看完了" },                                          // 触发完成守卫
    { calls: [{ name: "AttemptCompletion", args: { summary: "完成" } }] },  // 守卫拉起来的下一步
    { text: "完成了" },
  ], wires);
  await run("跑一下");

  assert.equal(wires.length, 4, "读 → 被守卫拉起 → 声明完成 → 收尾：四次 provider 调用");
  const live = wires[3]!.messages.slice(1).concat([{ role: "assistant", content: "完成了" }]);
  store.addMessage({
    id: "th_prefix_inject--u-next", threadId: "th_prefix_inject", role: "user",
    parts: [{ type: "text", text: "下一轮" }], createdAt: Date.now(),
  });
  const rebuilt = dropLastUser(toWireHistory(store.recentMessages("th_prefix_inject", 60), "th_prefix_inject"));
  assertRebuiltMatchesLive(live, rebuilt, "闸门提醒：实时 wire → 下一轮重建");

  // 提醒必须以 user 消息的身份出现在**它当时的位置**（第 2 步之后、被拉起的第 3 步之前）
  assert.deepEqual(rebuilt.map((m) => `${m.role}:${m.tool_calls?.map((c) => c.function.name).join("+") ?? ""}`),
    ["user:", "assistant:Read", "tool:", "assistant:", "user:", "assistant:AttemptCompletion", "tool:", "assistant:"],
    "提醒插在第 2 步与第 3 步之间，位置一错缓存前缀就断");
  assert.match(String(rebuilt[4]!.content), /^<system-reminder>/, "闸门提醒原样重放（含外层的 system-reminder 包裹）");
  // 它也确实落成了 parts（injection part）—— 重建重放的就是它
  const assistant = store.listMessages("th_prefix_inject").find((m) => m.role === "assistant")!;
  assert.ok(assistant.parts.some((p) => p.type === "injection"), "中途注入必须落成 injection part，否则下一轮重建无从重放");
  db.close();
});

test("前缀纪律：steering 插话在步边界折叠，落库后与收尾文本同等地被下一轮带上", async () => {
  deactivateAll();
  const wires: Wire[] = [];
  const { run, store, db, file } = harness("th_prefix_steer", (file) => [
    // 插话在第一步开流前入队：这一步的工具批次之后被折叠进对话（loop/turn.ts 的步边界）
    { text: "开始", calls: [{ name: "Read", args: { file_path: file } }], steer: "插一句：先别读别的文件" },
    { text: "好" },
  ], wires);
  await run("先读一个文件");

  assert.equal(wires.length, 1, "插话折叠后这一轮立即收尾：只有第一步上过 wire");
  store.addMessage({
    id: "th_prefix_steer--u-next", threadId: "th_prefix_steer", role: "user",
    parts: [{ type: "text", text: "下一轮" }], createdAt: Date.now(),
  });
  const rebuilt = dropLastUser(toWireHistory(store.recentMessages("th_prefix_steer", 60), "th_prefix_steer"));

  // ① 缓存前缀的来源：重建的第一条必须逐字节等于**实时上过 wire** 的那条（带尾上下文）
  assert.deepEqual(rebuilt[0], wires[0]!.messages[1], "u1（含尾上下文）重建后必须逐字节不变");
  // ② 这一步的 assistant / tool 按实时口径还原
  assert.deepEqual(rebuilt[1], {
    role: "assistant", content: "开始",
    tool_calls: [{ id: "call_1_0", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: file }) } }],
  }, "这一步的调用与文本照旧");
  const stored = store.listMessages("th_prefix_steer").find((m) => m.role === "assistant")!;
  const readPart = stored.parts.find((p) => p.type.startsWith("tool-")) as ToolPart;
  assert.deepEqual(rebuilt[2], { role: "tool", tool_call_id: "call_1_0", name: "Read", content: JSON.stringify(readPart.output ?? {}) },
    "工具结果照旧（能配对的 tool 消息一条不少）");
  // ③ 插话：落成 injection part、在**原位置**（这段历史的最末尾）重放
  //    —— 它和「收尾文本」同命：这一步没来得及发出去，下一轮请求会把它带上；
  //    区别是以前它**谁也没落**，一步之后就从模型的世界里消失了。
  assert.ok(stored.parts.some((p) => p.type === "injection"), "插话必须落成 injection part");
  assert.deepEqual(rebuilt.at(-1), { role: "user", content: "插一句：先别读别的文件" }, "插话原文逐字节重放");
  db.close();
});
