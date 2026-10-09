/**
 * 核心单测：闸门 / 审批 / 预算 / 修复 / parts / 事件日志 / 崩溃修复
 * 运行：npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateGates, newCounters, bumpCounter } from "../src/loop/gates.ts";
import { classifyLocally, redirectsInsideWorkspace, buildApprovalRequest } from "../src/tools/approval.ts";
import { applyBudget } from "../src/tools/budget.ts";
import { repairToolCall } from "../src/tools/repair-call.ts";
import { normalizeToolSchema } from "../src/tools/normalize.ts";
import { canTransition, fixMessageStuckToolStates } from "../src/session/parts.ts";
import { EventLog } from "../src/session/event-log.ts";
import { repairMessages } from "../src/session/repair.ts";
import { applyTailContext, buildWireMessages } from "../src/loop/turn.ts";
import { ON_DEMAND_TOOLS, getTool, currentActiveNames, activateTools } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/types.ts";
import type { Message, ToolPart } from "../src/session/types.ts";
import { applyThreadPolicy, renderPolicyNotice } from "../src/agent/tool-policy.ts";
import { TaskRegistry } from "../src/agents/task-registry.ts";
import { Db } from "../src/session/db.ts";
import { RedactStream } from "../src/security/redact-stream.ts";
import { redact as activityRedact } from "../src/activity/redact.ts";

const fakeTool = (over: Partial<Tool>): Tool => ({
  name: "Read", description: "读文件",
  parameters: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "number" } }, required: ["file_path"] },
  outputTier: "exact", approval: "never", concurrencySafe: true,
  execute: async () => ({}), ...over,
});

// ── 闸门 ────────────────────────────────────────────
test("闸门：steering 优先级最高", () => {
  const d = evaluateGates({
    steerPending: true, sawAttemptCompletion: false, sawPermissionDenied: true,
    finishReason: "tool_calls", toolCallCount: 1, toolResultCount: 0,
    sawVisibleOutput: true, hadToolCalls: true, aborted: false,
  }, newCounters());
  assert.equal(d.gate, "steering");
});

test("闸门：②③④ 互斥 —— 完成守卫命中时不评估权限续跑", () => {
  const d = evaluateGates({
    steerPending: false, sawAttemptCompletion: false, sawPermissionDenied: true,
    finishReason: "stop", toolCallCount: 2, toolResultCount: 2,
    sawVisibleOutput: true, hadToolCalls: true, aborted: false,
  }, newCounters());
  assert.equal(d.gate, "completion-guard");
});

test("闸门：纯聊天回合不触发完成守卫（否则模型会把答案说两遍）", () => {
  const d = evaluateGates({
    steerPending: false, sawAttemptCompletion: false, sawPermissionDenied: false,
    finishReason: "stop", toolCallCount: 0, toolResultCount: 0,
    sawVisibleOutput: true, hadToolCalls: false, aborted: false,
  }, newCounters());
  assert.equal(d.gate, null);
});

test("闸门：完成守卫的提醒明确禁止复述", () => {
  const d = evaluateGates({
    steerPending: false, sawAttemptCompletion: false, sawPermissionDenied: false,
    finishReason: "stop", toolCallCount: 1, toolResultCount: 1,
    sawVisibleOutput: true, hadToolCalls: true, aborted: false,
  }, newCounters());
  assert.match(d.reminder ?? "", /绝对不要重复/);
});

test("闸门：自动续跑受上限约束", () => {
  const c = newCounters();
  c.autoContinue = 10;
  const d = evaluateGates({
    steerPending: false, sawAttemptCompletion: true, sawPermissionDenied: false,
    finishReason: "tool_calls", toolCallCount: 1, toolResultCount: 1,
    sawVisibleOutput: true, hadToolCalls: true, aborted: false,
  }, c);
  assert.equal(d.gate, null, "到达上限后不再续跑");
});

test("闸门：计数器按闸门类型独立累加", () => {
  const c = newCounters();
  bumpCounter(c, "auto-continue"); bumpCounter(c, "auto-continue"); bumpCounter(c, "completion-guard");
  assert.deepEqual(c, { autoContinue: 2, completionGuard: 1, permissionContinue: 0 });
});

// ── 审批 ────────────────────────────────────────────
test("审批：只读命令直接放行", () => {
  assert.equal(classifyLocally("ls -la", "/tmp/ws"), "safe");
  assert.equal(classifyLocally("git status", "/tmp/ws"), "safe");
});

test("审批：破坏性命令要权限", () => {
  assert.equal(classifyLocally("rm -rf /tmp/x", "/tmp/ws"), "medium");
  assert.equal(classifyLocally("npm install lodash", "/tmp/ws"), "medium");
});

test("审批：工作区内重定向放行，区外拦截", () => {
  assert.equal(classifyLocally("echo hi > /tmp/ws/out.txt", "/tmp/ws"), "low");
  assert.equal(classifyLocally("echo hi > /etc/passwd", "/tmp/ws"), "medium");
  assert.equal(redirectsInsideWorkspace("echo x > /tmp/ws/a.txt", "/tmp/ws"), true);
  assert.equal(redirectsInsideWorkspace("echo x > /etc/passwd", "/tmp/ws"), false);
});

test("审批：高风险请求标 danger 信息", () => {
  const r = buildApprovalRequest("rm -rf /", "high");
  assert.equal(r.riskLevel, "high");
  assert.match(r.message, /风险等级：HIGH/);
  assert.match(r.message, /可能.*修改文件/);
});

// ── 输出预算 ─────────────────────────────────────────
test("预算：小结果原样返回", async () => {
  const r = await applyBudget(fakeTool({}), { content: "hello" }, "/tmp/x", "c1");
  assert.equal(r.truncated, false);
});

test("预算：大结果被截断且带 spill 与三要素说明", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dove-budget-"));
  const r = await applyBudget(fakeTool({ outputTier: "compact" }), { stdout: "x".repeat(80_000) }, dir, "c9");
  assert.equal(r.truncated, true);
  assert.ok(r.spillPath, "应生成存档路径");
  const s = JSON.stringify(r.result);
  assert.ok(s.length < 8_000, `预算后应 ≤8000 字符，实际 ${s.length}`);
  assert.ok(s.includes("不完整的输出"), "要素①：明说不完整");
  assert.ok(s.includes("存档"), "要素②：明说存档路径");
  assert.ok(s.includes("摘录覆盖"), "要素③：明说搜索只算摘录");
});

// ── 调用修复 ─────────────────────────────────────────
test("修复：别名 + 参数错名 + 类型强转", () => {
  const tools = [fakeTool({})];
  const r = repairToolCall("read_file", { path: "/a/b", n: "5" }, tools);
  assert.ok(r);
  assert.equal(r.name, "Read");
  assert.equal(r.args.file_path, "/a/b");
  assert.equal(r.args.limit, 5);
});

test("修复：JSON 字符串参数", () => {
  const tools = [fakeTool({ name: "Bash", parameters: { type: "object", properties: { command: { type: "string" } } } })];
  const r = repairToolCall("run_command", '{"cmd":"ls"}', tools);
  assert.ok(r);
  assert.equal(r.name, "Bash");
  assert.equal(r.args.command, "ls");
});

test("修复：完全未知的工具返回 null", () => {
  assert.equal(repairToolCall("zzz_unknown_tool_zzz", {}, [fakeTool({})]), null);
});

test("归一化：schema 清洗后仍是 object", () => {
  const s = normalizeToolSchema(fakeTool({ parameters: { $schema: "x", type: "object", properties: { a: { type: "string" } }, additionalProperties: false } }));
  assert.equal(s.function.parameters.type, "object");
  assert.equal((s.function.parameters as Record<string, unknown>).$schema, undefined, "$schema 应被剔除");
});

// ── parts 状态机 ─────────────────────────────────────
test("parts：非法流转被拒绝", () => {
  assert.equal(canTransition("output-available", "streaming"), false);
  assert.equal(canTransition("input-available", "output-available"), true);
  assert.equal(canTransition(undefined, "streaming"), true);
});

test("parts：卡住的状态能被修正为终态", () => {
  const msg: Message = {
    id: "m", threadId: "t", role: "assistant", createdAt: 0,
    parts: [{ type: "tool-Bash", toolCallId: "c1", toolName: "Bash", state: "input-available" } as ToolPart],
  };
  assert.equal(fixMessageStuckToolStates(msg), true);
  assert.equal(msg.parts[0]!.state, "output-error");
});

// ── 事件日志 ─────────────────────────────────────────
test("事件日志：seq 单调，重启后继续", () => {
  const dir = mkdtempSync(join(tmpdir(), "dove-log-"));
  const l1 = new EventLog({ dir, sessionKey: "s1" });
  l1.append("turn_start", { a: 1 }); l1.append("turn_end", { b: 2 });
  assert.equal(l1.seq, 2);
  const l2 = new EventLog({ dir, sessionKey: "s1" });
  l2.append("turn_start", { c: 3 });
  assert.equal(l2.seq, 3, "重启后 seq 必须继续，不能回退");
  assert.equal(l2.readAll().length, 3);
});

// ── 崩溃修复 ─────────────────────────────────────────
test("崩溃修复：未配对的 tool_call 被识别，且不重放", () => {
  const msgs: Message[] = [{
    id: "m", threadId: "t", role: "assistant", createdAt: 0,
    parts: [
      { type: "tool-Bash", toolCallId: "c1", toolName: "Bash", state: "output-available", input: { command: "ls" } } as ToolPart,
      { type: "tool-Write", toolCallId: "c2", toolName: "Write", state: "input-available", input: { file_path: "/x" } } as ToolPart,
    ],
  }];
  const r = repairMessages(msgs);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.toolCallId, "c2");
  assert.match(r.notice, /没有拿到结果/);
  assert.match(r.notice, /不要直接重放/);
});

// ── 上下文注入 ───────────────────────────────────────
test("上下文：mt 与记忆块 prepend 到最后一条 user 消息", () => {
  const msgs = [
    { role: "user" as const, content: "第一条" },
    { role: "assistant" as const, content: "回复" },
    { role: "user" as const, content: "最新一条" },
  ];
  const out = applyTailContext(msgs, "<reminder>now</reminder>", "## Relevant Memories\n1. 用户喜欢暖色");
  assert.match(String(out[2]!.content), /^\[Context: <reminder>now<\/reminder>\]/);
  assert.match(String(out[2]!.content), /Relevant Memories/);
  assert.match(String(out[2]!.content), /最新一条$/);
  assert.equal(out[0]!.content, "第一条", "历史消息不能被污染");
});

test("上下文：双 system 块按 SYSTEM INFO 行切分", () => {
  const prompt = "身份段\n\nSYSTEM INFO - 你运行在 macOS。\n\n后面还有很多";
  const out = buildWireMessages(prompt, [{ role: "user", content: "hi" }], true);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.role, "system");
  assert.equal(out[1]!.role, "system");
  assert.match(String(out[1]!.content), /^SYSTEM INFO/);
});

// ── 线程策略（D8：Home 只读） ─────────────────────────
test("策略：Home 线程拿不到写类工具", () => {
  const tools = new Map<string, Tool>([
    ["Read", fakeTool({ name: "Read" })],
    ["Write", fakeTool({ name: "Write" })],
    ["Bash", fakeTool({ name: "Bash" })],
    ["ProjectPreview", fakeTool({ name: "ProjectPreview" })],   // 工具已删，但策略表按名字过滤，留着验证行为
    ["AttemptCompletion", fakeTool({ name: "AttemptCompletion" })],
    ["DispatchToProject", fakeTool({ name: "DispatchToProject" })],
  ]);
  const r = applyThreadPolicy("home", tools);
  assert.ok(r.tools.has("Read"), "只读工具应保留");
  assert.ok(r.tools.has("AttemptCompletion"), "元工具应保留");
  assert.ok(r.tools.has("DispatchToProject"), "调度工具应保留");
  assert.ok(!r.tools.has("Write"), "Write 必须被裁掉");
  assert.ok(!r.tools.has("Bash"), "Bash 必须被裁掉（它能写文件）");
  // ProjectBuild / VersionList / VersionRestore 已移除（版本与构建改走 Bash + 分类器）
  assert.deepEqual(r.blocked.sort(), ["Bash", "Write"]);
});

test("策略：项目线程不受影响", () => {
  const tools = new Map<string, Tool>([["Write", fakeTool({ name: "Write" })]]);
  const r = applyThreadPolicy("project", tools);
  assert.ok(r.tools.has("Write"));
  assert.equal(r.blocked.length, 0);
});

test("策略：Home 的提示词明确告知被裁能力与替代方式", () => {
  const notice = renderPolicyNotice("home", ["Write", "Bash"], ["studio"]);
  assert.match(notice, /调度台/);
  assert.match(notice, /DispatchToProject/);
  assert.match(notice, /studio/);
  assert.equal(renderPolicyNotice("project", ["Write"], []), "", "项目线程不该有这段提示");
});

// ── 后台任务：防重复注入 ──────────────────────────────
test("后台任务：claimPendingInjections 只返回一次（防重复注入）", () => {
  const db = new Db(":memory:");
  const reg = new TaskRegistry(db);
  const t = reg.create({ threadId: "th1", prompt: "查一下 X" });
  reg.finish(t.id, "X 的结论是 Y");

  const first = reg.claimPendingInjections("th1");
  assert.equal(first.length, 1);
  assert.equal(first[0]!.result, "X 的结论是 Y");

  const second = reg.claimPendingInjections("th1");
  assert.equal(second.length, 0, "第二次必须为空 —— 否则模型会反复看到同一份结果");
  db.close();
});

test("后台任务：还在跑的任务不会被注回", () => {
  const db = new Db(":memory:");
  const reg = new TaskRegistry(db);
  reg.create({ threadId: "th2", prompt: "慢任务" });
  assert.equal(reg.claimPendingInjections("th2").length, 0);
  db.close();
});

// ── 回复层脱敏（T8.1） ────────────────────────────────
test("脱敏：密钥被切成多块也不会漏（流式）", () => {
  const s = new RedactStream();
  let out = s.push("你的 key 是 sk-abcdefgh");
  out += s.push("ijklmnopqrstuvwx");
  out += s.push("yz1234567890 收好");
  out += s.flush();
  assert.ok(!out.includes("sk-abcdefgh"), "密钥不能出现在输出里");
  assert.match(out, /\[REDACTED:API_KEY\]/);
});

test("脱敏：普通文本零损伤", () => {
  const s = new RedactStream();
  const parts = ["今天天气不错，", "适合改配色。", "构建也通过了。"];
  const out = parts.map((p) => s.push(p)).join("") + s.flush();
  assert.equal(out, parts.join(""));
  assert.deepEqual(s.hits, {});
});

test("脱敏：私钥块跨块被整块扣住", () => {
  const s = new RedactStream();
  let out = s.push("看到这个：-----BEGIN RSA PRIVATE KEY-----\nMIIE");
  out += s.push("owIBAAKCAQEA1234\n");
  out += s.push("-----END RSA PRIVATE KEY-----\n结束");
  out += s.flush();
  assert.ok(!out.includes("BEGIN RSA"), "私钥块不能泄漏");
  assert.ok(out.endsWith("结束"), "块后面的正常内容要保留");
});

test("脱敏：卡号走 Luhn 校验（假卡号不误伤）", () => {
  const s1 = new RedactStream();
  const real = s1.push("卡号 4111 1111 1111 1111") + s1.flush();
  assert.ok(!real.includes("4111"), "真卡号要脱敏");

  const s2 = new RedactStream();
  const fake = s2.push("编号 1234 5678 9012 3456") + s2.flush();
  assert.ok(fake.includes("1234"), "Luhn 不过的数字不该被误伤");
});

test("脱敏：活动层的旧入口仍然可用（转发没断）", () => {
  // 注意：同一段文本可能同时命中多条规则（"token sk-…" 会先被 BEARER_TOKEN 吃掉），
  // 所以这里断言「密钥确实没了」，不断言具体是哪个 kind。
  const out = activityRedact("token sk-abcdefghijklmnopqrstuvwxyz123456");
  assert.ok(!out.text.includes("sk-abcdefgh"), "密钥必须被脱掉");
  assert.match(out.text, /\[REDACTED:/);
  assert.ok(Object.keys(out.hits).length >= 1, "至少命中一条规则");
});

// ── 只读权威（T8.2） ──────────────────────────────────
test("只读模式：连派活和子代理都被裁掉（不只是写文件）", () => {
  const tools = new Map<string, Tool>([
    ["Read", fakeTool({ name: "Read" })],
    ["Write", fakeTool({ name: "Write" })],
    ["Bash", fakeTool({ name: "Bash" })],
    ["DispatchToProject", fakeTool({ name: "DispatchToProject" })],
    ["Task", fakeTool({ name: "Task" })],
    ["GeneratePPT", fakeTool({ name: "GeneratePPT" })],
    ["AskUserQuestion", fakeTool({ name: "AskUserQuestion" })],
  ]);
  const r = applyThreadPolicy("project", tools, { readOnly: true });
  assert.equal(r.reason, "read-only");
  assert.ok(r.tools.has("Read"));
  assert.ok(r.tools.has("AskUserQuestion"), "提问是允许的（只读不等于不许沟通）");
  for (const blocked of ["Write", "Bash", "DispatchToProject", "Task", "GeneratePPT"]) {
    assert.ok(!r.tools.has(blocked), blocked + " 在只读模式下必须被裁掉");
  }
});

test("只读提示词：明确禁止生成报告/计划/临时脚本", () => {
  const notice = renderPolicyNotice("project", ["Write", "Bash"], [], "read-only");
  assert.match(notice, /只读/);
  assert.match(notice, /不要.*生成报告文件、计划文件、副本或临时脚本/);
  assert.match(notice, /停下来问用户/);
});

test("按需工具：每个都要写 discoverable（否则模型不知道该搜什么）", () => {
  // 为什么必须有：按需工具不在默认工具表里，模型只能靠 ToolSearch 的描述知道有什么可搜。
  // 曾经那句描述是手写的四个例子，**漏了 Task（子代理）**，
  // 后果是用户让模型派子代理，模型压根不知道有这个能力。
  for (const t of ON_DEMAND_TOOLS) {
    assert.ok(t.discoverable && t.discoverable.trim().length > 0, t.name + " 缺 discoverable");
  }
});

test("按需工具：ToolSearch 的描述必须列出全部（不能手写漏项）", () => {
  const desc = getTool("ToolSearch")!.description;
  for (const t of ON_DEMAND_TOOLS) {
    assert.ok(desc.includes(t.name), "ToolSearch 描述里没提 " + t.name);
  }
});

test("按需工具：激活是追加式的（前缀不变，缓存不受影响）", () => {
  const before = currentActiveNames();
  activateTools(["WebSearch"]);
  const after = currentActiveNames();
  assert.deepEqual(after.slice(0, before.length), before);
  assert.ok(after.length >= before.length);
});

test("只读不是 Home：项目线程开只读后依然比 Home 宽（不引入调度约束）", () => {
  const tools = new Map<string, Tool>([
    ["Read", fakeTool({ name: "Read" })],
    ["Grep", fakeTool({ name: "Grep" })],
    ["Write", fakeTool({ name: "Write" })],
  ]);
  const home = applyThreadPolicy("home", tools);
  const ro = applyThreadPolicy("project", tools, { readOnly: true });
  assert.equal(home.reason, "home");
  assert.equal(ro.reason, "read-only");
  assert.ok(ro.tools.has("Grep") && home.tools.has("Grep"));
});
