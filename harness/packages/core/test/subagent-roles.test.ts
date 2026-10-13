/**
 * 子代理角色 / 续跑（resume）/ 并发上限 / <git-context> 的用例。
 *
 * 为什么单独一个文件：core.test.ts 与 p0.test.ts 都贴着 400 行硬约束。
 * 这里的重点是三条**纪律**，不是纯函数覆盖率：
 *  ① 角色只能削减能力（父没有的，子代理绝不会有）；
 *  ② 工具表与端口必须一起收（只收一处 = 能力或可用性对不上）；
 *  ③ git-context 只拼任务 prompt、且有超时（绝不能让 git 卡住一个子代理）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { TaskRegistry } from "../src/agents/task-registry.ts";
import { SubagentHost } from "../src/agent/subagent-host.ts";
import { applyThreadPolicy } from "../src/agent/tool-policy.ts";
import {
  SUBAGENT_ROLES, DEFAULT_SUBAGENT_ROLE_ID, applyRolePolicy, getRole, renderRoleListing, roleCanDelegate,
} from "../src/agents/roles.ts";
import type { SubagentRole } from "../src/agents/roles.ts";
import { renderGitContext } from "../src/agents/git-context.ts";
import { TaskTool } from "../src/tools/builtin/task.ts";
import { SUBAGENT_MAX_CONCURRENT } from "../src/constants.ts";
import { defineTool, S } from "../src/tools/types.ts";
import type { Tool, ToolContext, ToolServices } from "../src/tools/types.ts";
import type { ChatMessage, Provider, StreamResult } from "../src/providers/types.ts";

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

function streamResult(text: string, toolCalls: StreamResult["toolCalls"] = []): StreamResult {
  return { text, reasoning: "", toolCalls, usage: { ...USAGE }, finishReason: toolCalls.length ? "tool_calls" : "stop" };
}

function oneCall(name: string): StreamResult["toolCalls"] {
  return [{ id: "c_" + name, type: "function", function: { name, arguments: "{}" } }];
}

/** 记录每次请求（消息序列 + 工具名单）的假 provider：断言只靠它 */
interface Recorded { messages: ChatMessage[]; tools: string[] }
function recorder(reply?: (n: number) => StreamResult): { provider: Provider; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const provider: Provider = {
    id: "stub-roles",
    stream: async (opts) => {
      calls.push({ messages: [...opts.messages], tools: (opts.tools ?? []).map((t) => t.function.name) });
      return reply ? reply(calls.length) : streamResult("结论 " + calls.length);
    },
  };
  return { provider, calls };
}

/** 先调一次工具、拿到结果再给答复（不给答复会一直循环到 SUBAGENT_MAX_STEPS） */
function toolThenAnswer(name: string): { provider: Provider; calls: Recorded[] } {
  return recorder((n) => (n === 1 ? streamResult("", oneCall(name)) : streamResult("结论：做完了")));
}

function fakeTool(name: string, onExec?: (ctx: ToolContext) => void): Tool {
  return defineTool({
    name, description: "测试工具 " + name, parameters: S.obj({}), outputTier: "exact",
    approval: "never", concurrencySafe: true,
    execute: async (_input, ctx) => { onExec?.(ctx); return { ok: true, tool: name }; },
  });
}

const ALL_TOOL_NAMES = [
  "Read", "Glob", "Grep", "Write", "Edit", "Bash", "RunScript", "TodoWrite", "WebSearch", "WebFetch",
  "Task", "TaskOutput", "ListAgents", "SendMessage", "InterruptAgent",
];
function toolMap(names = ALL_TOOL_NAMES, onExec?: (ctx: ToolContext) => void): Map<string, Tool> {
  return new Map(names.map((n) => [n, fakeTool(n, n === "Read" ? onExec : undefined)]));
}

function ctxWith(services: ToolServices): ToolContext {
  return {
    toolCallId: "call-1", threadId: "th_parent", workdir: process.cwd(), outputsDir: tmpdir(),
    emit: () => { /* 事件不参与断言 */ },
    requestApproval: async () => ({ approved: true, decision: "allow" }),
    services,
  };
}

