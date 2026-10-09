/**
 * parts → ChatMessage（T2.8）
 * 简化：这里按时间顺序取全部消息（activePath 分支裁剪由上层负责）。
 * 纪律：① 只发终态 part —— streaming 中的半截内容不许进历史；
 *       ② assistant.tool_calls 与 role:"tool" 结果必须成对出现，宁可用「结果未知」占位也不许断配。
 */
import type { ChatMessage, ContentBlock, ToolCallPayload } from "../providers/types.ts";
import type { FilePart, Message, Part, ToolPart } from "../session/types.ts";
import { isToolPart } from "../session/types.ts";

export interface ConvertOptions {
  /** 是否把 reasoning 也回传给模型（默认 false：浪费 token 且多数 provider 不接受） */
  includeReasoning?: boolean;
  /** 单个工具结果的字符上限；0 = 不限制（默认留一道保险，正常已由 budget.ts 裁过） */
  maxToolChars?: number;
  /** 图片重水化钩子：把文件路径换成可发送的 data URL；返回 undefined 则降级为文本指引 */
  resolveImageUrl?: (url: string, part: Part) => string | undefined;
}

const DEFAULT_MAX_TOOL_CHARS = 20_000;

/** 结果未知的占位文案（崩溃修复纪律：不静默重放，把判断权交还模型） */
export const UNKNOWN_TOOL_RESULT =
  "(结果未记录：这次调用没有拿到输出，执行状态未知 —— 需要时先检查实际状态再决定，不要直接重放)";

export function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function partText(part: Part): string {
  return part.type === "text" || part.type === "reasoning" ? (part as { text: string }).text : "";
}

/**
 * 组装单条消息的 content：
 * 只有纯文本时返回 string（缓存友好）；出现图片/文件时返回 ContentBlock[]。
 */
function buildContent(parts: Part[], opts: ConvertOptions): string | ContentBlock[] | null {
  const texts = parts
    .filter((p) => p.type === "text" || (opts.includeReasoning === true && p.type === "reasoning"))
    .map(partText)
    .filter((t) => t.trim().length > 0);
  const rich = parts.filter((p): p is FilePart => p.type === "image" || p.type === "file");
  const text = texts.join("\n\n");

  if (rich.length === 0) return text.length > 0 ? text : null;
  const blocks: ContentBlock[] = [];
  if (text.length > 0) blocks.push({ type: "text", text });
  for (const f of rich) {
    if (f.type === "image") {
      const resolved = opts.resolveImageUrl ? opts.resolveImageUrl(f.url, f) : undefined;
      if (resolved) blocks.push({ type: "image_url", image_url: { url: resolved } });
      else blocks.push({ type: "text", text: `[图片：${f.filename ?? f.url}（未水化，需要时读该文件）]` });
    } else {
      // ContentBlock 里没有文件块类型：一律降级为文本指引（需要内容就读文件）
      blocks.push({ type: "text", text: `[文件：${f.filename ?? f.url}（${f.mediaType}）—— 需要内容时用 Read 读取]` });
    }
  }
  return blocks;
}

export function stringifyToolOutput(part: ToolPart, maxChars = DEFAULT_MAX_TOOL_CHARS): string {
  const hasResult = part.output !== undefined || part.errorText !== undefined;
  let body = !hasResult
    ? UNKNOWN_TOOL_RESULT
    : part.errorText !== undefined
      ? `ERROR: ${part.errorText}`
      : safeJson(part.output);
  if (part.spillPath) body += `\n(完整输出已存档：${part.spillPath}；需要全文时读这个文件)`;
  if (maxChars > 0 && body.length > maxChars) {
    const head = body.slice(0, Math.floor(maxChars * 0.7));
    const tail = body.slice(-Math.floor(maxChars * 0.2));
    body = `${head}\n…（装配期截断，原始长度 ${body.length} 字符）…\n${tail}`;
  }
  return body;
}

function toToolCall(part: ToolPart): ToolCallPayload {
  return {
    id: part.toolCallId,
    type: "function",
    function: { name: part.toolName, arguments: safeJson(part.input ?? {}) },
  };
}

/** parts（按 activePath 顺序）→ provider 消息数组 */
export function convertMessages(messages: Message[], opts: ConvertOptions = {}): ChatMessage[] {
  const maxToolChars = opts.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS;
  const ordered = messages.slice().sort((a, b) => a.createdAt - b.createdAt); // sort 稳定，同刻保持原序
  const out: ChatMessage[] = [];

  for (const m of ordered) {
    const parts = m.parts.filter((p) => p.state !== "streaming"); // 过滤流式半成品
    if (parts.length === 0) continue;

    const toolParts = parts.filter(isToolPart);
    const content = buildContent(parts, opts);

    if (m.role === "system") {
      if (typeof content === "string" && content.length > 0) out.push({ role: "system", content });
      continue;
    }

    if (m.role === "user") {
      if (content !== null) out.push({ role: "user", content });
      continue;
    }

    // assistant：文本 + tool_calls（tool 结果紧跟其后，保持配对）
    const toolCalls = toolParts.map(toToolCall);
    if (content !== null || toolCalls.length > 0) {
      const msg: ChatMessage = { role: "assistant", content: content ?? null };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
    }
    for (const tp of toolParts) {
      out.push({ role: "tool", tool_call_id: tp.toolCallId, name: tp.toolName, content: stringifyToolOutput(tp, maxToolChars) });
    }
  }
  return out;
}

/** parts 里是否还有未到终态的 part（压缩切分守卫用） */
export function hasStreamingParts(messages: Message[]): boolean {
  return messages.some((m) => m.parts.some((p) => p.state === "streaming"));
}
