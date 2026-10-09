/**
 * parts 状态机（T0.4；答疑 p04）
 * 状态：streaming | input-available | output-available | output-error
 *       | approval-requested | approval-responded | permission-denied
 */
import type { Message, Part, ToolPart } from "./types.ts";
import { isToolPart } from "./types.ts";

export const PART_STATES = [
  "streaming", "input-available", "output-available", "output-error",
  "approval-requested", "approval-responded", "permission-denied",
] as const;

/** 合法流转表 */
const TRANSITIONS: Record<string, string[]> = {
  "streaming": ["streaming", "input-available", "output-available", "output-error"],
  "input-available": ["approval-requested", "output-available", "output-error", "permission-denied"],
  "approval-requested": ["approval-responded", "permission-denied"],
  "approval-responded": ["output-available", "output-error", "permission-denied"],
  "output-available": [],
  "output-error": [],
  "permission-denied": [],
};

export function canTransition(from: string | undefined, to: string): boolean {
  if (!from) return true;
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/** part 是否已到终态（压缩切分用，答疑 p03 §4.1） */
export function isTerminalPart(p: Part): boolean {
  if (p.type === "step-start") return true;
  if (!isToolPart(p)) return true;   // text / reasoning 视为终态
  return p.state === "output-available" || p.state === "output-error" || p.state === "permission-denied";
}

export function findToolPart(parts: Part[], toolCallId: string): ToolPart | undefined {
  return parts.find((p): p is ToolPart => isToolPart(p) && p.toolCallId === toolCallId);
}

/** 追加或合并文本增量 */
export function appendTextPart(parts: Part[], kind: "text" | "reasoning", delta: string): Part[] {
  const last = parts[parts.length - 1];
  if (last && last.type === kind) {
    (last as { text: string }).text += delta;
    return parts;
  }
  parts.push({ type: kind, text: delta, state: "streaming", id: `${kind}-${parts.length}` });
  return parts;
}

/** 中断 / 停机：所有未完成 part 落终态 */
export function markPartsStopped(parts: Part[], reason = "已中止"): Part[] {
  for (const p of parts) {
    if (p.type === "text" || p.type === "reasoning") { p.state = "output-available"; continue; }
    if (!isToolPart(p)) continue;
    if (p.state === "streaming" || p.state === "input-available" || p.state === "approval-requested") {
      p.state = "output-error";
      p.errorText = p.errorText ?? reason;
      p.finishedAt = p.finishedAt ?? Date.now();
    }
  }
  return parts;
}

/** 修复"卡住"的工具状态（进程重启后 / 生成结束后） */
export function fixMessageStuckToolStates(msg: Message, reason = "生成中断，状态未知"): boolean {
  let changed = false;
  for (const p of msg.parts) {
    if (!isToolPart(p)) continue;
    if (p.state === "streaming" || p.state === "input-available" || p.state === "approval-requested") {
      p.state = "output-error";
      p.errorText = p.errorText ?? reason;
      p.finishedAt = Date.now();
      changed = true;
    }
  }
  return changed;
}

/** 收集 assistant 消息里成对的工具调用 */
export function collectToolCalls(msgs: Message[]): { call: ToolPart; result?: ToolPart }[] {
  const map = new Map<string, { call: ToolPart; result?: ToolPart }>();
  for (const m of msgs) for (const p of m.parts) {
    if (!isToolPart(p)) continue;
    const e = map.get(p.toolCallId) ?? { call: p };
    if (p.state === "output-available" || p.state === "output-error" || p.state === "permission-denied") e.result = p;
    if (!map.has(p.toolCallId)) map.set(p.toolCallId, e);
  }
  return [...map.values()];
}
