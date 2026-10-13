/**
 * 8008 事件映射的新字段（sse-compat）+ 子代理列表的 usage（routes-subagents）。
 *
 * 三件事：
 *  ① 审批事件必须带上 `approval` 与「记住的形状」`remember_rule` —— 形状串必须和
 *     内核真正落库的那条规则**逐字一致**（面板拿它写给用户看，不一致就是安全语义错）；
 *  ② turn_diff 映射：files 映射齐全、空帧丢掉（一轮只读不该渲染空块）；
 *  ③ 子代理列表按 metadata.taskId 从任务表带出 usage，没报时是 null（不是 0）。
 *
 * 不在 core/src 下的理由：`npm test` 只扫 core/test（服务端路由没有自己的测试目录）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { toLegacy, type LegacyCtx, type LegacyEvent } from "../../server/src/legacy/sse-compat.ts";
import { handleSubagentRoutes } from "../../server/src/legacy/routes-subagents.ts";
import { executeOne } from "../src/loop/tool-exec.ts";
import type { ExecDeps } from "../src/loop/tool-exec.ts";
import { BashTool } from "../src/tools/builtin/bash.ts";
import type { ToolCallPayload } from "../src/providers/types.ts";

function askOf(events: LegacyEvent[]): Extract<LegacyEvent, { type: "ask_user" }> {
  const ask = events.find((e) => e.type === "ask_user");
  assert.ok(ask, "必须映射出一条 ask_user 事件，实际：" + JSON.stringify(events));
  return ask as Extract<LegacyEvent, { type: "ask_user" }>;
}

// ── ① 审批：approval 标记 + 记住的形状 ─────────────────────────
test("tool_approval：带 approval 标记与 remember_rule；形状 = 工具自报的 approvalRule", () => {
  const ctx: LegacyCtx = { hasBuilt: false, tools: new Map([["Bash", BashTool]]), toolCalls: new Map() };
  const cmd = "rm -rf /tmp/dove-does-not-exist-shape";
  // 审批前内核一定先发过 tool_start（同一个 toolCallId）——形状就是从那里算出来的
  toLegacy({ type: "tool_start", tool: "Bash", toolCallId: "c1", input: { command: cmd } }, ctx);
  const ask = askOf(toLegacy({
    type: "tool_approval", toolCallId: "c1",
    title: "允许执行 Bash？", message: JSON.stringify({ command: cmd }), riskLevel: "medium", timeoutMs: 300_000,
  }, ctx));

  assert.equal(ask.approval, true, "审批必须被标记出来（面板据此才画「同意并记住」）");
  assert.equal(ask.remember_rule, "Bash(" + cmd + ")", "形状串 = 工具自报的参数模式");
  assert.deepEqual(ask.suggestions, ["允许", "拒绝"]);
});

test("remember_rule 与真正落库的规则**逐字一致**（不一致 = 用户看到的和实际记住的不是一回事）", async () => {
  const ctx: LegacyCtx = { hasBuilt: false, tools: new Map([["Bash", BashTool]]), toolCalls: new Map() };
  const cmd = "rm -rf /tmp/dove-does-not-exist-shape-e2e";
  toLegacy({ type: "tool_start", tool: "Bash", toolCallId: "c1", input: { command: cmd } }, ctx);
  const shown = askOf(toLegacy({ type: "tool_approval", toolCallId: "c1", title: "允许执行 Bash？", message: "{}" }, ctx)).remember_rule;

  // 同一份命令，让内核真的写一次规则（不真执行 rm：目录本来就不存在）
  const sink: { patch?: { metadata?: { approvalRules?: { rule: string }[] } } } = {};
  const deps = {
    tools: new Map([["Bash", BashTool]]),
    ctxBase: { threadId: "th_shape", workdir: "/tmp", outputsDir: "/tmp", emit: () => { /* 忽略 */ }, services: {} },
    store: {
      getThread: (id: string) => ({ id, kind: "project", projectId: null, title: "t", metadata: {} }),
      updateThread: (_id: string, patch: typeof sink.patch) => { sink.patch = patch; },
    },
    permissionMode: "workspace-write",
    resolveApproval: async () => ({ approved: true, decision: "allow", reason: "user", remember: true }),
  } as unknown as ExecDeps;
  const call = { id: "c1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: cmd }) } } as unknown as ToolCallPayload;
  await executeOne(call, deps);

  const written = sink.patch?.metadata?.approvalRules?.[0]?.rule;
  assert.equal(shown, written, "面板展示的形状必须等于内核落库的规则串，实际：展示 " + shown + " / 落库 " + written);
});

