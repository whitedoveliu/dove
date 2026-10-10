/**
 * 目标（Goal）：存储状态机 + 三个工具 + 续跑判定 —— **真实执行**，不 mock 存储。
 *
 * 为什么单独一个文件：core.test.ts 已接近 400 行上限；goal 这条线是新增能力，独立成篇更好读。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/session/db.ts";
import { GoalStore } from "../src/agents/goal-store.ts";
import { CreateGoalTool } from "../src/tools/builtin/goal-create.ts";
import { GetGoalTool } from "../src/tools/builtin/goal-get.ts";
import { UpdateGoalTool } from "../src/tools/builtin/goal-update.ts";
import { decideGoalContinuation, renderGoalRoundPrompt } from "../src/agent/goal-round.ts";

type AnyTool = { execute: (input: Record<string, unknown>, ctx: never) => Promise<Record<string, unknown>> };

function ctxFor(goals: GoalStore, threadId = "th_goal_test"): never {
  return {
    toolCallId: "call_1", threadId, workdir: "/tmp", outputsDir: "/tmp/outputs",
    emit: () => { /* 测试里不关心事件 */ },
    services: { goals },
  } as never;
}

const run = (tool: AnyTool, input: Record<string, unknown>, ctx: never) => tool.execute(input, ctx);

test("目标：建 → 读 → 并发保护 → 暂停/继续 → 轮次用满 → 完成", async () => {
  const db = new Db(":memory:");
  const goals = new GoalStore(db);
  const ctx = ctxFor(goals);

  const created = await run(CreateGoalTool as AnyTool, { objective: "把 X 做完", max_rounds: 2 }, ctx);
  assert.equal(created.ok, true);
  const goal = created.goal as Record<string, unknown>;
  assert.equal(goal.phase, "active");
  assert.equal(goal.revision, 1);
  assert.equal(goal.max_rounds, 2);

  const read = await run(GetGoalTool as AnyTool, {}, ctx);
  assert.equal((read.goal as Record<string, unknown>).id, goal.id);

  // 过期 revision 必须被拒 —— 防模型覆盖用户刚做的修改
  const stale = await run(UpdateGoalTool as AnyTool, { goal_id: goal.id, revision: 99, action: "pause" }, ctx);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "GOAL_STALE_REVISION");

  const paused = await run(UpdateGoalTool as AnyTool, { goal_id: goal.id, revision: 1, action: "pause" }, ctx);
  assert.equal((paused.goal as Record<string, unknown>).phase, "paused");
  const resumed = await run(UpdateGoalTool as AnyTool, { goal_id: goal.id, revision: 2, action: "resume" }, ctx);
  assert.equal((resumed.goal as Record<string, unknown>).phase, "active");

  // 已经有未完成目标时不许再建一个
  const dup = await run(CreateGoalTool as AnyTool, { objective: "另一个目标" }, ctx);
  assert.equal(dup.ok, false);
  assert.equal(dup.code, "GOAL_ALREADY_EXISTS");

  // 标 blocked 必须给理由
  const noReason = await run(UpdateGoalTool as AnyTool, { goal_id: goal.id, revision: 3, action: "blocked" }, ctx);
  assert.equal(noReason.ok, false);
  assert.equal(noReason.code, "GOAL_BAD_INPUT");

  // 续跑到上限：判定必须从 continue 变成 blocked
  const before = goals.get("th_goal_test")!;
  assert.equal(decideGoalContinuation(before).action, "continue");
  const r1 = goals.bumpRound("th_goal_test", before.id, before.revision);
  const r2 = goals.bumpRound("th_goal_test", r1.id, r1.revision);
  const after = goals.get("th_goal_test")!;
  assert.equal(after.roundsStarted, 2);
  assert.equal(decideGoalContinuation(after).action, "blocked");
  // 轮次用满后 resume 也要被拒
  const resumeLate = await run(UpdateGoalTool as AnyTool, { goal_id: r2.id, revision: r2.revision, action: "resume" }, ctx);
  assert.equal(resumeLate.ok, false);

  // 暂停的目标不续跑
  const paused2 = await run(UpdateGoalTool as AnyTool, { goal_id: r2.id, revision: r2.revision, action: "complete" }, ctx);
  assert.equal((paused2.goal as Record<string, unknown>).phase, "complete");
  assert.equal(decideGoalContinuation(goals.get("th_goal_test")).action, "stop");

  // 续跑提示词必须带上目标与轮次（模型靠它知道"这是第几轮、还剩几轮"）
  const prompt = renderGoalRoundPrompt({ objective: "把 X 做完", roundsStarted: 0, maxRounds: 2 });
  assert.match(prompt, /<goal_round>/);
  assert.match(prompt, /把 X 做完/);
  assert.match(prompt, /1\/2/);
  db.close();
});
