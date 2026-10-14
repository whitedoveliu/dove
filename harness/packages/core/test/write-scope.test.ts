/**
 * 写边界（沙箱轴）的**端到端**：真的走 executeOne、真的调 WriteTool、真的问审批。
 *
 * 盯四条契约（全部来自本轮的两轴改造）：
 *   ① workspace-write 越界写 → 弹一次审批；拒绝则**不落盘**，批准才落盘；
 *   ② 勾「同意并记住」→ 第二次同形状不再弹（会话规则命中，而不是再问一遍）；
 *   ③ danger-full-access → 不弹、放行，并发 tool:write-escalated 事件（真放行 ≠ 没人知道）；
 *   ④ 只读子路径（.git 等）在 workspace-write 下任何情况都不放行；凭证目标必问且**不给「记住」**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { executeOne, type ExecDeps } from "../src/loop/tool-exec.ts";
import { WriteTool } from "../src/tools/builtin/write.ts";
import { DEFAULT_PROFILE, DenialMemory, normalizeProfile, type PermissionProfile } from "../src/tools/permission.ts";
import type { ToolCallPayload } from "../src/providers/types.ts";
import type { ToolContext } from "../src/tools/types.ts";

const wsRoot = (): string => mkdtempSync(join(tmpdir(), "dove-ws-"));
const writeCall = (filePath: string, id = "c_write"): ToolCallPayload =>
  ({ id, type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: filePath, content: "hello from dove\n" }) } }) as unknown as ToolCallPayload;

interface Sink { asked: number; requests: { title: string; metadata?: Record<string, unknown> }[]; events: { type: string; [k: string]: unknown }[] }

/** 只实现执行器用到的那两个方法；metadata 可变，好让「记住」真的落库再被读回 */
function fakeStore(state: { metadata: Record<string, unknown> }) {
  return {
    getThread: (id: string) => ({ id, kind: "project", projectId: null, title: "t", metadata: state.metadata }),
    updateThread: (_id: string, patch: { metadata?: Record<string, unknown> }) => { state.metadata = patch.metadata ?? state.metadata; },
  };
}

function depsOf(o: {
  workdir: string;
  permission?: PermissionProfile;
  sink?: Sink;
  store?: { metadata: Record<string, unknown> };
  denials?: DenialMemory;
  approve?: () => { approved: boolean; remember?: boolean; reason?: string };
}): ExecDeps {
  const sink = o.sink;
  const deps: Omit<ExecDeps, "tools"> = {
    ctxBase: {
      threadId: "th_scope", workdir: o.workdir, outputsDir: join(o.workdir, "outputs"),
      emit: (type: string, data: Record<string, unknown>) => { sink?.events.push({ type, ...data }); }, services: {},
    } as Omit<ToolContext, "toolCallId" | "requestApproval">,
    permission: o.permission ?? DEFAULT_PROFILE,
    store: o.store ? (fakeStore(o.store) as never) : undefined,
    denials: o.denials,
    onApprovalNeeded: (id: string, req: { title: string; metadata?: Record<string, unknown> }) => {
      if (!sink) return;
      sink.asked++;
      sink.requests.push({ title: req.title, metadata: req.metadata });
      void id;
    },
    resolveApproval: async () => {
      const v = o.approve?.() ?? { approved: true, remember: false };
      return { approved: v.approved, reason: (v.reason ?? "user") as "user", decision: v.approved ? "allow" : "deny", ...(v.remember === true ? { remember: true } : {}) } as never;
    },
  };
  return { ...deps, tools: new Map([["Write", WriteTool]]) } as ExecDeps;
}

test("workspace-write：越界写 → 弹一次审批；拒绝则不落盘（且不能让模型以为写成功了）", async () => {
  const ws = wsRoot();
  const out = join(wsRoot(), "outside.txt");
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const r = await executeOne(writeCall(out), depsOf({ workdir: ws, sink, approve: () => ({ approved: false, reason: "user" }) }));
  assert.equal(sink.asked, 1, "越界写必须问一次，实际问了 " + sink.asked);
  assert.match(sink.requests[0]!.title, /工作区之外/);
  assert.equal(r.ok, false);
  assert.equal(r.denied, true, "拒绝要标 denied（权限续跑闸门靠它）");
  assert.ok(!existsSync(out), "被拒绝的写绝不能落盘");
  assert.equal(r.errorText?.includes("工作区外"), false, "拒绝文案应说「用户拒绝了」，而不是又报一次围栏");
});

