/**
 * 审批策略链 + 路径冲突调度（权限与调度这一块的验收）——盯的是**契约**，不是「大概能用」：
 * ① 写类与读类不许重叠（旧实现「写类独占是假的」已复现并钉死）；② 无关的读真并行、同路径的写真串行、
 * 提交顺序不被插队；③ 未声明 accesses 的工具一律按独占处理；④ 策略链有序，auto 无分类器/抛错必须 ask；
 * ⑤ Write/Edit 无 command → never 档兜底放行（刻意保留的既有行为）；⑥ 会话规则的解析/持久化/上限/措辞。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { PendingRegistry } from "../src/agent/pending.ts";
import { executeBatch, executeOne, type ExecDeps } from "../src/loop/tool-exec.ts";
import { parseRule, ruleMatches, ruleMatchesTool, argGlobMatches, rememberSessionRule, sessionRuleDecision, readSessionRules, nextRuleSet, SESSION_RULES_KEY } from "../src/tools/rule-pattern.ts";
import { WriteTool } from "../src/tools/builtin/write.ts";
import { EditTool } from "../src/tools/builtin/edit.ts";
import { APPROVAL_RULE_MAX_CHARS, APPROVAL_SESSION_RULE_MAX } from "../src/constants.ts";
import type { Tool, ToolContext } from "../src/tools/types.ts";
import { normalizeProfile, type PermissionProfile } from "../src/tools/permission.ts";
import type { ToolCallPayload } from "../src/providers/types.ts";

const WS = "/ws";
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Timeline { events: string[]; start: (n: string) => void; end: (n: string) => void }
function timeline(): Timeline {
  const events: string[] = [];
  return { events, start: (n) => { events.push("start " + n); }, end: (n) => { events.push("end " + n); } };
}

function fakeTool(over: Partial<Tool> & { name: string }): Tool {
  return { description: over.name, parameters: { type: "object", properties: {}, required: [] }, outputTier: "exact", approval: "never", concurrencySafe: true, execute: async () => ({ ok: true }), ...over };
}
const paths = (p: string, operation: "read" | "search" | "write", recursive = false) =>
  ({ kind: "paths", paths: [{ path: p, operation, recursive }] }) as const;
const call = (name: string, args: Record<string, unknown>, id = name.toLowerCase() + "_1"): ToolCallPayload =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const commandTool = (over: Partial<Tool> & { name: string }): Tool =>
  fakeTool({ approvalRule: (a) => (typeof a.command === "string" ? a.command : undefined), ...over });

function ctxBase(events?: { type: string; [k: string]: unknown }[], threadId = "th_t"): Omit<ToolContext, "toolCallId" | "requestApproval"> {
  return { threadId, workdir: WS, outputsDir: join(WS, "outputs"), emit: (type, data) => { events?.push({ type, ...data }); }, services: {} };
}
interface DepsOpts {
  tools: Tool[];
  threadId?: string;   // 会话规则按线程存；store 里用哪个 id 就必须传哪个（缺省 th_t）
  store?: ExecDeps["store"];
  /** 旧枚举档位 → 按预设绑定成两轴 profile（测试里读起来更短，语义与线上一致） */
  permissionMode?: "read-only" | "workspace-write" | "danger-full-access" | "auto";
  /** 直接给 profile（要测 writableRoots 之类的新字段时用） */
  permission?: PermissionProfile;
  classifier?: ExecDeps["classifier"];
  events?: { type: string; [k: string]: unknown }[];
  approve?: () => { approved: boolean; remember?: boolean; reason?: string };
  onApprovalNeeded?: ExecDeps["onApprovalNeeded"];
}
function depsOf(o: DepsOpts): ExecDeps {
  return {
    tools: new Map(o.tools.map((t) => [t.name, t])), ctxBase: ctxBase(o.events, o.threadId),
    resolveApproval: async () => {
      const v = o.approve?.() ?? { approved: true, remember: false };
      // ⚠️ remember 要显式进对象再断言：写成 `{...} as never, ...(v.remember ? ...)` 时会被当成断言的一部分，remember 永远传不出去（踩过）
      return { approved: v.approved, reason: v.reason as "user" | "timeout" | "no-window" | undefined, decision: v.approved ? "allow" : "deny", ...(v.remember === true ? { remember: true } : {}) } as never;
    },
    onApprovalNeeded: o.onApprovalNeeded, classifier: o.classifier, store: o.store,
    permission: o.permission ?? normalizeProfile({ permissionMode: o.permissionMode }),
  };
}
/** 恰好出现一次 start / end，且 start 在 end 前 */
function ranOnce(t: Timeline, name: string): void {
  const s = t.events.indexOf("start " + name), e = t.events.indexOf("end " + name);
  assert.ok(s >= 0 && e >= 0 && s < e, name + " 必须完整跑一次（实际：" + t.events.join(" | ") + "）");
  assert.equal(t.events.filter((x) => x === "start " + name).length, 1, name + " 只能启动一次");
}
/** later 的 start 之前，earlier 必须已经结束 */
function finishedBeforeStart(t: Timeline, later: string, earlier: string): void {
  const i = t.events.indexOf("start " + later);
  assert.ok(i >= 0, later + " 应该启动（实际：" + t.events.join(" | ") + "）");
  assert.ok(t.events.slice(0, i).includes("end " + earlier), later + " 开跑时 " + earlier + " 还没结束 = 又重叠了");
}
/** 两个操作的并发窗口真的重叠过 */
function overlapped(t: Timeline, a: string, b: string): void {
  const as = t.events.indexOf("start " + a), ae = t.events.indexOf("end " + a);
  const bs = t.events.indexOf("start " + b), be = t.events.indexOf("end " + b);
  assert.ok(as >= 0 && ae >= 0 && bs >= 0 && be >= 0, "两个都要跑完");
  assert.ok((as < bs && bs < ae) || (bs < as && as < be), "两个读应该在同一个窗口里重叠（实际：" + t.events.join(" | ") + "）");
}

