/**
 * 工具审批 → 老词表的翻译（单独一个文件：sse-compat.ts 顶到 400 行上限）。
 *
 * 这里放两件事：
 *  ① 审批请求的 ask_user 事件（带 `approval` 标记与「同意并记住」的**规则形状**）；
 *  ② 形状的计算 —— 必须和内核真正落库的那条规则**逐字一致**
 *     （见 core 的 tools/rule-pattern.ts:ruleFor；那边没导出，这里是它的镜像）。
 */
import type { AgentEvent } from "../../../core/src/agent/events.ts";
import type { Tool } from "../../../core/src/tools/types.ts";
import { humanDuration } from "../../../core/src/constants.ts";
import type { LegacyEvent, LegacyCtx } from "./sse-compat.ts";

/**
 * 「同意并记住」会落下的规则形状（如 `Bash(rm -rf /tmp/x)`）。
 *
 * ⚠️ 必须和 ruleFor 给出**同一个串**：面板拿它当「将记住什么」写给用户看，
 * 展示的和实际落库的只要不一致，安全语义就错了。
 * 纪律：算不出来就返回 undefined —— **绝不退回「整个工具放行」**。ruleFor 对
 * 没声明 approvalRule 的工具确实会退成整工具规则，但那种「记住 = 放行整个工具」
 * 不该从面板这个入口产生（文案没法说清，容易点错）。
 */
export function rememberedShape(
  tools: Map<string, Tool> | undefined, tool: string, input: Record<string, unknown>,
): string | undefined {
  const def = tools?.get(tool);
  if (!def?.approvalRule) return undefined;
  let arg: unknown;
  try { arg = def.approvalRule(input); } catch { arg = undefined; }
  return typeof arg === "string" && arg.trim() ? `${def.name}(${arg})` : undefined;
}

/**
 * tool_approval → ask_user（面板已有的「允许 / 拒绝」界面）。
 *
 * ⚠️ 这个分支以前**根本没有** —— 内核发 tool_approval，兼容层直接丢掉，
 *    前端就永远看不到确认框，于是**任何需要审批的工具都只能等超时被自动拒绝**。
 *    实测表现：用户看到「Bash 失败：[权限] 审批超时，命令已被自动拒绝」，而他压根没被问过。
 *
 * 回传走 /api/user-input（那边按 toolCallId 解析成审批决定），面板据此提交 remember。
 * approval / remember_rule 两个字段是给面板的：
 *   · approval=true 表示「这是审批，不是普通提问」——「同意并记住」只画在它上面；
 *   · remember_rule 是点「记住」将落下的规则形状；算不出来就没有这个字段，
 *     面板也就不给「记住」选项（宁可只让用户一次次点允许，也不给一个点了没用的假选项）。
 */
export function approvalAskEvents(e: AgentEvent, ctx: LegacyCtx): LegacyEvent[] {
  const toolCallId = String(e.toolCallId ?? "");
  // 形状从 tool_start 记下的那对 (工具, 入参) 算（两条事件共享同一个 toolCallId）
  const pending = ctx.toolCalls?.get(toolCallId);
  const shape = pending ? rememberedShape(ctx.tools, pending.tool, pending.input) : undefined;
  // 内核可以在请求的 metadata 里说「这条不给记住」（凭证类写目标：每次都要单独确认，见 core 的 credential-write 策略）
  const meta = (e.metadata ?? {}) as { noRemember?: boolean };
  return [{
    type: "ask_user",
    tool_use_id: toolCallId,
    question: [
      String(e.title ?? "需要你的许可"),
      e.message ? String(e.message).slice(0, 600) : "",
      e.riskLevel ? `（风险等级：${e.riskLevel}）` : "",
      // 提前把等待上限说清楚（问题 ⑤）：用户离开工位前就知道不处理会自动拒绝，
      // 而不是回来只看到一句没头没尾的失败。
      typeof e.timeoutMs === "number" ? `（${humanDuration(e.timeoutMs)}内未处理将自动拒绝）` : "",
    ].filter(Boolean).join("\n\n"),
    suggestions: ["允许", "拒绝"],
    approval: true,
    remember_rule: meta.noRemember === true ? undefined : shape,
  }];
}
