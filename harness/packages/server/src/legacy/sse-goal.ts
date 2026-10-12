/**
 * 目标事件 → 老词表的翻译（单独一个文件：sse-compat.ts 已经顶到 400 行上限）。
 *
 * 三条纪律：
 *  ① **不新造事件类型**：面板认的词表是写死的，它不认的类型等于没发 ——
 *     所以结论挂在 `log` 上（面板只读 content 显示人话），机器可读的部分放 `goal_eval` 字段；
 *  ② 失败项必须**逐条点名**（id + 得分 + 阈值 + 原因）：用户看到的不能只是「未通过」，
 *     否则他不知道该改哪一条 —— 这正是加独立评估器的目的；
 *  ③ 空证据和没达标要分得开（一个「没证据」，一个「分数不够」），这两件事的下一步动作不同。
 */
import type { AgentEvent } from "../../../core/src/agent/events.ts";
import type { GoalFailureItem, CriterionScore } from "../../../core/src/agents/goal-criteria.ts";
import type { LegacyEvent, LegacyGoalEval } from "./sse-compat.ts";

/** 一条失败项的人话：分不清「没打分」和「分不够」，用户就不知道该补证据还是补质量 */
function failureLine(f: GoalFailureItem): string {
  const score = f.score === null || f.score === undefined ? "评估器没给这一项打分" : `得分 ${f.score} < 阈值 ${f.threshold}`;
  return `${f.id}（${score}：${f.reason}）`;
}

export function goalLegacyEvents(e: AgentEvent): LegacyEvent[] {
  if (e.type === "goal_eval") {
    const failures = (Array.isArray(e.failures) ? e.failures : []) as GoalFailureItem[];
    const items = (Array.isArray(e.scored) ? e.scored : []) as CriterionScore[];
    const round = Number(e.round ?? 0);
    const evidence = Number(e.evidence ?? 0);
    const pass = e.pass === true;
    const failedIds = new Set(failures.map((f) => f.id));
    const passed = items.map((s) => s.id).filter((id) => !failedIds.has(id));

    const head = pass
      ? `🎯 目标评估（第 ${round} 轮）：全部通过（${items.length} 项）`
      : `🎯 目标评估（第 ${round} 轮）：未通过 —— ${failures.map(failureLine).join("；")}`;
    // 证据条数是分清「没证据」和「没达标」的关键；note 是端口写不回结论时的实话
    const tail = `｜依据 ${evidence} 条证据${e.note ? `；⚠️ ${String(e.note)}` : ""}`;

    const verdict: LegacyGoalEval = {
      pass, round, at: Date.now(), items, failures,
      reason: String(e.reason ?? ""),
      passed, evidence,
      evaluator: String(e.evaluator ?? "unknown"),
      ...(e.note ? { note: String(e.note) } : {}),
    };
    return [{ type: "log", content: head + tail, goal_eval: verdict }];
  }

  if (e.type === "goal_round") {
    const failed = Array.isArray(e.eval_failures) ? (e.eval_failures as string[]) : [];
    const why = failed.length > 0 ? `（上一轮未通过：${failed.join("、")} —— 失败项已作为反馈下发）` : "";
    return [{ type: "log", content: `🎯 目标续跑（第 ${Number(e.round ?? 0)} 轮）${why}` }];
  }

  if (e.type === "goal_blocked") {
    // 停下不是失败，是「需要人」：把原因原样带出来，用户才知道下一步做什么
    return [{ type: "log", content: `⏸ 目标被挡下：${String(e.reason ?? "需要用户确认")}` }];
  }

  return [];
}