// ── ① 调度：回归旧 bug（写与读重叠） ──────────────────
test("调度：同批次 [Read X, Write X, Grep X] 写不许与读重叠（旧 bug 是写先开跑）", async () => {
  const t = timeline();
  const readTool = fakeTool({ name: "Read", accesses: () => paths(join(WS, "x.txt"), "read"),
    execute: async () => { t.start("read"); await delay(30); t.end("read"); return { ok: true }; } });
  const writeTool = fakeTool({ name: "Write", accesses: () => paths(join(WS, "x.txt"), "write"),
    execute: async () => { t.start("write"); await delay(1); t.end("write"); return { ok: true }; } });
  const grepTool = fakeTool({ name: "Grep", accesses: () => paths(join(WS, "x.txt"), "search"),
    execute: async () => { t.start("grep"); await delay(5); t.end("grep"); return { ok: true }; } });
  const out = await executeBatch([call("Read", { file_path: "x.txt" }), call("Write", { file_path: "x.txt" }), call("Grep", { path: "x.txt" })], depsOf({ tools: [readTool, writeTool, grepTool] }));

  for (const n of ["read", "write", "grep"]) ranOnce(t, n);
  assert.deepEqual(out.map((o) => o.toolName), ["Read", "Write", "Grep"], "结果必须按模型给的调用顺序");
  finishedBeforeStart(t, "write", "read");
  finishedBeforeStart(t, "write", "grep");
});

test("调度：两个不相干路径的读真的重叠（并发窗口内都在跑）", async () => {
  const t = timeline();
  // 工具名必须挑不撞车的：repairToolCall 拿名字做前缀模糊匹配，ReadA/Read1 会被整形成 Read（实测踩过）
  const mk = (name: string, file: string) => fakeTool({ name, accesses: () => paths(join(WS, file), "read"),
    execute: async () => { t.start(name.toLowerCase()); await delay(25); t.end(name.toLowerCase()); return { ok: true }; } });
  await executeBatch([call("AlphaRead", { file_path: "a.txt" }), call("BetaRead", { file_path: "b.txt" })], depsOf({ tools: [mk("AlphaRead", "a.txt"), mk("BetaRead", "b.txt")] }));
  overlapped(t, "alpharead", "betaread");
});