test("workspace-write：批准 → 落盘；勾「记住」→ 第二次同形状不再问", async () => {
  const ws = wsRoot();
  const out = join(wsRoot(), "remembered.txt");
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const store = { metadata: {} as Record<string, unknown> };
  const first = await executeOne(writeCall(out, "c1"), depsOf({ workdir: ws, sink, store, approve: () => ({ approved: true, remember: true }) }));
  assert.equal(first.ok, true, "批准后必须真的写成功：" + JSON.stringify(first.errorText ?? ""));
  assert.equal(readFileSync(out, "utf8"), "hello from dove\n");
  assert.equal(sink.asked, 1);
  // 第二次：同一形状（逐字路径）→ 会话规则命中，不再问
  const second = await executeOne(writeCall(out, "c2"), depsOf({ workdir: ws, sink, store, approve: () => ({ approved: false, reason: "user" }) }));
  assert.equal(sink.asked, 1, "记住了就不该再问第二次（实际又问了一次）");
  assert.equal(second.ok, true, "靠规则放行的第二次应当成功");
});

test("workspace-write：批准但**不**勾记住 → 第二次还会问（默认不问自记 = 偷偷扩大授权）", async () => {
  const ws = wsRoot();
  const out = join(wsRoot(), "not-remembered.txt");
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const store = { metadata: {} as Record<string, unknown> };
  await executeOne(writeCall(out, "c1"), depsOf({ workdir: ws, sink, store, approve: () => ({ approved: true }) }));
  await executeOne(writeCall(out, "c2"), depsOf({ workdir: ws, sink, store, approve: () => ({ approved: true }) }));
  assert.equal(sink.asked, 2);
  assert.equal(store.metadata.approvalRules, undefined, "没勾记住就不许往 metadata 写规则");
});

test("danger-full-access：越界写不弹审批、真的落盘，并留下 tool:write-escalated 审计事件", async () => {
  const ws = wsRoot();
  const out = join(wsRoot(), "full-access.txt");
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const profile = normalizeProfile({ permissionMode: "full" });
  const r = await executeOne(writeCall(out), depsOf({ workdir: ws, sink, permission: profile }));
  assert.equal(sink.asked, 0, "完全权限不许再问（这正是本轮要修的 bug）");
  assert.equal(r.ok, true, "完全权限下越界写必须成功：" + JSON.stringify(r.errorText ?? ""));
  assert.equal(readFileSync(out, "utf8"), "hello from dove\n");
  assert.ok(sink.events.some((e) => e.type === "tool:write-escalated"), "越界放行要留审计事件");
});

test("额外可写目录：把工作区外的目标变成区内 → 不问、直接写", async () => {
  const ws = wsRoot();
  const extra = wsRoot();
  const out = join(extra, "in-extra-root.txt");
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const profile: PermissionProfile = { ...DEFAULT_PROFILE, writableRoots: [extra] };
  const r = await executeOne(writeCall(out), depsOf({ workdir: ws, sink, permission: profile }));
  assert.equal(sink.asked, 0, "在可写根里就不该问");
  assert.equal(r.ok, true);
  assert.ok(existsSync(out));
});

test("只读子路径：.git 下任何档位（workspace-write）都不放行，且**不可审批**", async () => {
  const ws = wsRoot();
  mkdirSync(join(ws, ".git"), { recursive: true });
  const out = join(ws, ".git", "hooks", "post-commit");
  mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const r = await executeOne(writeCall(out), depsOf({ workdir: ws, sink, approve: () => ({ approved: true, remember: true }) }));
  assert.equal(sink.asked, 0, "受保护路径不给审批选项（问了就等于给了放行口）");
  assert.equal(r.ok, false);
  assert.match(String(r.errorText), /受保护路径/);
  assert.ok(!existsSync(out), "绝不能落盘");
});

test("凭证目标：必问一次、且请求里带 noRemember（面板据此不画「记住」）", async () => {
  const ws = wsRoot();
  const target = join(homedir(), ".ssh", "id_dove_probe_test");
  rmSync(target, { force: true });          // 自清理：万一上次跑留了残留，别让断言失真
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const r = await executeOne(writeCall(target), depsOf({ workdir: ws, sink, approve: () => ({ approved: false, reason: "user" }) }));
  assert.equal(sink.asked, 1, "凭证目标必须问（任何档位）");
  assert.equal(sink.requests[0]!.metadata?.noRemember, true, "凭证类不给「记住」");
  assert.match(sink.requests[0]!.title, /凭证/);
  assert.equal(r.denied, true);
  assert.ok(!existsSync(target), "拒绝后不该有任何文件（探针文件都不该出现）");
});