/** 一个真实但**不含 git 仓库**的工作目录（git-context 会退化，速度快且确定） */
const PLAIN_DIR = mkdtempSync(join(tmpdir(), "dove-plain-"));

interface HostSetup {
  host: SubagentHost;
  store: Store;
  tasks: TaskRegistry;
  db: Db;
}
function makeHost(input: {
  provider: Provider; tools?: Map<string, Tool>; services?: ToolServices; workdir?: string; sink?: (e: Record<string, unknown>) => void;
}): HostSetup {
  const db = new Db(":memory:");
  const store = new Store(db);
  const tasks = new TaskRegistry(db);
  store.createThread({ id: "th_parent", kind: "project", title: "父线程" });
  const svc = input.services ?? {};
  const host = new SubagentHost({
    provider: input.provider, model: "deepseek-flash",
    tools: input.tools ?? toolMap(),
    execDeps: {
      ctxBase: {
        threadId: "th_parent", workdir: input.workdir ?? PLAIN_DIR, outputsDir: tmpdir(),
        emit: () => { /* 忽略 */ }, services: svc,
      },
      resolveApproval: async () => ({ approved: true }),
    },
    store, tasks, parentThreadId: "th_parent",
    sink: (e) => input.sink?.(e as Record<string, unknown>), services: svc,
  });
  return { host, store, tasks, db };
}

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

// ── 1. 角色白名单：真的有区别，且只能削减 ──────────────────────
test("角色裁剪：explore 只读、coder 不派活、general 有 RunScript", () => {
  const parent = toolMap();
  const explore = applyRolePolicy(parent, getRole("explore")!);
  for (const n of ["Write", "Edit", "Bash", "RunScript", "Task"]) {
    assert.ok(!explore.tools.has(n), "explore 是只读角色，不该有 " + n);
  }
  assert.ok(explore.tools.has("Read") && explore.tools.has("Grep"), "只读工具要留着");

  const coder = applyRolePolicy(parent, getRole("coder")!);
  for (const n of ["Task", "TaskOutput", "ListAgents", "SendMessage", "InterruptAgent"]) {
    assert.ok(!coder.tools.has(n), "coder 不许派活，不该有 " + n);
  }
  assert.ok(coder.tools.has("Write") && coder.tools.has("Bash") && coder.tools.has("RunScript"), "coder 要能写能跑");

  assert.ok(applyRolePolicy(parent, getRole("general")!).tools.has("RunScript"), "general 必须有 PTC（RunScript）");
  assert.ok(applyRolePolicy(parent, getRole("plan")!).tools.has("TodoWrite"), "plan 要能写待办");

  // canDelegate:false 是硬闸：白名单里就算写了 Task 也会被收掉（配置写错的兜底）
  const bad: SubagentRole = { id: "bad", description: "配置写错", tools: ["Read", "Task"], canDelegate: false };
  assert.ok(!applyRolePolicy(parent, bad).tools.has("Task"), "canDelegate:false 必须压过白名单");
  // 反过来：白名单里有派活工具且没禁 → 保留，且端口那侧也认这个判据
  const okRole: SubagentRole = { id: "lead", description: "能派活", tools: ["Read", "Task"] };
  assert.ok(applyRolePolicy(parent, okRole).tools.has("Task"));
  assert.equal(roleCanDelegate(okRole), true);
  assert.equal(roleCanDelegate(getRole("coder")), false);
  assert.equal(roleCanDelegate(getRole("general")), false, "出厂角色的白名单都不含派活工具 → 今天子代理不能再派子代理");

  // 只能削减：["*"] 也不能把父表里没有的工具变出来
  const wild = applyRolePolicy(new Map([["Read", fakeTool("Read")]]), { id: "w", description: "w", tools: ["*"] });
  assert.deepEqual([...wild.tools.keys()], ["Read"]);

  // 另一半：父会话（Home 线程 / 只读）裁掉的写类工具，角色再怎么写也要不回来 ——
  // 这道闸在 applyThreadPolicy 里，子代理只是「在父已允许的基础上按角色再收窄」，不能反过来放宽
  const home = applyThreadPolicy("home", toolMap());
  const generalAtHome = applyRolePolicy(home.tools, getRole("general")!);
  for (const n of ["Bash", "Write", "Edit", "RunScript"]) {
    assert.ok(!generalAtHome.tools.has(n), "Home 线程派出的子代理也不该有 " + n);
  }
});