test("调度：同一路径的两个写严格串行，顺序 == 提交顺序", async () => {
  const t = timeline();
  const mk = (name: string, ms: number) => fakeTool({ name, accesses: () => paths(join(WS, "same.txt"), "write"),
    execute: async () => { t.start(name.toLowerCase()); await delay(ms); t.end(name.toLowerCase()); return { ok: true }; } });
  const out = await executeBatch([call("ZedWriteOne", { file_path: "same.txt" }), call("ZedWriteTwo", { file_path: "same.txt" })], depsOf({ tools: [mk("ZedWriteOne", 12), mk("ZedWriteTwo", 1)] }));
  finishedBeforeStart(t, "zedwritetwo", "zedwriteone");   // 后写的必须等先写完
  assert.deepEqual(out.map((o) => o.toolName), ["ZedWriteOne", "ZedWriteTwo"]);
  assert.deepEqual(t.events, ["start zedwriteone", "end zedwriteone", "start zedwritetwo", "end zedwritetwo"], "严格串行且顺序 == 提交顺序");
});

test("调度：入队不插队 —— [读 A（慢）, 写 A] 里写不能抢在 A 前面启动", async () => {
  const t = timeline();
  const readTool = fakeTool({
    name: "Read", accesses: () => paths(join(WS, "a.txt"), "read"),
    execute: async () => { t.start("read"); await delay(30); t.end("read"); return { ok: true }; },
  });
  const writeTool = fakeTool({
    name: "Write", accesses: () => paths(join(WS, "a.txt"), "write"),
    execute: async () => { t.start("write"); await delay(1); t.end("write"); return { ok: true }; },
  });
  await executeBatch([call("Read", { file_path: "a.txt" }), call("Write", { file_path: "a.txt" })], depsOf({ tools: [readTool, writeTool] }));
  assert.deepEqual(t.events, ["start read", "end read", "start write", "end write"]);
});

test("调度：未声明 accesses 的工具与任何工具都冲突（保守串行）", async () => {
  const t = timeline();
  const mkRead = (name: string) => fakeTool({ name, accesses: () => paths(join(WS, "x.txt"), "read"),
    execute: async () => { t.start(name.toLowerCase()); await delay(3); t.end(name.toLowerCase()); return { ok: true }; } });
  const undeclared = fakeTool({   // 故意不给 accesses：等价于 kind:"all"
    name: "Bash",
    execute: async () => { t.start("bash"); await delay(3); t.end("bash"); return { ok: true }; },
  });
  await executeBatch([call("GammaRead", { file_path: "x.txt" }), call("Bash", { command: "echo hi" }), call("DeltaRead", { file_path: "x.txt" })], depsOf({ tools: [mkRead("GammaRead"), undeclared, mkRead("DeltaRead")] }));
  // 两个读之间不冲突（读读可重叠），钉的是：Bash 与任何工具都冲突，必须等两个读都结束
  finishedBeforeStart(t, "bash", "gammaread");
  finishedBeforeStart(t, "bash", "deltaread");
});

test("调度：路径前缀要卡边界 —— /ws/app 的递归读不与 /ws/app2 的写冲突", async () => {
  const t = timeline();
  const readTool = fakeTool({
    name: "Read", accesses: () => paths(join(WS, "app"), "read", true),
    execute: async () => { t.start("read"); await delay(25); t.end("read"); return { ok: true }; },
  });
  const writeTool = fakeTool({
    name: "Write", accesses: () => paths(join(WS, "app2", "x.txt"), "write"),
    execute: async () => { t.start("write"); await delay(2); t.end("write"); return { ok: true }; },
  });
  await executeBatch([call("Read", { file_path: "app" }), call("Write", { file_path: "app2/x.txt" })], depsOf({ tools: [readTool, writeTool] }));
  // 无冲突 → 两个都立刻启动；裸 startsWith 会把 app2 误判成在 app 之下（那才是 bug）
  overlapped(t, "read", "write");
});

