/**
 * 记忆切片注入模板（T2.4 / T4.5；答疑 p05 §1 原文）
 * 纪律：措辞照抄，尤其是最后那句 NOTE ——
 *       少了它，模型会把「检索到 5 条」当成「我知道全部了」。
 */

export interface MemorySlice {
  content: string;
  /** 记忆写入时刻（毫秒）；注意：不是事件发生时间 */
  createdAt: number;
  tags?: string[];
  /** "temporary" 会被标记为可能过期 */
  durability?: string;
}

/** 时间锚定规则段（原文照抄，不得改写） */
export const MEMORIES_TIME_ANCHOR_RULE = [
  "Preserve original message sent-at timestamps when reasoning about time. A relative date written inside a memory",
  "(\"today\", \"tomorrow\", \"yesterday\", \"next week\") refers to the moment that memory's original message was sent —",
  "never to the current time, and never to the memory's saved-at time. If the original message time is unknown, say so",
  "instead of inferring a date from saved-at.",
].join("\n");

/** 「这只是切片」的 NOTE（原文照抄，不可省） */
export const MEMORIES_SLICE_NOTE = [
  "NOTE: This is only the small subset of memories auto-retrieved for the current message — NOT your complete memory,",
  "and it may be missing something relevant. Don't rely on it alone: if you need something not covered here,",
  "don't assume it doesn't exist — search again with the Recall tool or ask the user.",
].join("\n");

/** 单条记忆行（照抄模板顺序：content [tags] (temporary) [Memory saved-at: …]） */
export function renderMemoryLine(mem: MemorySlice, index: number): string {
  const tags = mem.tags && mem.tags.length > 0 ? ` [${mem.tags.join(", ")}]` : "";
  const temp = mem.durability === "temporary" ? " (temporary)" : "";
  const iso = new Date(mem.createdAt).toISOString();
  const stamp = `[Memory saved-at: ${iso}; original message time/timezone unknown; saved-at is NOT event/due/completion time.]`;
  return `${index + 1}. ${mem.content.trim()}${tags}${temp} ${stamp}`;
}

/** 渲染 `## Relevant Memories` 块；无记忆时返回空串（M4 之前就是空实现） */
export function renderMemoriesBlock(mems: MemorySlice[]): string {
  const usable = (mems ?? []).filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0);
  if (usable.length === 0) return "";
  return [
    "## Relevant Memories",
    "The following are relevant memories from previous conversations:",
    "",
    MEMORIES_TIME_ANCHOR_RULE,
    "",
    ...usable.map((m, i) => renderMemoryLine(m, i)),
    "",
    'Use these memories to provide more personalized and contextual responses. Note: memories marked as "(temporary)" may be outdated.',
    "",
    MEMORIES_SLICE_NOTE,
  ].join("\n");
}