// ── 2. 非法角色：报错必须列出**生成**的角色一览 ────────────────
test("非法 role：报错里带生成式角色一览，工具描述里也有一览", async () => {
  const r = await TaskTool.execute({ prompt: "干点活", role: "wizard" }, ctxWith({ spawnSubagent: async () => ({ status: "done" }) }));
  assert.equal(r.ok, false);
  const note = String(r.note);
  for (const role of SUBAGENT_ROLES) assert.ok(note.includes(role.id), "错误里缺角色 " + role.id);
  // 「生成式」的可验证形式：错误正文里就是 renderRoleListing() 的输出 —— 改角色表，列表跟着变
  assert.ok(note.includes(renderRoleListing()), "角色一览必须来自 renderRoleListing()");
  assert.deepEqual(r.available_roles, SUBAGENT_ROLES.map((x) => x.id));
  assert.ok(TaskTool.description.includes(renderRoleListing()), "Task 描述里要带角色一览");
  assert.equal(getRole(DEFAULT_SUBAGENT_ROLE_ID)!.id, DEFAULT_SUBAGENT_ROLE_ID);
});

// ── 3. canDelegate:false：工具表与端口两条路都没有派活能力 ─────
test("coder：工具表与 execDeps 两处都没有派活能力", async () => {
  const seen: ToolServices[] = [];
  const { provider, calls } = toolThenAnswer("Read");
  const { host } = makeHost({ provider, tools: toolMap(ALL_TOOL_NAMES, (c) => seen.push(c.services)) });

  const r = await host.spawn("读一下这个文件", "读文件", false, { role: "coder" });
  assert.equal(r.status, "done");
  assert.equal(r.role, "coder");

  // 方向①：工具表（wire 上看不到派活工具，哪怕父表里有）
  const wire = calls[0]!.tools;
  for (const n of ["Task", "TaskOutput", "ListAgents", "SendMessage", "InterruptAgent"]) {
    assert.ok(!wire.includes(n), "coder 的 wire 不该有 " + n);
  }
  assert.ok(wire.includes("Write") && wire.includes("RunScript"), "coder 要能写能跑");

  // 方向②：端口（子代理执行工具时拿到的 services）
  assert.equal(seen.length, 1, "Read 应当被执行一次");
  const svc = seen[0]!;
  for (const k of ["spawnSubagent", "spawnSubagentRequest", "sendAgentMessage", "interruptAgent", "dispatchToProject", "attachImage"] as const) {
    assert.equal(svc[k], undefined, "coder 不该拿到 " + k + " 端口");
  }
});

// ── 4. resume：重挂同一段历史（同一个线程 id），外来 id 报错 ────
test("resume：同一个 id 复用同一段历史；非法/外来 id 报错", async () => {
  const { provider, calls } = recorder();
  const { host, store } = makeHost({ provider });

  const first = await host.spawn("第一步：看清楚 A", "探索A", false, { role: "explore" });
  assert.ok(first.subagentId, "要拿到子代理 id 才能续跑");
  assert.equal(first.resumed, false);
  assert.ok(first.usage && first.usage.outputTokens > 0, "结论里要带 token 用量（父级记账）");

  const second = await host.spawn("第二步：接着看 B", "探索A", false, { role: "explore", resume: first.subagentId });
  assert.equal(second.subagentId, first.subagentId, "resume 必须重挂同一个子代理（线程 id 不变）");
  assert.equal(second.resumed, true);
  assert.ok(calls.length >= 2, "两次运行各自至少一次请求");
  // 第二次请求的消息序列 = 第一次的历史 + 新指令 → 一定更长，且开头是同一段
  const firstRunLen = calls[0]!.messages.length;
  const secondRun = calls.find((c) => c.messages.length > firstRunLen && c !== calls[0]);
  assert.ok(secondRun, "第二次运行请求的历史应当接着第一次");
  assert.ok(String(calls[calls.length - 1]!.messages.at(-1)!.content).includes("第二步"), "新指令要追加在历史后面");
  // 落盘：同一线程里两次运行各留一条过程记录（不是新开一条线程）
  assert.equal(store.listMessages(first.subagentId!).length, 2, "resume 不该新建线程，只往同一条线程追加");
  assert.equal(store.listThreads("subagent").length, 1);

  // 非法 / 外来 id → 明确报错，绝不静默新起一个
  const ghost = await host.spawn("x", "y", false, { role: "explore", resume: "sub_不存在" });
  assert.ok(ghost.error);
  assert.match(String(ghost.error), /找不到子代理/);
  assert.equal(host.list().length, 1, "报错的情况下不许悄悄多出一个子代理");
  // 归属校验：别的父线程的子代理不能续跑
  store.createThread({ id: "th_other", kind: "project", title: "别人的线程" });
  store.createThread({
    id: "sub_foreign_1", kind: "subagent", title: "外来的", metadata: { parentThreadId: "th_other", label: "外来的" },
  });
  const foreign = await host.spawn("x", "y", false, { role: "general", resume: "sub_foreign_1" });
  assert.ok(foreign.error);
  assert.match(String(foreign.error), /找不到子代理/);
  // 角色冲突：续跑不许偷偷换成另一个角色
  const conflict = await host.spawn("x", "y", false, { role: "coder", resume: first.subagentId });
  assert.ok(conflict.error);
  assert.match(String(conflict.error), /角色/);
});