test("调度：recursive 的目录读覆盖子路径 —— 往该目录里写要等它", async () => {
  const t = timeline();
  const readTool = fakeTool({
    name: "Read", accesses: () => paths(join(WS, "app"), "read", true),
    execute: async () => { t.start("read"); await delay(25); t.end("read"); return { ok: true }; },
  });
  const writeTool = fakeTool({
    name: "Write", accesses: () => paths(join(WS, "app", "src", "x.ts"), "write"),
    execute: async () => { t.start("write"); await delay(1); t.end("write"); return { ok: true }; },
  });
  await executeBatch([call("Read", { file_path: "app" }), call("Write", { file_path: "app/src/x.ts" })], depsOf({ tools: [readTool, writeTool] }));
  finishedBeforeStart(t, "write", "read");
});

// ── ② 审批：策略链 ────────────────────────────────────
test("审批链：full-access 压过 always 档（任何操作都不审批）", async () => {
  let asked = 0;
  const out = await executeOne(call("RunScript", { script: "x" }), depsOf({
    tools: [fakeTool({ name: "RunScript", approval: "always" })], permissionMode: "danger-full-access", onApprovalNeeded: () => { asked++; },
  }));
  assert.equal(out.ok, true);
  assert.equal(asked, 0, "full-access 下不该再问");
  assert.equal(out.approval, undefined);
});

test("审批链：会话规则压过 always 档（记住的那条先获胜）", async () => {
  const store = new Store(new Db(":memory:"));
  store.createThread({ id: "th_r", kind: "project", title: "t" });
  // 参数名避开 script/cmd/note —— repair-call 的别名表会把它们改写成 command（实测踩过）
  const tool = fakeTool({ name: "RunScript", approval: "always", approvalRule: (a) => String(a.payload ?? "") });
  assert.equal(rememberSessionRule(store, "th_r", "RunScript", { payload: "deploy" }, tool, "allow"), "RunScript(deploy)");

  let asked = 0;
  const out = await executeOne(call("RunScript", { payload: "deploy" }), depsOf({ tools: [tool], store, threadId: "th_r", approve: () => ({ approved: false, reason: "user" }), onApprovalNeeded: () => { asked++; } }));
  assert.equal(asked, 0, "命中会话规则后不该再问");
  assert.equal(out.ok, true, "记住的是允许 → 工具照常执行");
});

test("审批链：auto 没有分类器 → ask（fail-safe，绝不 fail-open）", async () => {
  let asked = 0;
  const out = await executeOne(call("Bash", { command: "ls -la" }), depsOf({
    tools: [fakeTool({ name: "Bash", approval: "heuristic" })], permissionMode: "auto",
    approve: () => ({ approved: false, reason: "user" }), onApprovalNeeded: () => { asked++; },
  }));
  assert.equal(asked, 1, "没有分类器时必须弹审批");
  assert.equal(out.denied, true);
});

test("审批链：auto 的分类器抛错 → ask（保守要权限）；分类器说没事 → allow", async () => {
  let asked = 0;
  const boom = await executeOne(call("Bash", { command: "deploy" }), depsOf({
    tools: [fakeTool({ name: "Bash", approval: "heuristic" })], permissionMode: "auto",
    classifier: async () => { throw new Error("模型不可用"); },
    approve: () => ({ approved: false, reason: "user" }), onApprovalNeeded: () => { asked++; },
  }));
  assert.equal(asked, 1, "分类器炸了必须退化成 ask");
  assert.equal(boom.denied, true);

  const ok = await executeOne(call("Bash", { command: "ls" }), depsOf({
    tools: [fakeTool({ name: "Bash", approval: "heuristic" })], permissionMode: "auto", classifier: async () => null,
    onApprovalNeeded: () => { asked++; },
  }));
  assert.equal(asked, 1, "分类器说没事就不该再问");
  assert.equal(ok.ok, true);
});

