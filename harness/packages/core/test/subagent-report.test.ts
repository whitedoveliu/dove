/**
 * 「后台 Agent」的两条接口（A7）+ 它们依赖的报告函数
 *
 * 三件事：
 *  ① 列表行：模型从 metadata.model 读（**没记 = null**，不拿 threads.model 的默认值冒充）、
 *     用时在跑的时候是 null、状态认不出就是 unknown；
 *  ② 状态页签过滤：running / done / failed（失败含取消）/ recent（按开始时间倒序取前 20）/ all；
 *  ③ 过程条目：思考 / 正文 / 工具调用（**带结果**）按发生顺序出来，坏 part 不整个吞掉。
 *
 * 不在 core/src 下的理由：`npm test` 只扫 core/test（服务端路由没有自己的测试目录）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleSubagentRoutes } from "../../server/src/legacy/routes-subagents.ts";
import {
  filterSubagentItems, normalizeStatus, subagentEntries, subagentItem,
  type SubagentItem,
} from "../src/agents/subagent-report.ts";

// ── 造数据 ────────────────────────────────────────────────────

function thread(id: string, meta: Record<string, unknown>, createdAt = 1_000, projectId = "p1"): Record<string, unknown> {
  return {
    id, kind: "subagent", projectId, title: String(meta.label ?? id), model: "deepseek-flash",
    metadata: meta, createdAt, updatedAt: createdAt,
  };
}

const done = thread("sub_done", { parentThreadId: "th_p", label: "查一下行情", status: "done", model: "deepseek-flash", finishedAt: 3_000 }, 1_000);
const running = thread("sub_run", { parentThreadId: "th_p", label: "写测试", status: "running" }, 5_000);
const failed = thread("sub_fail", { parentThreadId: "th_p", label: "跑构建", status: "error", finishedAt: 2_000 }, 1_500);
const canceled = thread("sub_cancel", { parentThreadId: "th_p", label: "被取消的", status: "canceled" }, 8_000);
const weird = thread("sub_weird", { parentThreadId: "th_p", label: "老数据", status: "很怪" }, 20_000);

const toolCalls: Record<string, unknown[]> = {
  sub_done: [
    { type: "reasoning", text: "先看看目录" },
    { type: "tool-Bash", toolCallId: "c1", toolName: "Bash", input: { command: "ls -la" }, state: "output-available", output: "a.txt\nb.txt", startedAt: 1_100 },
    { type: "step-start" },
    { type: "text", text: "看完了，目录里两个文件" },
  ],
};

/** 只实现路由真正用到的那几个方法 —— 用真 Store 会把测试绑到 SQLite 上，跑得慢还难造状态 */
function fakeSvc(threads: Record<string, unknown>[] = [done, running, failed, canceled, weird]) {
  return {
    projects: {
      list: () => [{ id: "p1", name: "P", path: "/Users/me/code/proj", port: 3001 }],
      get: () => undefined,
    },
    store: {
      listThreads: (kind: string) => kind === "subagent" ? threads : [{ id: "th_p", kind: "project", projectId: "p1" }],
      listMessages: (id: string) => (toolCalls[id] ?? []).length
        ? [{ id: id + "-a", threadId: id, role: "assistant", parts: toolCalls[id], createdAt: 2_000 }]
        : [],
    },
    tasks: { get: () => undefined },
  } as never;
}

function fakeRes(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(code: number) { out.status = code; return res; },
    end(body?: string) { out.body = body ?? ""; },
  };
  return { res: res as unknown as ServerResponse, out };
}

async function call(svc: unknown, rawPath: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { res, out } = fakeRes();
  // 和真实服务一致：path 是 url.pathname（**不带查询串**），查询串走第二个参数
  const url = new URL("http://localhost" + rawPath);
  const handled = await handleSubagentRoutes(
    url.pathname, url, { method: "GET" } as unknown as IncomingMessage, res, svc as never,
  );
  assert.equal(handled, true, "这条路径必须被子代理路由接住：" + rawPath);
  return { status: out.status, body: JSON.parse(out.body) as Record<string, unknown> };
}

const rowsOf = (body: Record<string, unknown>) => body.subagents as SubagentItem[];
const idsOf = (body: Record<string, unknown>) => rowsOf(body).map((r) => r.id);

// ── ① 列表行 ─────────────────────────────────────────────────

test("列表行：model 只有 metadata 记过才有；没记 = null（不拿线程表默认值冒充）", () => {
  const withModel = subagentItem(done as never, { usage: { inputTokens: 11, outputTokens: 7 }, projectPath: "/p" });
  assert.equal(withModel.model, "deepseek-flash");
  assert.equal(withModel.durationMs, 2_000, "结束了的：finishedAt - startedAt");
  assert.equal(withModel.usage?.inputTokens, 11);
  assert.equal(withModel.projectPath, "/p");

  // 老记录：metadata 里没有 model，线程表的 model 列是 schema 默认值 —— 那是默认值，不是事实
  const legacy = subagentItem(running as never, {});
  assert.equal(legacy.model, null, "没记过模型 → null（面板显示「未记录」）");
  assert.equal(legacy.durationMs, null, "还在跑 → 用时是 null，不假装已经跑完");
  assert.equal(legacy.usage, null, "provider 没报 → null（不是 0）");
});