// ── 5. SendMessage：已结束的子代理重挂同一段上下文 ──────────────
test("SendMessage：已结束的子代理走「重挂同一段历史」，不是新起一个", async () => {
  const { provider } = recorder();
  const { host } = makeHost({ provider });
  const r = await host.spawn("查一下 X", "查X", false);
  const sent = await host.send(String(r.subagentId), "再补一个点");
  assert.equal(sent.ok, true);
  assert.equal(sent.mode, "resumed");
  assert.equal(sent.subagentId, r.subagentId, "首选路径应当是同一个子代理");
  assert.match(String(sent.note), /同一个/);
  // 缓存未命中（模拟「它是上一个进程跑的」）→ 退回种子路，note 必须说明是新起的
  const other = makeHost({ provider });
  other.store.createThread({
    id: "sub_old_1", kind: "subagent", title: "上一进程的", metadata: { parentThreadId: "th_parent", label: "上一进程的" },
  });
  const seeded = await other.host.send("sub_old_1", "接着做");
  assert.equal(seeded.mode, "resumed");
  assert.match(String(seeded.note), /新起/);
});

// ── 6. 并发上限：到顶直接报错，不排队 ──────────────────────────
test("并发上限：超过 SUBAGENT_MAX_CONCURRENT 时报明确错误", async () => {
  let release = (): void => { /* 占位 */ };
  const gate = new Promise<void>((res) => { release = res; });
  const provider: Provider = {
    id: "stub-slow",
    stream: async () => { await gate; return streamResult("慢活做完了"); },
  };
  const { host } = makeHost({ provider });
  for (let i = 0; i < SUBAGENT_MAX_CONCURRENT; i++) {
    const r = await host.spawn("慢活 " + i, "慢" + i, true);
    assert.equal(r.status, "running", "第 " + (i + 1) + " 个应当能起来");
  }
  assert.equal(host.runningCount, SUBAGENT_MAX_CONCURRENT);
  const over = await host.spawn("再来一个", "溢出", true);
  assert.ok(over.error, "超过上限必须报错（不能排队到天荒地老）");
  assert.match(String(over.error), new RegExp(String(SUBAGENT_MAX_CONCURRENT)));
  assert.equal(host.runningCount, SUBAGENT_MAX_CONCURRENT, "被拒的那次不该真的跑起来");
  release();
  assert.ok(await waitFor(() => host.runningCount === 0), "放行后应当全部收尾");
});