test("审批链：heuristic 命中本地 safe → allow；medium → ask", async () => {
  const bash = fakeTool({ name: "Bash", approval: "heuristic" });
  let asked = 0;
  const deps1 = depsOf({ tools: [bash], approve: () => ({ approved: true }), onApprovalNeeded: () => { asked++; } });
  assert.equal((await executeOne(call("Bash", { command: "git status" }), deps1)).ok, true);
  assert.equal(asked, 0, "safe 命令不该问");
  const deps2 = depsOf({ tools: [bash], approve: () => ({ approved: false, reason: "user" }), onApprovalNeeded: () => { asked++; } });
  assert.equal((await executeOne(call("Bash", { command: "rm -rf /tmp/x" }), deps2)).denied, true);
  assert.equal(asked, 1, "medium 命令必须问");
});

test("审批链：Write/Edit（heuristic 但无 command）→ never 档兜底放行（钉住既有行为）", async () => {
  // 拿**真实**的 WriteTool / EditTool（execute 换桩避免落盘）：档位是 heuristic、参数里从来没有 command
  // 字段 → 只认命令的启发式接不住 → never 档兜底放行。这不是漏网，是刻意保留的既有行为。
  // ⚠️ 探针名必须完全不沾边：repairToolCall 的前缀模糊匹配会把 "WriteProbe" 整形成 "Write"（实测踩过）。
  const probes = [
    { name: "OmegaProbe1", tool: WriteTool, args: { file_path: "a.txt", content: "x" } },
    { name: "OmegaProbe2", tool: EditTool, args: { file_path: "a.txt", old_string: "a", new_string: "b" } },
  ];
  for (const p of probes) {
    let asked = 0;
    const events: { type: string; [k: string]: unknown }[] = [];
    const out = await executeOne(call(p.name, p.args), depsOf({ tools: [{ ...p.tool, name: p.name, execute: async () => ({ wrote: true }) }], events, onApprovalNeeded: () => { asked++; } }));
    assert.equal(asked, 0, p.name + " 不该弹审批（写侧靠 resolveInsideWorkspace 围栏，不靠审批）");
    assert.equal(out.ok, true);
    assert.equal(out.denied, undefined);
    const decision = events.find((e) => e.type === "tool:approval_decision");
    assert.equal(decision!.by, "tool-never-allow", p.name + " 必须落在 never 档");
    assert.equal(decision!.decision, "allow");
  }
});

test("审批链：诊断事件带上是哪条策略决定的", async () => {
  const events: { type: string; [k: string]: unknown }[] = [];
  await executeOne(call("Read", { file_path: "a.txt" }), depsOf({ tools: [fakeTool({ name: "Read" })], events }));
  const d = events.find((e) => e.type === "tool:approval_decision");
  assert.ok(d, "必须发 tool:approval_decision 事件");
  assert.equal(d!.by, "tool-never-allow");
  assert.equal(d!.decision, "allow");
  assert.equal(d!.tool, "Read");
});

test("审批链：拒绝路径与 PendingRegistry 的既有语义一致（超时说清等了多久）", async () => {
  const pending = new PendingRegistry();
  const res = await pending.requestApproval("tc1", { title: "允许？", message: "m", riskLevel: "medium" }, 5);
  assert.equal(res.approved, false);
  assert.equal(res.reason, "timeout");
  assert.equal(res.decision, "deny");
  assert.equal(res.timeoutMs, 5);
  assert.equal(pending.resolveApproval("tc1", true), false, "已超时的请求不能再被处理");
});

