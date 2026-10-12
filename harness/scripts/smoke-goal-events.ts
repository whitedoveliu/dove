#!/usr/bin/env node
/**
 * 目标评估结论能不能到面板 —— 老词表（legacy SSE）翻译层的冒烟。
 *
 * 为什么单独测这一层：`goal_eval` / `goal_round` / `goal_blocked` 是**写死在面板词表之外**的
 * 新事件（见 sse-compat.ts 顶部：面板不认的类型等于没发）。落库是好的、`/api/projects/:id/goal`
 * 也读得到，但实时流断掉的表现是「目标一直不完成，界面上一句话都没有」——
 * 用户没法知道是哪条验收标准没过。这条链路只有把事件喂进 toLegacy 才看得出来。
 *
 * 载荷按 goal-runner.ts 实际 emit 的形状构造（字段名逐字对齐），不是想象出来的。
 * 不联网、不调模型、不起内核：翻译层是纯函数，这里断言的就是它的行为。
 */
import "../scripts/_isolate.ts";
import { toLegacy, type LegacyCtx, type LegacyEvent } from "../packages/server/src/legacy/sse-compat.ts";
import type { AgentEvent } from "../packages/core/src/agent/events.ts";

let pass = 0, fail = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) { pass++; console.log("  ✓ " + name + (detail ? `   [${String(detail).slice(0, 150)}]` : "")); }
  else { fail++; fails.push(name); console.log("  ✗ " + name + `   [${String(detail).slice(0, 300)}]`); }
}
const ctx = (): LegacyCtx => ({ hasBuilt: false });
const logs = (evs: LegacyEvent[]): string => evs.map((e) => (e.type === "log" ? e.content : `<${e.type}>`)).join("\n");

console.log("=== 1. 评估通过 → 面板显示「全部通过」，机器可读字段带通过项 ===");
{
  // 与 goal-runner.ts 的 sink 载荷逐字同形
  const e: AgentEvent = {
    type: "goal_eval", pass: true, round: 2, reason: "全部 2 项达标（依据 2 条证据）。",
    failures: [], scored: [{ id: "c1", score: 90 }, { id: "c2", score: 85 }],
    evidence: 2, evaluator: "model",
  };
  const evs = toLegacy(e, ctx());
  check("发出了一条 log（不再被 default 丢掉）", evs.length === 1 && evs[0]!.type === "log", evs.length);
  const log = evs[0] as Extract<LegacyEvent, { type: "log" }>;
  check("人话里有「全部通过」与轮次", /全部通过/.test(log.content) && /第 2 轮/.test(log.content), log.content);
  check("说了依据几条证据", /依据 2 条证据/.test(log.content), log.content);
  check("goal_eval.pass 是 true", log.goal_eval?.pass === true, JSON.stringify(log.goal_eval?.pass));
  check("passed 列出两项", log.goal_eval?.passed.length === 2, JSON.stringify(log.goal_eval?.passed));
  check("形状贴着 GoalVerdict（round/at/items）", log.goal_eval?.round === 2 && typeof log.goal_eval?.at === "number" && log.goal_eval?.items.length === 2);
}

console.log("\n=== 2. 评估未通过 → 逐条点名（id + 得分 + 阈值 + 原因）===");
{
  const e: AgentEvent = {
    type: "goal_eval", pass: false, round: 1, reason: "未通过 1/2 项：c2",
    failures: [{ id: "c2", description: "有对比截图", threshold: 60, score: 41, reason: "低于阈值" }],
    scored: [{ id: "c1", score: 88 }, { id: "c2", score: 41 }],
    evidence: 3, evaluator: "model",
  };
  const log = toLegacy(e, ctx())[0] as Extract<LegacyEvent, { type: "log" }>;
  check("内容点名失败项 id", /c2/.test(log.content), log.content);
  check("内容给出得分与阈值（用户要知道差多少）", /41/.test(log.content) && /60/.test(log.content), log.content);
  check("c1 没被算进失败项", log.goal_eval?.passed.join(",") === "c1", JSON.stringify(log.goal_eval?.passed));
  check("failures 结构完整（id/threshold/score/reason）", log.goal_eval?.failures[0]?.threshold === 60 && log.goal_eval?.failures[0]?.score === 41);
}

console.log("\n=== 3. 空证据 = FAIL：和「分数不够」要分得开 ===");
{
  const e: AgentEvent = {
    type: "goal_eval", pass: false, round: 1, reason: "没有任何证据",
    failures: [{ id: "c1", description: "产物落盘", threshold: 80, score: null, reason: "没有证据引用" }],
    scored: [], evidence: 0, evaluator: "model",
  };
  const log = toLegacy(e, ctx())[0] as Extract<LegacyEvent, { type: "log" }>;
  check("明说依据 0 条证据", /依据 0 条证据/.test(log.content), log.content);
  check("「评估器没给分」不等于「得分 0」", /没给这一项打分/.test(log.content), log.content);
  check("evidence 字段透传（CLI/脚本要能分清）", log.goal_eval?.evidence === 0);
}

console.log("\n=== 4. 结论写不回端口（note）→ 必须说出来，不能只有模型在原地打转 ===");
{
  const e: AgentEvent = {
    type: "goal_eval", pass: true, round: 1, reason: "全过", failures: [],
    scored: [{ id: "c1", score: 99 }], evidence: 1, evaluator: "model",
    note: "目标端口不支持 recordVerdict：评估结论没能落盘，complete 会一直被拒。",
  };
  const log = toLegacy(e, ctx())[0] as Extract<LegacyEvent, { type: "log" }>;
  check("人话里带 ⚠️ 与原因", /⚠️/.test(log.content) && /recordVerdict/.test(log.content), log.content);
  check("结构化 note 也带上了", typeof log.goal_eval?.note === "string");
}

console.log("\n=== 5. 续跑 / 被挡下 ===");
{
  const r = toLegacy({ type: "goal_round", round: 3, objective: "把 X 做完", eval_failures: ["c2", "c3"] }, ctx())[0];
  check("续跑事件说明了上一轮哪几项没过（失败项已下发）",
    r!.type === "log" && /第 3 轮/.test((r as { content: string }).content) && /c2、c3/.test((r as { content: string }).content),
    (r as { content: string }).content);
  const b = toLegacy({ type: "goal_blocked", reason: "目标被暂停，等用户恢复" }, ctx())[0];
  check("被挡下时把原因原样带出来", b!.type === "log" && /等用户恢复/.test((b as { content: string }).content), (b as { content: string }).content);
}

console.log("\n=== 6. 回归：没配 criteria 的目标不产生这类事件；无关事件不受影响 ===");
{
  // 没 criteria 时 goal-runner 压根不发 goal_eval（见 goal-runner.ts 的 `goal.criteria.length > 0`）——
  // 这里断言的是「不相关的普通事件仍然照常翻译」，别把词表改坏
  const t = toLegacy({ type: "text", content: "你好" }, ctx());
  check("普通 text 事件照常翻译", t.length === 1 && t[0]!.type === "text");
  const unknown = toLegacy({ type: "goal_eval_typo" } as AgentEvent, ctx());
  check("不认识的类型仍然是空数组（不许静默变 log）", unknown.length === 0, unknown.length);
}

console.log("\n=== 结果 ===");
console.log(`  通过 ${pass} / 失败 ${fail}`);
if (fail > 0) { console.log("失败项：" + fails.join(" · ")); process.exit(1); }
console.log("✅ 目标评估结论能到面板（老词表翻译已接上）");
