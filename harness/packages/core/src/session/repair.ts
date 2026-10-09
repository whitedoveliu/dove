/**
 * 崩溃修复（T0.5；借鉴 DSH repair.ts）
 * 核心纪律：未配对的 tool_call **绝不静默重放** ——
 * 给模型写一条「该动作结果未知，请先检查再决定」，把判断权交还模型。
 */
import type { Message } from "./types.ts";
import { isToolPart } from "./types.ts";
import { fixMessageStuckToolStates } from "./parts.ts";

export interface RepairFinding {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface RepairResult {
  findings: RepairFinding[];
  /** 注入到最后一条 user 消息前的交代文本（空串表示无需修复） */
  notice: string;
}

const WRITE_TOOLS = new Set([
  "Write", "Edit", "Delete", "Bash", "GeneratePPT", "GenerateVideo",
]);

/** 未完成的工具状态 = 执行结果未知 */
const DANGLING_STATES = new Set(["streaming", "input-available", "approval-requested"]);

/**
 * 找出「调用了但没有结果」的工具。
 * 注意：必须在 fixMessageStuckToolStates **之前**调用 ——
 * 后者会把 input-available 改成 output-error，那样就检测不出来了。
 */
export function findDanglingToolCalls(messages: Message[]): RepairFinding[] {
  const out: RepairFinding[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (!isToolPart(p)) continue;
      if (DANGLING_STATES.has(p.state ?? "")) {
        out.push({ toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
      }
    }
  }
  return out;
}

export function buildRepairNotice(findings: RepairFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((f, i) => {
    const risky = WRITE_TOOLS.has(f.toolName) ? "（**可能已经产生副作用**）" : "（只读，安全）";
    const arg = typeof f.input === "object" && f.input ? JSON.stringify(f.input).slice(0, 200) : String(f.input ?? "");
    return `${i + 1}. ${f.toolName} ${arg} ${risky}`;
  });
  return [
    "<system-reminder>",
    "上一轮生成被中断了。下面这些工具调用**没有拿到结果**，它们的执行状态是未知的：",
    "",
    ...lines,
    "",
    "处理要求：",
    "- 对标记为「可能已经产生副作用」的，**先检查实际状态**（读文件 / 查 git status / 看构建结果），再决定是否重做。",
    "- **不要直接重放**。重复执行可能造成数据损坏。",
    "- 检查完再继续用户的任务。",
    "</system-reminder>",
  ].join("\n");
}

export function repairMessages(messages: Message[]): RepairResult {
  // 顺序很重要：先检测，再修正状态
  const findings = findDanglingToolCalls(messages);
  for (const m of messages) fixMessageStuckToolStates(m);
  return { findings, notice: buildRepairNotice(findings) };
}