// ── ③ 规则解析 ────────────────────────────────────────
test("规则解析：Bash(rm *) 命中整条命令、不命中别的；工具名大小写不敏感", () => {
  const parsed = parseRule("Bash(rm *)");
  assert.deepEqual(parsed, { name: "Bash", arg: "rm *", negated: false });
  const bash = commandTool({ name: "Bash" });
  assert.equal(ruleMatches(parsed!, "Bash", bash, { command: "rm -rf /tmp/x" }), true);
  assert.equal(ruleMatches(parsed!, "Bash", bash, { command: "ls -la" }), false);
  assert.equal(ruleMatchesTool("bash", "Bash"), true, "工具名 glob 大小写不敏感");
  assert.equal(ruleMatchesTool("b*sh", "Bash"), true);
  assert.equal(ruleMatchesTool("Zsh", "Bash"), false);
});

test("规则解析：! 取反只作用于参数 glob（Bash(!git *) = 除 git 外都命中）", () => {
  const parsed = parseRule("Bash(!git *)");
  assert.deepEqual(parsed, { name: "Bash", arg: "git *", negated: true });
  const bash = commandTool({ name: "Bash" });
  assert.equal(ruleMatches(parsed!, "Bash", bash, { command: "rm -rf x" }), true, "非 git 命令应命中");
  assert.equal(ruleMatches(parsed!, "Bash", bash, { command: "git status" }), false, "git 命令不命中");
});

test("规则解析：超长 / 坏格式（缺右括号 / 空）被跳过而不是抛", () => {
  assert.deepEqual(parseRule("Bash(rm *)"), { name: "Bash", arg: "rm *", negated: false });
  assert.equal(parseRule("Bash(rm *"), null, "缺右括号 → null");
  assert.equal(parseRule("Bash()"), null, "空参数 → null");
  assert.equal(parseRule("Bash(!)"), null, "只有取反号 → null");
  assert.equal(parseRule("   "), null);
  assert.equal(parseRule(`Bash(${"x".repeat(APPROVAL_RULE_MAX_CHARS)})`), null, "超长规则必须拒收");
  assert.equal(APPROVAL_RULE_MAX_CHARS, 200);
  assert.deepEqual(parseRule("Bash(echo (x))"), { name: "Bash", arg: "echo (x)", negated: false }, "取最后一个 ) 收尾");
});

test("规则解析：没声明 approvalRule 只能整工具匹配；参数 glob 的 * 通配、其余按字面", () => {
  const mcp = fakeTool({ name: "McpTool" });
  assert.equal(ruleMatches(parseRule("McpTool")!, "McpTool", mcp, {}), true);
  assert.equal(ruleMatches(parseRule("McpTool(anything)")!, "McpTool", mcp, {}), false, "带括号的规则接不上");
  assert.equal(argGlobMatches("rm *", "rm -rf /tmp/x"), true, "命令里的 * 必须能跨 /");
  assert.equal(argGlobMatches("rm *", "xrm y"), false, "必须整串匹配");
  assert.equal(argGlobMatches("/proj/src/*", "/proj/src/a.ts"), true);
  assert.equal(argGlobMatches("/proj/src/*", "/proj/src/a/b.ts"), true, "路径规则多覆盖子目录 = 多问一次，不是放行");
  assert.equal(argGlobMatches("a+b.ts", "a+b.ts"), true, "+ 是字面量，不是正则量词");
  assert.equal(argGlobMatches("a+b.ts", "aab.ts"), false);
});

