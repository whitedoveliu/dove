/**
 * 调度器「收尾」回归测试
 *
 * 为什么单独一个文件：这条 bug 只在**所有调用都在 prepare 阶段出终态**时才出现，
 * 而它造成的不是错误，是**静默挂死** —— Promise 永不 settle。
 * 实测症状：只读线程里模型调用了一个**已被裁掉**的工具（RunScript），
 * 整轮挂在那儿不动，直到 180 秒超时才被 abort，用户看到的是「转了半天什么都没发生」。
 * 挂死类问题必须有测试盯着，否则下次重构调度器时没人会发现。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { executeBatch } from "../src/loop/tool-exec.ts";
import type { ExecDeps } from "../src/loop/tool-exec.ts";
import type { Tool } from "../src/tools/types.ts";
import type { ToolCallPayload } from "../src/providers/types.ts";

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallPayload =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } }) as unknown as ToolCallPayload;

const deps = (tools: Tool[]): ExecDeps => ({
  tools: new Map(tools.map((t) => [t.name, t])),
  ctxBase: { threadId: "th", workdir: "/tmp", outputsDir: "/tmp", emit: () => { /* 忽略 */ }, services: {} },
  resolveApproval: async () => ({ approved: true }),
}) as unknown as ExecDeps;

const probeTool: Tool = {
  name: "Probe", description: "计数用", parameters: { type: "object", properties: {} },
  outputTier: "exact", approval: "never", concurrencySafe: true,
  execute: async () => ({ ok: true }),
} as unknown as Tool;

/** 超时守卫：挂死的表现是「一直不返回」，所以断言必须带时限 */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => { const t = setTimeout(() => rej(new Error(`${what} 在 ${ms}ms 内没有结束（挂死）`)), ms); (t as { unref?: () => void }).unref?.(); }),
  ]);
}

test("调度：整批调用都修不好时也必须收尾（不能挂死）", async () => {
  // 一个都不在工具表里 —— 这正是「read-only 线程里模型硬调 RunScript」的形状
  const calls = [call("c1", "GoneOne"), call("c2", "GoneTwo"), call("c3", "GoneThree")];
  const out = await withDeadline(executeBatch(calls, deps([])), 3_000, "全部 prepare 失败");
  for (const o of out) assert.equal(o.ok, false);
  assert.equal(out.length, 3);
  assert.match(String(out[0]!.errorText), /未知工具|不存在/);
});

test("调度：坏的 + 好的混在一批，好的照常执行且批次正常收尾", async () => {
  let ran = 0;
  const t: Tool = { ...probeTool, execute: async () => { ran++; return { ok: true }; } } as unknown as Tool;
  const calls = [call("c1", "GoneOne"), call("c2", "Probe"), call("c3", "GoneTwo")];
  const out = await withDeadline(executeBatch(calls, deps([t])), 3_000, "混合批次");
  assert.equal(out.length, 3);
  assert.equal(ran, 1, "唯一可执行的调用必须真的跑了一次");
  assert.equal(out[1]!.ok, true, "结果按调用顺序回填：第 2 个是好调用");
  assert.equal(out[0]!.ok, false);
  assert.equal(out[2]!.ok, false);
});
