/**
 * Plan mode（参考 DSH 的 plan-mode，但按 Dove 的原则收紧）
 *
 * 与 DSH 的差别（这是有意的）：
 * - 状态放**线程 metadata**（和 readOnly / permissionMode 同源），不引入投影系统；
 * - DSH 是纯软引导（工具不锁），Dove 走**硬只读**：计划模式下写类工具直接从工具表里裁掉 ——
 *   「提示词是请求，工具表是能力」，只靠提示词迟早会写。
 * - 退出只能由 ExitPlanMode 工具走审批，或人类 /plan off；模型不能自己"偷偷退出"。
 *
 * 进入：人类在输入框打 /plan（或面板开关）→ 线程 metadata.planMode = true。
 */

import { normalizePermissionMode } from "../tools/approval.ts";

export const PLAN_MODE_KEY = "planMode";

/** 线程是否处于计划模式（metadata 是任意 JSON，做严格判断） */
export function isPlanMode(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[PLAN_MODE_KEY] === true;
}

/** 计划模式下注入给模型的说明（走尾部注入，不进静态提示词，避免破坏前缀缓存） */
export const PLAN_MODE_NOTICE = [
  "<system-reminder>",
  "你现在处于**计划模式**：先把事情想清楚，交给用户批准，再动手。",
  "",
  "计划模式下：",
  "- 你**没有**写类工具（Write / Edit / Bash 这类会改东西的能力不在你的工具表里），只读、检索、提问都正常。",
  "- 先把现状摸清楚（读代码、查记忆、看目录），再写计划；不要在没看清之前就下结论。",
  "- 想清楚之后，调用 ExitPlanMode 提交**完整计划**：markdown、以 `# 标题` 开头，写清要改哪些文件、分几步、怎么验证、有什么风险。",
  "- 用户可能批准（你从下一步开始执行）也可能让你继续改（反馈会出现在工具结果里），照反馈修订后重新提交。",
  "- 需要澄清就先问（AskUserQuestion），不要靠猜写计划。",
  "</system-reminder>",
].join("\n");

/** 计划模式下的工具裁剪原因（与 read-only 区分开，措辞不同） */
export const PLAN_MODE_POLICY_REASON = "plan-mode";

/**
 * 运行时决议：从线程 metadata 一次算出「是否计划模式」与「本轮权限档」。
 * 计划模式 = **硬只读**（写类工具从工具表里裁掉，不是提示词请求）。
 */
export function planAwareMode(metadata: Record<string, unknown> | null | undefined): {
  planMode: boolean;
  permissionMode: ReturnType<typeof normalizePermissionMode>;
} {
  const planMode = metadata?.planMode === true;
  const readOnly = planMode || metadata?.readOnly === true;
  return { planMode, permissionMode: normalizePermissionMode(readOnly ? "read-only" : metadata?.permissionMode) };
}
