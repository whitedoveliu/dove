/**
 * 审批请求 → 面板 `ask_user` 事件的翻译层（server/legacy/sse-approval.ts）。
 *
 * 为什么单独立一条：面板**只认这个事件**里的 `remember_rule` 来决定画不画「同意并记住」。
 * 本轮新增的凭证类边界（`metadata.noRemember=true`）如果在这一层丢了，
 * 面板就会画出一个点了**什么都不会记住**的选项 —— 那是把「假选项」当安全特性卖。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { approvalAskEvents } from "../../server/src/legacy/sse-approval.ts";
import { WriteTool } from "../src/tools/builtin/write.ts";
import type { LegacyCtx } from "../../server/src/legacy/sse-compat.ts";
import type { AgentEvent } from "../src/agent/events.ts";

function ctxFor(toolCallId: string, tool: string, input: Record<string, unknown>): LegacyCtx {
  return {
    hasBuilt: false,
    tools: new Map([["Write", WriteTool]]),
    toolCalls: new Map([[toolCallId, { tool, input }]]),
  };
}

const approvalEvent = (extra: Record<string, unknown> = {}): AgentEvent => ({
  type: "tool_approval", toolCallId: "c1", title: "允许吗？", message: "m", riskLevel: "medium", ...extra,
});

test("普通审批：算出 remember_rule（面板据此画「同意并记住」）", () => {
  const ctx = ctxFor("c1", "Write", { file_path: "/tmp/outside/x.txt", content: "x" });
  const [e] = approvalAskEvents(approvalEvent(), ctx);
  assert.ok(e && e.type === "ask_user");          // 收窄到 ask_user 变体（断言即类型守卫）
  assert.equal(e.approval, true);
  assert.equal(e.remember_rule, "Write(/tmp/outside/x.txt)", "形状必须与内核真正落库的那条逐字一致");
});

test("metadata.noRemember：**不给** remember_rule（面板不画那个选项）", () => {
  const ctx = ctxFor("c1", "Write", { file_path: "/Users/x/.ssh/authorized_keys", content: "x" });
  const [e] = approvalAskEvents(approvalEvent({ metadata: { kind: "credential-write", noRemember: true } }), ctx);
  assert.ok(e && e.type === "ask_user");
  assert.equal(e.remember_rule, undefined, "凭证类不许出现「记住」——否则点了等于给自己发一张永久通行证");
  assert.equal(e.approval, true, "仍然是一次审批（不是普通提问）");
  assert.match(e.question, /允许吗/, "标题照旧透传");
});

test("算不出形状（工具没声明 approvalRule / 没有 tool_start 记录）：同样不给 remember_rule", () => {
  const [e] = approvalAskEvents(approvalEvent(), { hasBuilt: false, tools: new Map(), toolCalls: new Map() });
  assert.ok(e && e.type === "ask_user");
  assert.equal(e.remember_rule, undefined);
});