test("状态归一：认得出就用，认不出是 unknown（不猜）", () => {
  assert.equal(normalizeStatus("running"), "running");
  assert.equal(normalizeStatus("canceled"), "canceled");
  assert.equal(normalizeStatus("很怪"), "unknown");
  assert.equal(normalizeStatus(undefined), "unknown");
  assert.equal(subagentItem(weird as never).status, "unknown");
});

test("stale：记录说 running，但写下它的是**别的进程**（重启后的僵尸）—— 不能一直转圈", () => {
  const mine = thread("sub_mine", { parentThreadId: "th_p", status: "running", ownerPid: process.pid });
  const other = thread("sub_zombie", { parentThreadId: "th_p", status: "running", ownerPid: process.pid + 1 });
  const legacy = thread("sub_legacy", { parentThreadId: "th_p", status: "running" });

  assert.equal(subagentItem(mine as never, { ownerPid: process.pid }).status, "running", "本进程起的：还在跑");
  assert.equal(subagentItem(other as never, { ownerPid: process.pid }).status, "stale", "别的进程起的：已经不是 running");
  assert.equal(subagentItem(legacy as never, { ownerPid: process.pid }).status, "running",
    "没记过 ownerPid 的老记录：证明不了的不猜（维持原状）");
  assert.equal(subagentItem(mine as never).status, "running", "不传 ownerPid = 不做这个核验（老行为）");
  // stale 不是 running：不能留在「进行中」页签里
  const items = [subagentItem(mine as never, { ownerPid: process.pid }), subagentItem(other as never, { ownerPid: process.pid })];
  assert.deepEqual(filterSubagentItems(items, "running").map((i) => i.id), ["sub_mine"]);
  assert.deepEqual(filterSubagentItems(items, "all").map((i) => i.id), ["sub_mine", "sub_zombie"], "但「全部」里看得到");
});

test("页签过滤：running / done / failed（失败含取消）/ all", () => {
  const items = [done, running, failed, canceled, weird].map((t) => subagentItem(t as never));
  assert.deepEqual(filterSubagentItems(items, "running").map((i) => i.id), ["sub_run"]);
  assert.deepEqual(filterSubagentItems(items, "done").map((i) => i.id), ["sub_done"]);
  assert.deepEqual(filterSubagentItems(items, "failed").map((i) => i.id), ["sub_fail", "sub_cancel"]);
  assert.deepEqual(filterSubagentItems(items, "all").map((i) => i.id),
    ["sub_done", "sub_run", "sub_fail", "sub_cancel", "sub_weird"], "全部 = 传入顺序，一条不丢");
});

test("「最近」= 按开始时间倒序取前 20（不是按结束时间，也不改原数组）", () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    subagentItem(thread("sub_" + i, { parentThreadId: "th_p", status: "done" }, i * 100) as never));
  const recent = filterSubagentItems(many, "recent");
  assert.equal(recent.length, 20);
  assert.equal(recent[0]?.id, "sub_24", "最新的在最前");
  assert.equal(recent[19]?.id, "sub_5");
  assert.equal(many[0]?.id, "sub_0", "原数组不能被动过（面板还在用同一份）");
});

// ── ② 路由：列表 ─────────────────────────────────────────────

test("GET /subagents?status=… ：按页签返回，并回显实际用的那个 filter", async () => {
  const svc = fakeSvc();
  const all = await call(svc, "/api/projects/3001/subagents");
  assert.equal(all.status, 200);
  assert.equal(all.body.filter, "all", "不带参数 = all（老面板行为不变）");
  assert.equal(idsOf(all.body).length, 5);

  const run = await call(svc, "/api/projects/3001/subagents?status=running");
  assert.deepEqual(idsOf(run.body), ["sub_run"]);
  const fail = await call(svc, "/api/projects/3001/subagents?status=failed");
  assert.deepEqual(idsOf(fail.body), ["sub_fail", "sub_cancel"], "取消也算「没干成」");
  // 认不出的取值 → all（静默忽略会让面板以为页签生效了，但它至少不会得到空列表）
  const bogus = await call(svc, "/api/projects/3001/subagents?status=nope");
  assert.equal(bogus.body.filter, "all");

  const row = rowsOf(run.body)[0]!;
  assert.equal(row.projectPath, "/Users/me/code/proj", "卡片上的仓库路径");
  assert.equal(row.parts, 0);
  assert.equal(row.parentId, "th_p");
  assert.equal(row.finishedAt, null);
});

