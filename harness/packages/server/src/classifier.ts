/**
 * 审批分类器（auto 模式用）
 *
 * 让模型判断一条 shell 命令有没有副作用：
 *   返回 null            = 安全，放行
 *   返回 ApprovalRequest = 要审批
 *
 * ⚠️ 这个函数以前**根本没实现** —— `classifier` 只在 AgentServices 的类型里声明过，
 *    runtime 没转发、bootstrap 没提供，于是 `deps.classifier` 恒为 undefined。
 *    而当时 tool-exec 的写法是「没有分类器就放行」，
 *    结果 auto 模式**表面说「每次调用前审一遍」、实际是全部放行**，且毫无提示。
 *    两处都修了：这里是补实现，tool-exec 改成了 fail-safe（没分类器就要权限）。
 *
 * 纪律：**拿不准一律 RISK**，分类器自己炸了也要权限。宁可多问，不可漏放。
 */
import type { Provider } from "../../core/src/providers/types.ts";
import { buildApprovalRequest } from "../../core/src/tools/approval.ts";
import type { ApprovalRequest } from "../../core/src/tools/types.ts";

/** 分类器的提示词。要求只输出一个词，方便解析 */
function buildPrompt(cmd: string): string {
  return [
    "你要判断一条 shell 命令有没有副作用。只回答一个词。",
    "",
    "命令：",
    cmd.slice(0, 800),
    "",
    "有副作用（会改文件、装东西、发网络请求、动 git 历史、杀进程）回答 RISK，",
    "纯粹读取（ls/cat/grep/git status/date 之类）回答 SAFE。",
    "拿不准就回答 RISK。只输出 RISK 或 SAFE。",
  ].join("\n");
}

export function makeClassifier(provider: Provider): (cmd: string) => Promise<ApprovalRequest | null> {
  return async (cmd: string) => {
    try {
      const r = await provider.stream({
        model: "deepseek-flash",
        messages: [{ role: "user", content: buildPrompt(cmd) }],
        tools: [],
        toolChoice: "none",
        maxTokens: 8,          // 只要一个词，省 token 也省时间
      });
      if (r.error) return buildApprovalRequest(cmd, "medium");
      // 只认明确的 SAFE；其余（含空输出）一律按风险处理
      return /^\s*SAFE\s*$/i.test(r.text) ? null : buildApprovalRequest(cmd, "medium");
    } catch {
      // 分类器不可用 → **保守要权限**（fail-safe），绝不放行
      return buildApprovalRequest(cmd, "medium");
    }
  };
}
