/**
 * AutoCompact 摘要提示词（T2.6）
 * 目标：把早期对话压成结构化摘要，保留「继续干活必须知道的东西」——
 *       用户的目标与约束、已达成的决定、关键文件路径、未完成事项。
 */
import type { ChatMessage } from "../providers/types.ts";

/** 摘要器的 system 提示词（调用方把它作为 system 消息传给 summarizer） */
export const COMPACT_SYSTEM_PROMPT = [
  "You are a conversation compressor for a long-running agent session.",
  "Compress the transcript you are given into a structured summary that another instance of the same agent can",
  "continue working from. Write in the same language the conversation is mostly in.",
  "Never invent facts: if something was not decided or not verified, say so explicitly.",
].join("\n");

/** 摘要正文的骨架（缺失的项写「无」，不要省略小节） */
export const COMPACT_SUMMARY_SECTIONS = [
  "## 用户的目标与约束",
  "## 已达成的决定",
  "## 关键文件与路径",
  "## 已完成的事项",
  "## 未完成的事项 / 下一步",
  "## 已知的坑与失败尝试",
].join("\n");

/** 生成摘要请求正文（附在 transcript 前面） */
export function buildCompactPrompt(conversation: string, opts: { note?: string } = {}): string {
  const note = opts.note ? `${opts.note}\n\n` : "";
  return [
    `${note}把下面这段对话压缩成结构化摘要。要求：`,
    "- 保留：用户的目标与约束、已达成的决定、关键文件路径（原样保留路径字符串）、未完成事项。",
    "- 保留：用户明确表达过的偏好与禁忌；不要保留寒暄、重复的确认、失败的探索细节。",
    "- 工具调用只保留「做了什么 + 结论」，不要保留原始输出；被截断的结果只留存档路径。",
    "- 不要编造：转录里没有的结论不要写；不确定的写「未确认」。",
    "- 用转录的主要语言写，控制在 800 字以内。",
    "",
    "输出严格按以下小节（没有内容的小节写「无」）：",
    COMPACT_SUMMARY_SECTIONS,
    "",
    "=== TRANSCRIPT START ===",
    conversation,
    "=== TRANSCRIPT END ===",
  ].join("\n");
}

/** 把消息渲染成纯文本转录，总量不超过 maxChars（超了就砍中段并标注） */
export function renderConversationForSummary(msgs: ChatMessage[], maxChars = 40_000): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const role = m.role === "tool" ? `tool(${m.name ?? "?"})` : m.role;
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content)
      ? m.content.map((b) => (b.type === "text" ? b.text ?? "" : "[image]")).join(" ")
      : "";
    const calls = m.tool_calls && m.tool_calls.length > 0
      ? ` [calls: ${m.tool_calls.map((c) => `${c.function.name}(${clipMiddle(c.function.arguments, 200)})`).join(", ")}]`
      : "";
    lines.push(`<${role}> ${clipMiddle(text, 2000)}${calls}`);
  }
  return clipMiddle(lines.join("\n"), maxChars);
}

/** 掐中段：头和尾都保留，中间标记省略了多少字符 */
export function clipMiddle(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.6);
  const tail = Math.max(0, maxChars - head);
  return `${text.slice(0, head)}\n…（省略 ${text.length - maxChars} 字符）…\n${tail > 0 ? text.slice(text.length - tail) : ""}`;
}
