/**
 * token 估算（T2.6；答疑 p03）
 * 算法：非 ASCII 段按 ceil(len/2)，其余按 ceil(len/4)。
 * 用途：压缩阈值、历史切分预算、wire 开销估算。只是估算，不追求精确。
 */
import type { ChatMessage, ContentBlock, ToolSchema } from "../providers/types.ts";

/** 每条消息的角色 / 分隔符开销 */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** 单个工具定义的结构开销 */
const TOOL_OVERHEAD_TOKENS = 8;
/** 一张图片的粗估开销（不做真实解码） */
const IMAGE_TOKENS = 800;

/** 文本 token 估算：按 ASCII / 非 ASCII 分段计算 */
export function estimateTextTokens(s: string): number {
  if (!s) return 0;
  let tokens = 0;
  let ascii = 0;
  let wide = 0;
  const flushAscii = (): void => { if (ascii > 0) { tokens += Math.ceil(ascii / 4); ascii = 0; } };
  const flushWide = (): void => { if (wide > 0) { tokens += Math.ceil(wide / 2); wide = 0; } };
  for (const ch of s) { // for...of 按码点遍历，代理对算一个字符
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) { flushWide(); ascii++; } else { flushAscii(); wide++; }
  }
  flushAscii();
  flushWide();
  return tokens;
}

/** content（字符串或 content block 数组）的 token 估算 */
export function estimateContentTokens(content: ChatMessage["content"]): number {
  if (!content) return 0;
  if (typeof content === "string") return estimateTextTokens(content);
  let total = 0;
  for (const block of content as ContentBlock[]) {
    if (block.type === "text") total += estimateTextTokens(block.text ?? "");
    else if (block.type === "image_url") total += IMAGE_TOKENS;
  }
  return total;
}

/** 一整段消息的 token 估算（含 tool_calls 的 JSON 体积） */
export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  let total = 0;
  for (const m of msgs) {
    total += MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(m.content);
    if (m.tool_calls && m.tool_calls.length > 0) {
      total += estimateTextTokens(JSON.stringify(m.tool_calls));
    }
    if (m.role === "tool" && m.name) total += estimateTextTokens(m.name);
  }
  return total;
}

/** 工具定义在 wire 上的 token 估算（压缩判据用） */
export function estimateToolDefsTokens(defs: ToolSchema[]): number {
  let total = 0;
  for (const d of defs) {
    total += TOOL_OVERHEAD_TOKENS;
    total += estimateTextTokens(d.function.name);
    total += estimateTextTokens(d.function.description);
    try {
      total += estimateTextTokens(JSON.stringify(d.function.parameters));
    } catch {
      // 循环引用等异常 schema：忽略参数体积
    }
  }
  return total;
}

/**
 * 保留最近 n 个「对话回合」时的起始下标。
 * 一个回合 = 一条 user 消息 + 其后直到下一条 user 消息之前的全部消息。
 * 注意：单位是回合，不是消息条数。
 */
export function keepRecentTurnsStart(msgs: ChatMessage[], n: number): number {
  if (n <= 0) return msgs.length;
  const userIdx: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.role === "user") userIdx.push(i);
  }
  if (userIdx.length <= n) return 0;
  return userIdx[userIdx.length - n]!;
}

/**
 * 安全切分点：startIdx 是候选切点（回合边界），budget 是「保留段 [切点, end) 的 token 预算」。
 * 预算够 → 返回 startIdx；预算不够 → 把切点向后移到下一个安全边界（多丢一点旧消息）。
 * 安全 = 不切断 assistant.tool_calls 与 role:"tool" 结果的配对，且切点落在 user 消息（回合边界）上。
 */
export function findSafeSplitPoint(msgs: ChatMessage[], startIdx: number, budget: number): number {
  const start = Math.max(0, Math.min(startIdx, msgs.length));
  let acc = 0;
  let i = start;
  while (i < msgs.length && acc + estimateMessagesTokens([msgs[i]!]) <= budget) {
    acc += estimateMessagesTokens([msgs[i]!]);
    i++;
  }
  if (i >= msgs.length) return start; // 保留段整体装得下，不动切点
  let j = i;
  while (j < msgs.length && msgs[j]!.role !== "user") j++; // 切到回合边界
  while (j < msgs.length && msgs[j]!.role === "tool") j++; // 不留下孤儿 tool 结果
  return j >= msgs.length ? start : j;
}
