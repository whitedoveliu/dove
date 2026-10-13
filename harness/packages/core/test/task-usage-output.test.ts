/**
 * 任务 usage 的**模型可见输出**（TaskOutput / RuntimeStatus）。
 *
 * 判据只有一条：**没上报就是「未上报」，不许写成 0** ——
 * 0 会被模型读成「这活没花 token」，据此做取舍就是拿假数据决策
 * （内核的存储纪律见 agents/task-registry.ts:finish，存的是 NULL 不是 0）。
 * usage 是**追加字段**：既有字段一个都不许丢，这里顺带钉住。
 *
 * 与 task-usage.test.ts 的分工：那边管「落库 / 迁移 / 宿主写入」，这边管
 * 「工具给模型看的那一眼」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TaskOutputTool } from "../src/tools/builtin/task-output.ts";
import { RuntimeStatusTool } from "../src/tools/builtin/runtime-status.ts";
import type { ToolContext } from "../src/tools/types.ts";

function ctxWith(services: Record<string, unknown>): ToolContext {
  return {
    toolCallId: "c1", threadId: "th", workdir: "/tmp", outputsDir: "/tmp/outputs",
    emit: () => { /* 忽略 */ }, requestApproval: async () => ({ approved: true }), services,
  } as unknown as ToolContext;
}

interface TaskOut {
  taskId: string; label: string; status: string; result: string; usage: unknown; note?: string;
}

test("TaskOutput：有 usage → 给出 input_tokens/output_tokens（既有字段原样保留）", async () => {
  const out = await TaskOutputTool.execute(
    { task_id: "task_1" },
    ctxWith({
      getTask: () => ({
        taskId: "task_1", label: "跑测试", status: "done", result: "全绿",
        usage: { inputTokens: 11, outputTokens: 7 },
      }),
    }),
  ) as unknown as TaskOut;

  assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 7 });
  // 追加字段不许挤掉旧的
  assert.equal(out.taskId, "task_1");
  assert.equal(out.label, "跑测试");
  assert.equal(out.status, "done");
  assert.equal(out.result, "全绿");
});

test("TaskOutput：provider 没报 → 「未上报」，**不是 0**", async () => {
  const out = await TaskOutputTool.execute(
    { task_id: "task_2" },
    ctxWith({ getTask: () => ({ taskId: "task_2", label: "跑测试", status: "done", result: "全绿" }) }),
  ) as unknown as TaskOut;
  assert.equal(out.usage, "未上报");
});

test("TaskOutput：还在跑（block=false）也不编用量", async () => {
  const out = await TaskOutputTool.execute(
    { task_id: "task_3" },
    ctxWith({ getTask: () => ({ taskId: "task_3", label: "跑测试", status: "running" }) }),
  ) as unknown as TaskOut;
  assert.equal(out.status, "running");
  assert.equal(out.usage, "未上报");
});

test("RuntimeStatus：后台任务逐条带 usage；没报的是「未上报」不是 0", async () => {
  const out = await RuntimeStatusTool.execute(
    {},
    ctxWith({
      listTasks: () => [
        { id: "task_a", kind: "调研", status: "done", prompt: "查资料", createdAt: 1, finishedAt: 2, usage: { inputTokens: 1200, outputTokens: 300 } },
        { id: "task_b", kind: "老任务", status: "done", prompt: "老的", createdAt: 1, finishedAt: 2 },
      ],
    }),
  ) as unknown as { background_tasks: { available: boolean; items: { id: string; usage: unknown }[] } };

  assert.equal(out.background_tasks.available, true);
  assert.deepEqual(out.background_tasks.items.find((t) => t.id === "task_a")?.usage, { input_tokens: 1200, output_tokens: 300 });
  assert.equal(out.background_tasks.items.find((t) => t.id === "task_b")?.usage, "未上报");
});
