/**
 * ExitPlanMode —— 计划模式下提交计划给用户审阅
 *
 * 分工（刻意这样切）：
 * - **审批在本工具里**：直接用 ctx.requestApproval，走的是全应用唯一的审批通道
 *   （面板的审批弹窗 / CLI 的自动放行），不另造一套"计划审阅 UI"；
 * - **切模式在服务里**：ctx.services.exitPlanMode 只负责把线程 metadata 的 planMode 关掉，
 *   由 server 层实现（工具不自己改 metadata —— 避免"工具偷偷切模式"）。
 */
import { defineTool, S } from "../types.ts";
import { guarded, optStr } from "./util.ts";

/** 计划必须是非空 markdown，且以一级标题开头（和 DSH 的校验一致） */
export const PLAN_HEADING_RE = /^#\s+\S/;

export const ExitPlanModeTool = defineTool({
  name: "ExitPlanMode",
  description:
    "只在计划模式下可用：把**完整计划**交给用户审阅；批准后退出计划模式，你从下一步开始执行。"
    + "用户也可能让你继续改（反馈会回到工具结果里），那就修订后重新提交。"
    + "计划是 markdown，必须以 \`# 标题\` 开头，要写清：改哪些文件、分几步、怎么验证、有什么风险。",
  parameters: S.obj({
    plan: S.str("完整计划（markdown，以 \`# 标题\` 开头）"),
  }, ["plan"]),
  outputTier: "exact",
  approval: "never",   // 审批由本工具的 execute 自己做（要带计划全文，不能只给 JSON 参数）
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const plan = (optStr(input, "plan") ?? "").trim();
    if (!plan) return { approved: false, error: "计划不能为空：写清要做什么再提交。" };
    if (!PLAN_HEADING_RE.test(plan)) {
      return { approved: false, error: "计划必须是 markdown 且以 \`# 标题\` 开头（用户要能一眼看到计划名）。" };
    }

    const res = await ctx.requestApproval({
      title: "计划审阅：批准后开始执行",
      message: plan,
      riskLevel: "low",
      metadata: { kind: "plan-review", plan },
    });
    if (!res.approved) {
      const why = (res.denyReason ?? "").trim();
      return {
        approved: false,
        error: why
          ? "用户没有批准，反馈：" + why + " —— 按反馈修订计划后重新提交。"
          : "用户没有批准（或没有回应）。继续完善计划，想清楚再提交一次；也可以先问清楚再改。",
      };
    }

    const exit = ctx.services.exitPlanMode;
    if (!exit) {
      return { approved: false, error: "批准通过了，但退出计划模式的通道没接上（服务未装配）—— 把这个情况告诉用户。" };
    }
    const r = await exit(plan);
    if (!r.ok) return { approved: false, error: r.error ?? "退出计划模式失败。" };
    return {
      approved: true,
      note: "计划已批准，计划模式已退出 —— 从下一步开始按计划执行，先做第一步。"
      + "执行中如果发现计划需要改，直接说清为什么改，不要闷头做完再说。",
    };
  }),
});