test("tool_approval：没经过 tool_start（老客户端 / 事件丢失）→ 不给 remember_rule，宁可只让用户点允许", () => {
  const ctx: LegacyCtx = { hasBuilt: false, tools: new Map([["Bash", BashTool]]), toolCalls: new Map() };
  const ask = askOf(toLegacy({ type: "tool_approval", toolCallId: "c_missing", title: "允许执行 Bash？", message: "{}" }, ctx));
  assert.equal(ask.approval, true);
  assert.equal(ask.remember_rule, undefined, "算不出形状就不给这个选项（给了就是「点了其实没记住」）");
});

test("普通提问（ask_user）不带 approval / remember_rule", () => {
  const ask = askOf(toLegacy({ type: "ask_user", toolCallId: "q1", question: "用哪个配色？", suggestions: ["红", "蓝"] }, { hasBuilt: false }));
  assert.equal(ask.approval, undefined);
  assert.equal(ask.remember_rule, undefined);
});

// ── ② turn_diff ────────────────────────────────────────────────
test("turn_diff：files/truncated/diff 映射齐全；空 files 不映射任何事件（一轮只读不渲染空块）", () => {
  const evs = toLegacy({
    type: "turn_diff", truncated: true, diff: "@@ -1 +1 @@\n-旧\n+新",
    files: [
      { path: "src/a.ts", added: 3, removed: 1, created: false, deleted: false },
      { path: "gone.ts", added: 0, removed: 9, created: false, deleted: true },
    ],
  }, { hasBuilt: false });
  assert.equal(evs.length, 1);
  const td = evs[0] as Extract<LegacyEvent, { type: "turn_diff" }>;
  assert.equal(td.type, "turn_diff");
  assert.equal(td.truncated, true);
  assert.equal(td.diff, "@@ -1 +1 @@\n-旧\n+新");
  assert.deepEqual(td.files, [
    { path: "src/a.ts", added: 3, removed: 1, created: false, deleted: false },
    { path: "gone.ts", added: 0, removed: 9, created: false, deleted: true },
  ]);

  assert.deepEqual(toLegacy({ type: "turn_diff", files: [], truncated: false, diff: "" }, { hasBuilt: false }), [],
    "空 diff 必须一个事件都不发");
  // 坏条目（没路径）同样丢掉，而不是映射出一个空路径行
  assert.deepEqual(toLegacy({ type: "turn_diff", files: [{ added: 1 }], diff: "x" }, { hasBuilt: false }), []);
});

// ── ③ 子代理列表的 usage ───────────────────────────────────────
function fakeRes(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(code: number) { out.status = code; return res; },
    end(body?: string) { out.body = body ?? ""; },
  };
  return { res: res as unknown as ServerResponse, out };
}

const subThread = (id: string, taskId: string | null) => ({
  id, kind: "subagent", projectId: "p1", title: "子任务", createdAt: 1,
  metadata: { parentThreadId: "th_p", label: "看下测试", status: "done", background: true, taskId },
});

test("GET /api/projects/{port}/subagents：按 taskId 从任务表带出 usage；没报 → null（不是 0）", async () => {
  const svc = {
    projects: { list: () => [{ id: "p1", name: "P", path: "/tmp/dove-nope", port: 3001 }] },
    store: {
      listThreads: (kind: string) => kind === "subagent"
        ? [subThread("sub_1", "task_1"), subThread("sub_2", "task_2"), subThread("sub_3", null)]
        : [{ id: "th_p", kind: "project", projectId: "p1" }],
    },
    tasks: {
      get: (id: string) => id === "task_1"
        ? { usage: { inputTokens: 11, outputTokens: 7 } }     // 有报表
        : id === "task_2" ? { usage: undefined } : undefined, // 没报表 / 老记录
    },
  } as never;

  const { res, out } = fakeRes();
  const handled = await handleSubagentRoutes(
    "/api/projects/3001/subagents", new URL("http://localhost/api/projects/3001/subagents"),
    { method: "GET" } as unknown as IncomingMessage, res, svc,
  );
  assert.equal(handled, true);
  assert.equal(out.status, 200);
  const rows = (JSON.parse(out.body) as { subagents: { id: string; usage: unknown }[] }).subagents;
  assert.deepEqual(rows.find((r) => r.id === "sub_1")?.usage, { inputTokens: 11, outputTokens: 7 });
  assert.equal(rows.find((r) => r.id === "sub_2")?.usage, null, "provider 没报 → null（显示成「未上报」）");
  assert.equal(rows.find((r) => r.id === "sub_3")?.usage, null, "没有 taskId（前台子代理）→ null");
});
