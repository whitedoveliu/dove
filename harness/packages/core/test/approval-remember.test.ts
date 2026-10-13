/**
 * 「同意并记住」的最后一公里
 *
 * 机制（规则形状解析 + 匹配 + 落库）在 tools/rule-pattern.ts 里已经有单测，
 * 但**接线**是三层拼起来的：`ApprovalResponse.remember` → `loop/tool-exec.ts:finishApproval`
 * → `rememberSessionRule` → 线程 metadata。任何一层断了，用户看到的现象都是
 * 「点了『记住』，下次还是弹」——而且不报错、不告警，纯静默。
 * 实测：这条链在本次改动前是断的（`--remember` 连参数都传不进来）。
 * 所以这里端到端钉一遍：一次真的执行 + 一次真的写库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { executeOne } from "../src/loop/tool-exec.ts";
import type { ExecDeps } from "../src/loop/tool-exec.ts";
import { BashTool } from "../src/tools/builtin/bash.ts";
import type { ToolCallPayload } from "../src/providers/types.ts";

interface Patch { metadata?: { approvalRules?: { rule: string; decision: string }[] } }

/** 只实现执行器需要的那两个方法：getThread / updateThread */
function fakeStore(sink: { patch?: Patch }) {
  return {
    getThread: (id: string) => ({ id, kind: "project", projectId: null, title: "t", metadata: {} }),
    updateThread: (_id: string, patch: Patch) => { sink.patch = patch; },
  };
}

function depsFor(sink: { patch?: Patch }, remember: boolean): ExecDeps {
  return {
    tools: new Map([["Bash", BashTool]]),
    ctxBase: { threadId: "th_remember", workdir: "/tmp", outputsDir: "/tmp", emit: () => { /* 忽略 */ }, services: {} },
    store: fakeStore(sink),
    // workspace-write + 一条会被本地启发式判成 medium 的命令 → 一定会走到 ask
    permissionMode: "workspace-write",
    resolveApproval: async () => ({ approved: true, decision: "allow", reason: "user", ...(remember ? { remember: true } : {}) }),
  } as unknown as ExecDeps;
}

const bashCall = (command: string): ToolCallPayload =>
  ({ id: "c_remember", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command }) } }) as unknown as ToolCallPayload;

test("remember=true → 规则写进线程 metadata（形状 = 工具自报的 approvalRule）", async () => {
  const sink: { patch?: Patch } = {};
  const cmd = "rm -rf /tmp/dove-does-not-exist-remember-test";
  const out = await executeOne(bashCall(cmd), depsFor(sink, true));
  assert.equal(out.ok, true, "被批准的命令应当真的执行");
  const rules = sink.patch?.metadata?.approvalRules;
  assert.ok(Array.isArray(rules) && rules.length === 1, "必须恰好写一条规则，实际：" + JSON.stringify(sink.patch));
  assert.equal(rules![0]!.rule, "Bash(" + cmd + ")", "规则形状来自工具自报的 approvalRule（工具名 + 参数 glob）");
  assert.equal(rules![0]!.decision, "allow");
});

test("remember 缺省 → 一条规则都不写（不问自记 = 偷偷扩大授权）", async () => {
  const sink: { patch?: Patch } = {};
  const out = await executeOne(bashCall("rm -rf /tmp/dove-does-not-exist-remember-test"), depsFor(sink, false));
  assert.equal(out.ok, true);
  assert.equal(sink.patch, undefined, "没有显式 remember 就不许写规则，实际：" + JSON.stringify(sink.patch));
});
