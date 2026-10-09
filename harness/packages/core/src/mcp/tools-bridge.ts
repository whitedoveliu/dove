/**
 * MCP 工具 → Dove Tool 桥（T3.12）
 *
 * 命名：mcp__<server>__<tool>（**只用字母数字下划线**，不用冒号 —— 有些 provider 对工具名有字符限制）。
 * 顺序：同一 server 的工具按名字排序后输出，保证前后两次注册的**前缀一致**（前缀缓存友好）。
 * 纪律：execute 一律走 guarded()，错误变结构化结果；外部工具可能有副作用 → approval: heuristic。
 */
import { createHash } from "node:crypto";
import { defineTool } from "../tools/types.ts";
import type { Tool } from "../tools/types.ts";
import { normalizeParameters } from "../tools/normalize.ts";
import { errMsg, guarded } from "../tools/builtin/util.ts";
import type { McpCallResult, McpClient, McpContentPart, McpToolDef } from "./client.ts";

export const MCP_TOOL_PREFIX = "mcp__";
export const MCP_NAME_SEP = "__";
/** provider 侧工具名普遍有 64 字符上限 */
export const MCP_NAME_MAX = 64;
/** 单次 tools/call 的超时；比工具自身 timeoutMs 略小，好让错误先变成结构化结果 */
export const MCP_TOOL_TIMEOUT_MS = 120_000;

/** 段名清洗：非 [A-Za-z0-9_] 一律换成下划线（只换不合并，避免 a-b / a_b 撞名） */
export function sanitizeSegment(raw: string): string {
  const s = String(raw ?? "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return s || "unnamed";
}

/** mcp__<server>__<tool>；超长时截断 + 6 位内容哈希（同名必同结果，稳定） */
export function mcpToolName(server: string, tool: string): string {
  const full = MCP_TOOL_PREFIX + sanitizeSegment(server) + MCP_NAME_SEP + sanitizeSegment(tool);
  if (full.length <= MCP_NAME_MAX) return full;
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 6);
  return full.slice(0, MCP_NAME_MAX - hash.length - 1) + "_" + hash;
}

/** 描述前面加一行来源标记，让模型知道这是外部工具 */
export function describeMcpTool(server: string, def: McpToolDef): string {
  const head = "[MCP:" + server + "]";
  const body = typeof def.description === "string" && def.description.trim()
    ? def.description.trim()
    : "MCP 工具 " + def.name + "（服务端未提供描述）";
  return head + " " + body;
}

/** content 数组 → 单段文本：text 原样拼，非文本类型给出可读占位 */
export function flattenContent(parts: McpContentPart[] | undefined): string {
  const out: string[] = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (p.type === "text" && typeof p.text === "string") { out.push(p.text); continue; }
    if (p.type === "image") { out.push("[image " + String(p.mimeType ?? "unknown") + "]（本 host 不转存图片）"); continue; }
    if (p.type === "audio") { out.push("[audio " + String(p.mimeType ?? "unknown") + "]"); continue; }
    if (p.type === "resource") { out.push("[resource " + String((p as { resource?: { uri?: string } }).resource?.uri ?? "?") + "]"); continue; }
    out.push("[" + String(p.type ?? "unknown") + " 内容]");
  }
  return out.join("\n").trim();
}

/** 单个 MCP 工具 → Dove Tool */
export function bridgeTool(server: string, client: McpClient, def: McpToolDef): Tool {
  const doveName = mcpToolName(server, def.name);
  return defineTool({
    name: doveName,
    description: describeMcpTool(server, def),
    parameters: normalizeParameters(def.inputSchema),
    outputTier: "compact",
    // 外部工具可能有副作用，本 host 看不到它的实现 → 交给审批启发式
    approval: "heuristic",
    concurrencySafe: false,
    // 比内层 tools/call 超时多一点，先让 MCP 侧超时变成结构化错误
    timeoutMs: MCP_TOOL_TIMEOUT_MS + 5_000,
    execute: (input, ctx) => guarded(async () => {
      const started = Date.now();
      // MCP 的 tools/call 只能按超时收场（协议里没有取消请求）；ctx.signal 仅用于外部工具超时兜底
      void ctx;
      let res: McpCallResult;
      try {
        res = await client.callTool(def.name, input ?? {}, MCP_TOOL_TIMEOUT_MS);
      } catch (e) {
        return {
          server, tool: def.name, mcp_tool: doveName,
          error: "调用 MCP 工具失败：" + errMsg(e),
          duration_ms: Date.now() - started,
        };
      }
      const text = flattenContent(res.content);
      const base = { server, tool: def.name, mcp_tool: doveName, duration_ms: Date.now() - started };
      if (res.isError === true) {
        return { ...base, isError: true, error: text || "MCP 工具返回 isError=true（无内容）" };
      }
      return {
        ...base,
        content: text,
        ...(res.structuredContent === undefined ? {} : { structured: res.structuredContent }),
      };
    }),
  });
}

/**
 * 一批 MCP 工具 → Dove Tool[]。
 * 顺序：按工具名排序（**稳定**）；清洗后撞名的只保留第一个。
 */
export function bridgeTools(server: string, client: McpClient, defs: McpToolDef[]): Tool[] {
  const sorted = [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set<string>();
  const out: Tool[] = [];
  for (const def of sorted) {
    const name = mcpToolName(server, def.name);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(bridgeTool(server, client, def));
  }
  return out;
}
