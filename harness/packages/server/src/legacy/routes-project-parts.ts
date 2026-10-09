/**
 * 历史消息 → 老契约 events 的转换（从 routes-project.ts 抽出来，那边超 400 行了）
 *
 * ⚠️ 这里有个**实测踩过的坑**：原来每个工具调用都发一条
 *   { type: "tool_info", tool, info: tool + " 完成" }
 * 前端渲染是「工具名 + info」，于是聊天区显示成「WebSearch WebSearch 完成」——
 * 工具名重复，而且没有任何信息量。**加载一次历史就满屏这种行**。
 *
 * 而且注意：实时流那侧的批处理（sse-compat.ts 的 toolBurst）**管不到这里** ——
 * 历史是重新生成的。所以两边都要做，否则刷新页面又变回一屏工具行。
 */
import { join } from "node:path";
import { toolInfoLine } from "./sse-compat.ts";

/** "YYYY-MM-DD HH:MM:SS"（本地时间）—— 前端 new Date(str) 直接吃这个 */
export function localTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".json": "json",
  ".css": "css", ".html": "html", ".md": "markdown", ".py": "python", ".svg": "xml",
  ".yml": "yaml", ".yaml": "yaml", ".sh": "bash", ".sql": "sql",
};

export const HIDDEN = new Set(["node_modules", ".git", ".next", "dist", "out", "build", ".turbo",
  ".logs", ".preview-cache", "__pycache__", ".venv", "venv", ".DS_Store", ".cache", "coverage",
  ".pytest_cache", ".dove"]);

/** 历史里的一串工具（前端会把它们折叠成一个可展开的组） */
interface ToolGroup { items: { tool: string; info: string; failed: boolean }[] }

function flushGroup(g: ToolGroup | null, out: Record<string, unknown>[]): null {
  if (!g || g.items.length === 0) return null;
  // 每个工具都发一条 —— 同实时流：**数据层发全，展示交给视图层**。
  // 前端会把连续的工具行折叠成一个可展开的组。
  for (const item of g.items) {
    out.push({
      type: "tool_info",
      tool: item.tool,
      // ⚠️ info 必须是**参数**（查询词 / URL / 路径），**不能填工具名** ——
      //    前端渲染是「工具名 + formatToolInfo(info)」，
      //    填工具名会显示成「WebSearch WebSearch」。实测踩过。
      info: item.failed ? (item.info ? `${item.info}（失败）` : "失败") : item.info,
    });
  }
  return null;
}

/** 把内核消息 parts 压成老契约的 history events */
export function partsToEvents(m: { parts: unknown[] }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // 相邻 thinking 合并（前端实时流也是这么拼的）
  let lastThink: Record<string, unknown> | null = null;
  let group: ToolGroup | null = null;

  for (const raw of m.parts) {
    const p = raw as Record<string, unknown>;
    const t = String(p.type ?? "");

    if (t === "text") {
      group = flushGroup(group, out);            // 说话了 → 工具批次结束
      const c = String(p.text ?? "");
      if (c) out.push({ type: "text", content: c });
      continue;
    }
    if (t === "reasoning") {
      group = flushGroup(group, out);            // 思考了 → 同样结束
      const c = String(p.text ?? "");
      if (!c) continue;
      if (lastThink) lastThink.content = String(lastThink.content) + c;
      else { lastThink = { type: "thinking", content: c }; out.push(lastThink); }
      continue;
    }
    lastThink = null;
    if (!t.startsWith("tool-")) continue;

    const tool = String(p.toolName ?? t.slice(5));
    // ⚠️ 从 input 里抽参数当这行的说明 —— 历史 parts 里 input 是完整的
    //    （实测：{query:"..."} / {url:"..."}），不用白不用。
    const info = toolInfoLine((p.input ?? {}) as Record<string, unknown>);
    const failed = p.state === "output-error";
    group ??= { items: [] };
    group.items.push({ tool, info, failed });
    // 老契约里 ask_user 是「伪装成 tool_info」的，前缀 "question: " 少了前端就显示原始串
    if (tool === "AskUser" || tool === "ask_user") {
      group = flushGroup(group, out);
      out.push({ type: "tool_info", tool, info: `question: ${String(p.output ?? p.input ?? "").slice(0, 200)}` });
    }
  }
  flushGroup(group, out);
  return out;
}

/** 该轮有没有改文件（决定 is_modified —— 前端版本号的唯一来源） */
export function didModify(m: { parts: unknown[] }): boolean {
  for (const raw of m.parts) {
    const p = raw as Record<string, unknown>;
    const t = String(p.type ?? "");
    if (t === "tool-Write" || t === "tool-Edit") return true;
  }
  return false;
}

/** 老契约的文件树要相对路径 */
export function relPath(root: string, abs: string): string {
  return join(root, abs).replace(root + "/", "");
}