test("GET /subagents/{id}：元信息 + 过程条目（工具调用带结果、按顺序）", async () => {
  const res = await call(fakeSvc(), "/api/projects/3001/subagents/sub_done");
  assert.equal(res.status, 200);
  assert.equal((res.body.subagent as SubagentItem).id, "sub_done");
  assert.equal(res.body.running, false);

  const entries = res.body.entries as { kind: string; tool?: string; text?: string; result?: string; ok?: boolean; info?: string }[];
  assert.deepEqual(entries.map((e) => e.kind), ["reasoning", "tool", "text"]);
  assert.equal(entries[0]?.text, "先看看目录");
  assert.equal(entries[1]?.tool, "Bash");
  assert.equal(entries[1]?.result, "a.txt\nb.txt", "工具结果必须落在这里 —— 只有调用没有结果没人读得懂");
  assert.equal(entries[1]?.ok, true);
  assert.equal(entries[1]?.info, "ls -la", "info 和实时流用同一个 toolInfoLine");
  assert.equal(entries[2]?.text, "看完了，目录里两个文件");
});

test("GET /subagents/{id}：还在跑的 → running:true，entries 空（实时过程走 SSE）", async () => {
  const res = await call(fakeSvc(), "/api/projects/3001/subagents/sub_run");
  assert.equal(res.body.running, true);
  assert.deepEqual(res.body.entries, []);
});

test("GET /subagents/{id}：不存在 / 不是本项目的 → 404，不泄露别人家的过程", async () => {
  assert.equal((await call(fakeSvc(), "/api/projects/3001/subagents/sub_nope")).status, 404);

  // 别的项目的子代理：id 猜到了也不能读（归属校验按「项目 / 父线程」判，和列表同口径）
  const other = thread("sub_other", { parentThreadId: "th_other", status: "done" }, 1_000, "p2");
  const svc = fakeSvc([other]);
  const res = await call(svc, "/api/projects/3001/subagents/sub_other");
  assert.equal(res.status, 404);
  assert.match(String(res.body.message), /子代理不存在/);
});

test("GET /subagents：项目不存在 → 404（不是空列表）", async () => {
  const res = await call(fakeSvc(), "/api/projects/3999/subagents");
  assert.equal(res.status, 404);
});

// ── ③ 过程条目 ───────────────────────────────────────────────

test("过程条目：思考 / 正文 / 工具（成功与失败）、step-start 不进过程", () => {
  const parts = [
    { type: "reasoning", text: "r1" },
    { type: "tool-Bash", toolCallId: "c1", toolName: "Bash", input: { command: "ls" }, state: "output-available", output: "ok", startedAt: 7 },
    { type: "step-start" },
    { type: "tool-Read", toolCallId: "c2", toolName: "Read", input: { path: "/x" }, state: "output-error", errorText: "ENOENT" },
    { type: "text", text: "t1" },
  ];
  const store = { listMessages: () => [{ id: "m1", role: "assistant", parts }] };
  const out = subagentEntries(store as never, "sub_x");
  assert.deepEqual(out.map((e) => e.kind), ["reasoning", "tool", "tool", "text"]);
  assert.equal(out[1]?.result, "ok");
  assert.equal(out[1]?.ok, true);
  assert.equal(out[1]?.at, 7);
  assert.equal(out[2]?.result, "ENOENT", "失败的结果也要显示（errorText）");
  assert.equal(out[2]?.ok, false);
});

test("过程条目：多段（续跑落第二条消息）按时间顺序拼；user / system 不混进来", () => {
  const store = {
    listMessages: () => [
      { id: "m1", role: "assistant", parts: [{ type: "text", text: "第一次跑的结论" }] },
      { id: "m2", role: "user", parts: [{ type: "text", text: "追加的要求（不该出现在过程里）" }] },
      { id: "m3", role: "assistant", parts: [{ type: "reasoning", text: "续跑在想" }, { type: "text", text: "续跑的结论" }] },
    ],
  };
  const out = subagentEntries(store as never, "sub_x");
  assert.deepEqual(out.map((e) => e.text), ["第一次跑的结论", "续跑在想", "续跑的结论"]);
});

test("过程条目：读库炸了 → 空数组（不是抛给路由，界面显示「没有留下过程记录」）", () => {
  const store = { listMessages: () => { throw new Error("database is not open"); } };
  assert.deepEqual(subagentEntries(store as never, "sub_x"), []);
});

test("过程条目：超长结果被截断（一段 1MB 的输出不能顺着接口灌进 DOM）", () => {
  const store = {
    listMessages: () => [{
      id: "m1", role: "assistant",
      parts: [{ type: "tool-Bash", toolCallId: "c1", toolName: "Bash", input: {}, state: "output-available", output: "x".repeat(50_000) }],
    }],
  };
  const out = subagentEntries(store as never, "sub_x");
  assert.equal(out.length, 1);
  assert.ok((out[0]?.result?.length ?? 0) < 2_100, "结果被截到 2000 字符左右，实际 " + (out[0]?.result?.length ?? 0));
  assert.match(String(out[0]?.result), /（截断）/);
});

test("过程条目：对象结果序列化成文本（不是 [object Object]）", () => {
  const store = {
    listMessages: () => [{
      id: "m1", role: "assistant",
      parts: [{ type: "tool-Glob", toolCallId: "c1", toolName: "Glob", input: {}, state: "output-available", output: { files: ["a.ts"] } }],
    }],
  };
  assert.equal(subagentEntries(store as never, "sub_x")[0]?.result, '{"files":["a.ts"]}');
});
