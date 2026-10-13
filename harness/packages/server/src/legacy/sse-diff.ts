/**
 * 新一轮净 diff → 老词表（单独一个文件：sse-compat.ts 顶到 400 行上限）。
 *
 * 覆盖面照抄 core/tools/turn-diff.ts：只有 Write/Edit **自报**的改动，
 * Bash 里的 `> f` / `sed -i` 看不见 —— 这是数据本身的边界，不是这一层的。
 */
import type { AgentEvent } from "../../../core/src/agent/events.ts";
import type { LegacyEvent } from "./sse-compat.ts";

/** turn_diff 里一个文件的增删统计（形状对齐 core/tools/turn-diff.ts 的 FileDiff） */
export interface LegacyTurnDiffFile {
  path: string;
  added: number;
  removed: number;
  created?: boolean;
  deleted?: boolean;
}

/**
 * 内核只在真有自报改动时才发这个事件，这里再挡一道：**files 空的帧直接丢掉** ——
 * 面板不该为「一轮只读」渲染一个空块。
 */
export function turnDiffEvents(e: AgentEvent): LegacyEvent[] {
  const rawFiles: unknown[] = Array.isArray(e.files) ? (e.files as unknown[]) : [];
  const files = rawFiles.flatMap((raw: unknown): LegacyTurnDiffFile[] => {
    if (!raw || typeof raw !== "object") return [];
    const f = raw as Record<string, unknown>;
    const path = String(f.path ?? "");
    if (!path) return [];   // 没有路径的条目没有意义（面板按路径展示）
    return [{
      path,
      added: Number(f.added ?? 0),
      removed: Number(f.removed ?? 0),
      created: f.created === true,
      deleted: f.deleted === true,
    }];
  });
  if (files.length === 0) return [];
  return [{
    type: "turn_diff",
    files,
    truncated: e.truncated === true,
    diff: typeof e.diff === "string" ? e.diff : "",
  }];
}
