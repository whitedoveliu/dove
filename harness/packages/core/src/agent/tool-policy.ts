/**
 * 线程级工具策略（D8：Home 只读 + 调度，不直接改项目文件）
 *
 * 为什么要在内核层硬拦，而不是只靠提示词：
 * 提示词是「请求」，工具表是「能力」。只靠提示词 = 迟早会写。
 * 这里做的是**能力裁剪** —— Home 线程根本拿不到写类工具。
 */
import type { Tool } from "../tools/types.ts";

/** 会改动文件系统 / 产生副作用的工具 */
export const MUTATING_TOOLS = new Set([
  "Write", "Edit", "Delete", "Bash", "KillShell",
  "GenerateImage", "GeneratePPT", "QuickEdit",
]);

/** Home 线程额外允许的工具（调度能力） */
export const HOME_EXTRA_TOOLS = new Set(["DispatchToProject"]);

/** 任何线程都必须有的元工具 */
const ALWAYS = new Set(["AttemptCompletion", "AskUserQuestion", "TodoWrite", "ToolSearch", "Skill"]);

export interface PolicyResult {
  tools: Map<string, Tool>;
  /** 被裁掉的工具名（用于告知模型，避免它以为能力不存在） */
  blocked: string[];
  /** 这次裁剪的原因，用于日志与提示词措辞 */
  reason: "home" | "read-only" | "none";
}

export interface PolicyOptions {
  /**
   * 只读权威（T8.2）：用户显式要求「只看不改」时，**一切写入都被禁止** ——
   * 连报告、计划、临时脚本都不许落盘，结果回聊天。
   */
  readOnly?: boolean;
}

/**
 * 按线程类型裁剪工具集。
 * - project 线程：全部可用（除非 readOnly）
 * - home 线程：去掉所有写类工具，保留只读 + 记忆 + 元工具 + 调度
 * - readOnly（任意线程）：连 home 都保留的能力里，凡是有副作用的也去掉
 */
export function applyThreadPolicy(
  kind: "home" | "project", tools: Map<string, Tool>, opts: PolicyOptions = {},
): PolicyResult {
  if (kind !== "home" && !opts.readOnly) return { tools, blocked: [], reason: "none" };

  const allowed = new Map<string, Tool>();
  const blocked: string[] = [];
  // 只读模式更严：连 AskUserQuestion / TodoWrite 之外有副作用的都去掉
  const readOnlyBlocked = new Set([...MUTATING_TOOLS, "DispatchToProject", "Task"]);
  const deny = opts.readOnly ? readOnlyBlocked : MUTATING_TOOLS;

  for (const [name, tool] of tools) {
    if (ALWAYS.has(name) || !deny.has(name)) allowed.set(name, tool);
    else blocked.push(name);
  }
  return { tools: allowed, blocked, reason: opts.readOnly ? "read-only" : "home" };
}

/** 给模型的提示：告诉它哪些能力被裁掉了，以及应该怎么绕 */
export function renderPolicyNotice(
  kind: "home" | "project", blocked: string[], projectIds: string[], reason: PolicyResult["reason"] = "home",
): string {
  if (blocked.length === 0) return "";

  if (reason === "read-only") {
    return [
      "<system-reminder>",
      "用户这次要求的是**只读**：查清楚、说清楚，不要动任何东西。",
      `写类工具（${blocked.join("、")}）在你的工具表里**不存在**。`,
      "",
      "所以：",
      "- 结果直接写在回复里，**不要**生成报告文件、计划文件、副本或临时脚本（哪怕用户没明说，只读就是只读）。",
      "- 需要给用户看代码时，在回复里贴关键片段并指明 `文件:行号`。",
      "- 如果真的必须改点什么才能继续，**停下来问用户**，不要自作主张。",
      "</system-reminder>",
    ].join("\n");
  }

  if (kind !== "home") return "";
  return [
    "<system-reminder>",
    "你现在在 Home 线程 —— 这里是「调度台」，不是工作区。",
    `为了让「Home 不会误改项目」，写类工具（${blocked.join("、")}）在你的工具表里**不存在**。`,
    "",
    "所以：",
    "- 你可以读文件、查记忆、看版本、回答用户的问题。",
    "- 需要改代码/跑构建/生成图片时，**不要自己动手**，用 DispatchToProject 把活派到对应项目线程。",
    projectIds.length > 0 ? `- 当前可用项目：${projectIds.join("、")}` : "- 目前还没有项目，可以先用面板新建一个。",
    "</system-reminder>",
  ].join("\n");
}
