/**
 * 审批被拒时的**措辞契约**（从 approval-and-scheduler.test.ts 拆出来：那边贴着 400 行上限）
 *
 * 为什么值得单独立一条契约：模型读到的每一句话都会改变它的下一步。
 *   · **规则/边界**拒的（会话规则、受保护路径、已拒形状、只读沙箱）要说清是哪一条 ——
 *     写成「用户拒绝了这次操作」会让模型以为有人在看，于是换个写法再试一次，而实际上根本没有人在场；
 *   · **用户本人**点的拒绝，措辞就是「用户拒绝了这次操作」（既有契约，不许漂移）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { executeOne, type ExecDeps } from "../src/loop/tool-exec.ts";
import { rememberSessionRule } from "../src/tools/rule-pattern.ts";
import type { Tool, ToolContext } from "../src/tools/types.ts";
import type { ToolCallPayload } from "../src/providers/types.ts";

const WS = "/ws";
const call = (name: string, args: Record<string, unknown>): ToolCallPayload =>
  ({ id: name.toLowerCase() + "_deny", type: "function", function: { name, arguments: JSON.stringify(args) } });

function bashLike(): Tool {
  return {
    name: "Bash", description: "b", parameters: { type: "object", properties: {}, required: [] },
    outputTier: "exact", approval: "heuristic", concurrencySafe: false,
    approvalRule: (a) => (typeof a.command === "string" ? a.command : undefined),
    execute: async () => ({ ok: true }),
  };
}

function depsOf(o: {
  store?: ExecDeps["store"];
  approve?: () => { approved: boolean; reason?: string };
  onApprovalNeeded?: ExecDeps["onApprovalNeeded"];
}): ExecDeps {
  const tool = bashLike();
  return {
    tools: new Map([[tool.name, tool]]),
    ctxBase: {
      threadId: "th_d", workdir: WS, outputsDir: WS + "/outputs", emit: () => { /* 忽略 */ }, services: {},
    } as Omit<ToolContext, "toolCallId" | "requestApproval">,
    store: o.store,
    onApprovalNeeded: o.onApprovalNeeded,
    resolveApproval: async () => {
      const v = o.approve?.() ?? { approved: true };
      return { approved: v.approved, reason: (v.reason ?? "user") as "user", decision: v.approved ? "allow" : "deny" } as never;
    },
  };
}

test("会话 deny 规则 → 说明是规则拒的（不嫁祸给用户），且不再问", async () => {
  const store = new Store(new Db(":memory:"));
  store.createThread({ id: "th_d", kind: "project", title: "t" });
  const tool = bashLike();
  rememberSessionRule(store, "th_d", "Bash", { command: "rm -rf /tmp/x" }, tool, "deny");
  let asked = 0;
  const out = await executeOne(call("Bash", { command: "rm -rf /tmp/x" }), depsOf({ store, onApprovalNeeded: () => { asked++; } }));
  assert.equal(asked, 0, "记住的是拒绝 → 不该再问");
  assert.equal(out.ok, false);
  assert.equal(out.denied, true);
  assert.match(String(out.errorText), /^\[权限\] 这次调用被拒绝：/);
  assert.match(String(out.errorText), /会话规则/);
});

test("用户本人点的拒绝，措辞仍是「用户拒绝了这次操作」", async () => {
  const out = await executeOne(call("Bash", { command: "rm -rf /tmp/x" }), depsOf({ approve: () => ({ approved: false, reason: "user" }) }));
  assert.equal(out.denied, true);
  assert.equal(out.errorText, "[权限] 用户拒绝了这次操作。");
});