test("凭证目标：即使完全权限也要问（这是唯一一条所有档位都拦的写侧边界）", async () => {
  const ws = wsRoot();
  const target = join(homedir(), ".ssh", "id_dove_probe_test2");
  rmSync(target, { force: true });
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const r = await executeOne(writeCall(target), depsOf({
    workdir: ws, sink, permission: normalizeProfile({ permissionMode: "full" }),
    approve: () => ({ approved: false, reason: "user" }),
  }));
  assert.equal(sink.asked, 1, "完全权限下凭证写入仍要问一次");
  assert.equal(r.denied, true);
  assert.ok(!existsSync(target), "被拒的凭证写绝不能落盘（曾因策略顺序错而真的写进去过）");
});

test("工作区内的普通写：不问、不标 escalated（既有行为不许回归）", async () => {
  const ws = wsRoot();
  const out = join(ws, "inside.txt");
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const r = await executeOne(writeCall(out), depsOf({ workdir: ws, sink }));
  assert.equal(sink.asked, 0);
  assert.equal(r.ok, true);
  assert.ok(!sink.events.some((e) => e.type === "tool:write-escalated"), "区内写不是越界，不该发升级事件");
  assert.equal(readFileSync(out, "utf8"), "hello from dove\n");
});

test("工具侧兜底：**绕过审批链**直接调 Write（= 策略没接线）时，越界写被工具内护栏拒掉 —— fail-closed", async () => {
  const ws = wsRoot();
  const out = join(wsRoot(), "fallback-denied.txt");
  // 直接调工具、ctx 里不带 permission（模拟"策略链没跑"或"忘了接线"）
  const ctx = {
    toolCallId: "c_direct", threadId: "th_direct", workdir: ws, outputsDir: join(ws, "outputs"),
    emit: () => { /* 忽略 */ }, requestApproval: async () => ({ approved: true, decision: "allow" as const }), services: {},
  };
  const r = await WriteTool.execute({ file_path: out, content: "x" }, ctx as never);
  assert.ok("error" in r, "没接线时必须由工具内护栏拦住（不许静默放宽），实际：" + JSON.stringify(r));
  assert.match(String((r as { error?: string }).error), /工作区外/);
  assert.ok(!existsSync(out), "文件不能落盘");
});

test("写文件到工作区外但内容为空也必须走同一条链（不能有只读空文件的捷径）", async () => {
  const ws = wsRoot();
  const out = join(wsRoot(), "empty-outside.txt");
  const p = join(ws, "seed.txt");
  writeFileSync(p, "x");
  const r = await executeOne(
    { id: "c_empty", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: out, content: "" }) } } as unknown as ToolCallPayload,
    depsOf({ workdir: ws, approve: () => ({ approved: false, reason: "user" }) }),
  );
  assert.equal(r.denied, true);
  assert.ok(!existsSync(out));
});

test("同一形状被拒后不再重复打扰：第二次直接拒，且**不弹窗**", async () => {
  const ws = wsRoot();
  const out = join(wsRoot(), "repeat-denied.txt");
  const sink: Sink = { asked: 0, requests: [], events: [] };
  const denials = new DenialMemory();
  const first = await executeOne(writeCall(out, "c1"), depsOf({ workdir: ws, sink, denials, approve: () => ({ approved: false, reason: "user" }) }));
  assert.equal(sink.asked, 1);
  assert.equal(first.denied, true);
  // 第二次：换了审批回调（如果还弹窗，这次会被「批准」——用它来证明**根本没弹**）
  const second = await executeOne(writeCall(out, "c2"), depsOf({ workdir: ws, sink, denials, approve: () => ({ approved: true }) }));
  assert.equal(sink.asked, 1, "同一形状不该再问第二次");
  assert.equal(second.denied, true, "被记忆的拒绝要直接拒绝");
  assert.match(String(second.errorText), /拒绝/);
  assert.ok(!existsSync(out));
  // 换个形状（不同路径）→ 照常问
  const other = await executeOne(writeCall(join(wsRoot(), "another.txt"), "c3"), depsOf({ workdir: ws, sink, denials, approve: () => ({ approved: false, reason: "user" }) }));
  assert.equal(sink.asked, 2, "不同形状不受影响");
  assert.equal(other.denied, true);
});
