/**
 * 子代理是否**继承**父线程这一轮的权限（两轴 profile）。
 *
 * 为什么单独一个文件：`subagent-roles.test.ts` 贴着 400 行上限，而这条不变量跟"角色"无关 ——
 * 它盯的是 `SubagentHost` 的 `#childDeps` 展开父 `ExecDeps` 这件事（`{...this.#execDeps}`）。
 * 断了的表现很安静：子代理拿默认档去跑，用户明明选了完全权限，子代理却回头问审批。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { TaskRegistry } from "../src/agents/task-registry.ts";
import { SubagentHost } from "../src/agent/subagent-host.ts";
import { WriteTool } from "../src/tools/builtin/write.ts";
import { normalizeProfile, type PermissionProfile } from "../src/tools/permission.ts";
import type { Tool } from "../src/tools/types.ts";
import type { ChatMessage, Provider, StreamResult } from "../src/providers/types.ts";

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): StreamResult => ({ text, reasoning: "", toolCalls: [], usage: { ...USAGE }, finishReason: "stop" });
const writeCall = (path: string): StreamResult => ({
  text: "", reasoning: "", usage: { ...USAGE }, finishReason: "tool_calls",
  toolCalls: [{ id: "c_write", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: path, content: "child" }) } }],
});

/** 第 1 步调 Write，之后给答复（按**调用序号**判断：子代理的 wire 里还有系统提示词） */
function scriptedWrite(path: string): Provider {
  let step = 0;
  return {
    id: "stub-perm",
    stream: async (_opts: { messages: ChatMessage[] }) => (++step === 1 ? writeCall(path) : answer("做完了")),
  };
}

interface Setup { host: SubagentHost; approvals: number }
function makeHost(input: { workdir: string; profile: PermissionProfile; provider: Provider; onApprove?: () => void }): Setup {
  const db = new Db(":memory:");
  const store = new Store(db);
  const tasks = new TaskRegistry(db);
  store.createThread({ id: "th_parent", kind: "project", title: "父线程" });
  const state: Setup = { host: undefined as unknown as SubagentHost, approvals: 0 };
  const host = new SubagentHost({
    provider: input.provider, model: "deepseek-flash",
    tools: new Map<string, Tool>([["Write", WriteTool]]),
    execDeps: {
      ctxBase: {
        threadId: "th_parent", workdir: input.workdir, outputsDir: join(input.workdir, "outputs"),
        emit: () => { /* 不参与断言 */ }, services: {},
      },
      permission: input.profile,          // 父线程这一轮的权限 —— 子代理必须继承它
      resolveApproval: async () => { state.approvals++; input.onApprove?.(); return { approved: false }; },
    },
    store, tasks, parentThreadId: "th_parent",
    sink: () => { /* 忽略 */ }, services: {},
  });
  state.host = host;
  return state;
}

test("完全权限继承：子代理越界写直接落盘，一次审批都不问", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dove-perm-ws-"));
  const outside = join(mkdtempSync(join(tmpdir(), "dove-perm-out-")), "child.txt");
  const env = makeHost({ workdir: ws, profile: normalizeProfile({ permissionMode: "full" }), provider: scriptedWrite(outside) });
  const r = await env.host.spawn("写一个工作区外的文件", "越界写", false);
  assert.equal(r.status, "done");
  assert.equal(env.approvals, 0, "完全权限必须继承到子代理（否则它会拿默认档去问）");
  assert.ok(existsSync(outside), "越界写在完全权限下必须真的落盘：" + outside);
});

test("工作区模式继承：子代理越界写会问到父线程的审批通道；拒绝则不落盘", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dove-perm-ws2-"));
  const outside = join(mkdtempSync(join(tmpdir(), "dove-perm-out2-")), "child2.txt");
  const env = makeHost({ workdir: ws, profile: normalizeProfile({ permissionMode: "workspace-write" }), provider: scriptedWrite(outside) });
  await env.host.spawn("写一个工作区外的文件", "越界写2", false);
  assert.equal(env.approvals, 1, "工作模式下越界写必须弹一次审批（实际：" + env.approvals + "）");
  assert.ok(!existsSync(outside), "拒绝了就不许落盘");
});