// ── ④ 会话规则：持久化 ────────────────────────────────
test("会话规则：跨「存-取」往返仍在 —— 证明真的持久化了", () => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), "dove-rule-db-")), "s.sqlite"));
  const store1 = new Store(db);
  store1.createThread({ id: "th_p", kind: "project", title: "t" });
  const bash = commandTool({ name: "Bash", approval: "heuristic" });
  assert.equal(rememberSessionRule(store1, "th_p", "Bash", { command: "rm -rf /tmp/x" }, bash, "allow"), "Bash(rm -rf /tmp/x)");

  const store2 = new Store(db);
  const rules = readSessionRules(store2, "th_p");
  assert.deepEqual(rules.map((r) => r.rule), ["Bash(rm -rf /tmp/x)"]);
  assert.equal(rules[0]!.decision, "allow");
  assert.equal(sessionRuleDecision(store2, "th_p", "Bash", { command: "rm -rf /tmp/x" }, bash, WS)?.decision, "allow");
  const raw = store2.getThread("th_p")!.metadata[SESSION_RULES_KEY] as { rule: string }[];
  assert.ok(Array.isArray(raw) && raw[0]!.rule === "Bash(rm -rf /tmp/x)", "规则落在既有的线程 metadata 上");
});

test("会话规则：重复记住同一条不产生重复项；上限超出丢最老", () => {
  const store = new Store(new Db(":memory:"));
  store.createThread({ id: "th_cap", kind: "project", title: "t" });
  const bash = commandTool({ name: "Bash" });
  rememberSessionRule(store, "th_cap", "Bash", { command: "rm *" }, bash);
  rememberSessionRule(store, "th_cap", "Bash", { command: "rm *" }, bash);
  assert.equal(readSessionRules(store, "th_cap").length, 1, "同一条不重复记");

  for (let i = 0; i < APPROVAL_SESSION_RULE_MAX + 5; i++) rememberSessionRule(store, "th_cap", "Bash", { command: "cmd" + i }, bash);
  const rules = readSessionRules(store, "th_cap");
  assert.equal(rules.length, APPROVAL_SESSION_RULE_MAX);
  assert.equal(rules.some((r) => r.rule === "Bash(rm *)"), false, "最老的必须被淘汰");
  assert.equal(rules[rules.length - 1]!.rule, "Bash(cmd" + (APPROVAL_SESSION_RULE_MAX + 4) + ")", "最新的留在末尾");
  assert.equal(nextRuleSet([], "Bash(a)", "allow", 1).length, 1);
});

test("会话规则：只有 remember === true 时才写入（默认不问自记 = 偷偷扩大授权）", async () => {
  const store = new Store(new Db(":memory:"));
  store.createThread({ id: "th_rem", kind: "project", title: "t" });
  const bash = commandTool({ name: "Bash", approval: "heuristic" });
  await executeOne(call("Bash", { command: "rm -rf /tmp/x" }), depsOf({ tools: [bash], store, threadId: "th_rem", approve: () => ({ approved: true }) }));
  assert.equal(readSessionRules(store, "th_rem").length, 0, "没点「记住」不该落规则");

  let asked = 0;
  await executeOne(call("Bash", { command: "rm -rf /tmp/x" }, "c2"), depsOf({ tools: [bash], store, threadId: "th_rem", approve: () => ({ approved: true, remember: true }), onApprovalNeeded: () => { asked++; } }));
  assert.equal(asked, 1);
  assert.deepEqual(readSessionRules(store, "th_rem").map((r) => r.rule), ["Bash(rm -rf /tmp/x)"]);
  await executeOne(call("Bash", { command: "rm -rf /tmp/x" }, "c3"), depsOf({ tools: [bash], store, threadId: "th_rem", approve: () => ({ approved: false, reason: "user" }), onApprovalNeeded: () => { asked++; } }));
  assert.equal(asked, 1, "第二次必须命中会话规则、不再问");
});

test("会话规则：没声明 approvalRule 按整工具记；线程不存在则不写（不偷偷造线程）", () => {
  const store = new Store(new Db(":memory:"));
  store.createThread({ id: "th_mcp", kind: "project", title: "t" });
  assert.equal(rememberSessionRule(store, "th_mcp", "McpTool", {}, fakeTool({ name: "McpTool" })), "McpTool");
  assert.deepEqual(readSessionRules(store, "th_mcp").map((r) => r.rule), ["McpTool"]);
  assert.equal(rememberSessionRule(store, "th_nope", "Bash", { command: "x" }, commandTool({ name: "Bash" })), null);
});