// ── 7. <git-context>：真实仓库 / 非仓库 / 超时 ──────────────────
test("<git-context>：真仓库出分支与提交，非仓库与超时都静默退化", () => {
  const repo = mkdtempSync(join(tmpdir(), "dove-gitctx-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "首次提交：加个文件");
  writeFileSync(join(repo, "b.txt"), "dirty\n");
  git("remote", "add", "origin", "https://github.com/dove/dove.git");

  const out = renderGitContext(repo);
  assert.match(out, /^<git-context>/);
  assert.match(out, /Working directory: /);
  assert.match(out, /Project: /);
  assert.match(out, /Branch: main/);
  assert.match(out, /Remote: https:\/\/github\.com\/dove\/dove\.git/);
  assert.match(out, /Dirty files: 1/);
  assert.match(out, /Recent commits:/);
  assert.match(out, /首次提交/);
  assert.match(out, /<\/git-context>$/);

  // 非 allow-list 的 host：Remote 不写出来（内网 URL 里可能带内部信息）
  git("remote", "set-url", "origin", "https://git.internal.example.com/x.git");
  assert.ok(!renderGitContext(repo).includes("Remote:"), "allow-list 外的 host 不该写 Remote");

  // 非 git 仓库
  assert.equal(renderGitContext(PLAIN_DIR), '<git-context status="unavailable" reason="not-a-repo"/>');

  // 没有 git / git 卡住：都不许抛错，也不许让子代理跟着卡
  assert.match(renderGitContext(repo, { gitBin: "/nonexistent/git-binary" }), /status="unavailable"/);
  const slowGit = join(repo, "slow-git.sh");
  writeFileSync(slowGit, "#!/bin/sh\nsleep 5\n");
  chmodSync(slowGit, 0o755);
  const t0 = Date.now();
  const timed = renderGitContext(repo, { gitBin: slowGit, timeoutMs: 100, totalBudgetMs: 300 });
  assert.match(timed, /status="unavailable"/);
  assert.ok(Date.now() - t0 < 3000, "超时必须真的放弃（实际 " + (Date.now() - t0) + "ms）");
});

// ── 8. host 级：gitContext 拼在**任务 prompt**、角色只能削减 ────
test("gitContext 角色：前缀在任务 prompt 上（系统提示词不动）；父没有的工具子代理也没有", async () => {
  const { provider, calls } = recorder();
  const { host } = makeHost({ provider, tools: toolMap(["Read", "Grep"]), workdir: process.cwd() });
  const r = await host.spawn("看看这个仓库现在什么状态", "看仓库", false, { role: "explore" });
  assert.equal(r.status, "done");
  const msgs = calls[0]!.messages;
  assert.equal(msgs[0]!.role, "system");
  assert.ok(!String(msgs[0]!.content).includes("<git-context>"), "系统提示词绝不能带 git-context（前缀缓存会整段作废）");
  assert.match(String(msgs[1]!.content), /^<git-context>/);
  assert.match(String(msgs[1]!.content), /看看这个仓库现在什么状态/);
  // 角色只能削减：explore 白名单里有 Read/Glob/Grep，但父表只有 Read/Grep → 子代理也只有这两个
  assert.deepEqual(calls[0]!.tools, ["Read", "Grep"]);
});

// ── 9. Task 工具端到端：role 一路走到子代理 + usage 回传 ─────────
test("Task 工具端到端：role 生效、usage 回传、结论带回", async () => {
  const { provider, calls } = toolThenAnswer("Read");
  const svc: ToolServices = {};
  const { host } = makeHost({ provider, services: svc });
  // run-services 的接线（三参数那条）+ SubagentHost 挂的完整端口，两条都要在
  svc.spawnSubagent = (o) => host.spawn(o.prompt, o.label ?? "子任务", o.background === true);

  const r = await TaskTool.execute({ prompt: "读一下 README", role: "coder", label: "读README" }, ctxWith(svc));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.role, "coder");
  assert.equal(r.status, "done");
  assert.ok(String(r.output).includes("结论"), "结论要带回来");
  assert.ok(r.usage, "结束时要回传 token 用量");
  assert.ok(Number((r.usage as { outputTokens: number }).outputTokens) > 0);
  const wire = calls[0]!.tools;
  assert.ok(!wire.includes("Task") && wire.includes("Write"), "角色裁剪要一路走到 wire 上");

  // 非法角色 fail-fast：不静默按 general 跑
  const bad = await TaskTool.execute({ prompt: "x", role: "nope" }, ctxWith(svc));
  assert.equal(bad.ok, false);
  assert.match(String(bad.note), new RegExp(SUBAGENT_ROLES[0]!.id));
});
