/**
 * 「同意并记住」从**面板这条路**进来的最后一公里。
 *
 * approval-remember.test.ts 盯的是「loop/tool-exec → 规则落库」那半条链；
 * 这里补齐前半条：面板审批走的是 8008 的 `POST /api/user-input`（不是 `POST /api/approve`），
 * 请求体里多一个可选的 `remember`。
 * 这条链任何一环断了，用户看到的现象都一样：**点了「同意并记住」，下次还是弹**。
 *
 * 为什么放在 core/test：`npm test` 只扫这个目录（服务端路由没有自己的测试目录）。
 * 做法：真的起一个 PendingRegistry 等待审批 → 用假请求打 8008 的路由 → 拿回执喂回
 * 真的 executeOne（等价于 loop 里干的那一下）→ 读线程 metadata 里的会话规则。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleChatRoutes } from "../../server/src/legacy/routes-chat.ts";
import { PendingRegistry } from "../src/agent/pending.ts";
import { executeOne } from "../src/loop/tool-exec.ts";
import type { ExecDeps } from "../src/loop/tool-exec.ts";
import { BashTool } from "../src/tools/builtin/bash.ts";
import type { ToolCallPayload } from "../src/providers/types.ts";

type Svc = Parameters<typeof handleChatRoutes>[4];

/** 假请求：readBody() 是 `for await (const c of req)`，所以给个异步可迭代对象即可 */
function fakeReq(body: Record<string, unknown>): IncomingMessage {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    method: "POST",
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; },
  } as unknown as IncomingMessage;
}

/** 假响应：只记状态码与 body —— legacy 的 json() 只干这两件事 */
function fakeRes(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(code: number) { out.status = code; return res; },
    end(body?: string) { out.body = body ?? ""; },
  };
  return { res: res as unknown as ServerResponse, out };
}

/** 只实现执行器需要的那两个方法：getThread / updateThread */
function fakeStore(sink: { patch?: { metadata?: { approvalRules?: { rule: string; decision: string }[] } } }) {
  return {
    getThread: (id: string) => ({ id, kind: "project", projectId: null, title: "t", metadata: {} }),
    updateThread: (_id: string, patch: typeof sink.patch) => { sink.patch = patch; },
  };
}

/**
 * 走一遍「面板点审批」：内核在等 → 8008 收请求 → 回执 → 执行器。
 * 返回执行结果与回执，调用方断言规则有没有落。
 */
async function pressApprove(body: Record<string, unknown>, sink: { patch?: { metadata?: { approvalRules?: { rule: string; decision: string }[] } } }) {
  const pending = new PendingRegistry();
  const svc = { pending } as unknown as Svc;

  // 内核侧在等这次审批（loop 在 sleep，等面板的回执）
  const waiting = pending.requestApproval("tc_legacy_remember", {
    title: "允许执行 Bash？", message: JSON.stringify({ command: "rm -rf /tmp/dove-does-not-exist-legacy-test" }), riskLevel: "medium",
  }, 60_000);

  // 面板那一跳：POST /api/user-input（旧契约的路径）
  const { res, out } = fakeRes();
  const handled = await handleChatRoutes("/api/user-input", new URL("http://localhost/api/user-input"), fakeReq(body), res, svc);
  assert.equal(handled, true, "这个路径必须归 routes-chat 管");
  assert.equal(out.status, 200);
  assert.equal((JSON.parse(out.body) as { success: boolean }).success, true);

  const response = await waiting;   // 路由 resolve 出来的回执
  const cmd = "rm -rf /tmp/dove-does-not-exist-legacy-test";
  const call = { id: "c_legacy", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: cmd }) } } as unknown as ToolCallPayload;
  const deps = {
    tools: new Map([["Bash", BashTool]]),
    ctxBase: { threadId: "th_legacy", workdir: "/tmp", outputsDir: "/tmp", emit: () => { /* 忽略 */ }, services: {} },
    store: fakeStore(sink),
    permissionMode: "workspace-write",     // heuristic → 一定会走到 ask
    resolveApproval: async () => response, // 回执原样喂回（等价 tool-exec 那一下）
  } as unknown as ExecDeps;
  const outcome = await executeOne(call, deps);
  return { response, outcome, cmd };
}

test("remember=true 走 /api/user-input：回执带 remember，规则落进线程 metadata（形状 = 工具自报的）", async () => {
  const sink: { patch?: { metadata?: { approvalRules?: { rule: string; decision: string }[] } } } = {};
  const { response, outcome, cmd } = await pressApprove(
    { session_id: "th_legacy", answer: "允许", remember: true }, sink,
  );

  assert.equal(response.approved, true, "回执必须是批准");
  assert.equal(response.remember, true, "remember 必须一路透传到回执 —— 丢了就是「点了记住但没记住」");
  assert.equal(outcome.ok, true, "被批准的命令应当真的执行");

  const rules = sink.patch?.metadata?.approvalRules;
  assert.ok(Array.isArray(rules) && rules.length === 1, "必须恰好写一条规则，实际：" + JSON.stringify(sink.patch));
  assert.equal(rules![0]!.rule, "Bash(" + cmd + ")", "规则形状来自工具自报的 approvalRule（工具名 + 参数）");
  assert.equal(rules![0]!.decision, "allow");
});

test("没带 remember（老面板 / 普通点击）：回执不含 remember，一条规则都不写", async () => {
  const sink: { patch?: { metadata?: { approvalRules?: { rule: string; decision: string }[] } } } = {};
  const { response, outcome } = await pressApprove({ session_id: "th_legacy", answer: "允许" }, sink);

  assert.equal(response.approved, true);
  assert.equal(response.remember, undefined, "没显式要记住就不许带 remember（不问自记 = 偷偷扩大授权）");
  assert.equal(outcome.ok, true);
  assert.equal(sink.patch, undefined, "没有 remember 就不该写规则，实际：" + JSON.stringify(sink.patch));
});

test("remember 只对审批有意义：回答 AskUserQuestion 时带它也不产生任何副作用", async () => {
  const pending = new PendingRegistry();
  const svc = { pending } as unknown as Svc;

  // 内核在等一个**提问**（不是审批）：走 PendingRegistry 的 question 通道
  const waiting = pending.ask("q_legacy", 60_000);
  const { res, out } = fakeRes();
  await handleChatRoutes(
    "/api/user-input", new URL("http://localhost/api/user-input"),
    fakeReq({ session_id: "th_ask", answer: "红色的那个", remember: true }), res, svc,
  );

  assert.equal(out.status, 200);
  assert.equal(await waiting, "红色的那个", "提问要原样拿到回答；remember 在这条路上没有去处，也不该报错");
});
