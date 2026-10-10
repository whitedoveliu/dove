/**
 * ListMcpResources —— 列出 MCP 服务器提供的资源（resources/list + resources/templates/list）
 *
 * 没有 MCP server / 服务端没实现该能力（JSON-RPC -32601）都不是错误：
 * 返回 available=false 或逐服务器的 error 说明，模型据此判断「是没有，还是没接」。
 */
import { defineTool, S } from "../types.ts";
import { guarded, optStr } from "./util.ts";

export const ListMcpResourcesTool = defineTool({
  name: "ListMcpResources",
  discoverable: "列出 MCP 服务器暴露的**资源**与资源模板（外部数据源，如文件、数据库记录）",
  description: [
    "列出 MCP 服务器提供的资源（resources）和资源模板（resource templates）。",
    "资源是 MCP 侧的**只读外部数据**：拿到 uri 之后用 ReadMcpResource 读内容。",
    "",
    "返回里每个服务器一条结果：",
    "- ok=true → resources / templates 列表；",
    "- ok=false → 明确原因。服务端没实现该能力时会说明（JSON-RPC -32601），那不代表出错。",
    "没配置任何 MCP 服务器时返回 servers=[]，也不是错误。",
  ].join("\n"),
  parameters: S.obj({
    server: S.str("只看某个 MCP 服务器（省略 = 全部已连接服务器）"),
  }, []),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const port = ctx.services?.mcp;
    if (!port) {
      return {
        available: false, servers: [], resources: [], templates: [],
        error: "MCP_UNAVAILABLE",
        note: "这个进程里没有接入 MCP（ctx.services.mcp 为空）—— 没有外部资源可列，不代表资源不存在。",
      };
    }
    const server = optStr(input, "server");
    const all = port.servers();
    if (all.length === 0) {
      return {
        available: true, servers: [], resources: [], templates: [],
        note: "没有配置任何 MCP 服务器（配置文件里 servers 为空）。可以在设置里加一个，再回来列资源。",
      };
    }
    const listings = await port.list(server);
    const resources = listings.flatMap((l) => (l.resources ?? []).map((r) => ({ server: l.server, ...r })));
    const templates = listings.flatMap((l) => (l.templates ?? []).map((t) => ({ server: l.server, ...t })));
    const failed = listings.filter((l) => !l.ok);
    // 「模板拿不到」等**局部**降级说明也要传给模型：否则「没有模板」和「不支持模板」看起来一样
    const notes = listings.filter((l) => !!l.note).map((l) => ({ server: l.server, note: l.note }));
    return {
      available: true,
      servers: all.map((s) => ({ name: s.name, connected: s.connected, enabled: s.enabled, error: s.error })),
      resourceCount: resources.length,
      templateCount: templates.length,
      resources,
      templates,
      failures: failed.map((l) => ({ server: l.server, error: l.error, note: l.note })),
      notes,
      note: resources.length === 0 && templates.length === 0
        ? "没有列到任何资源。看 failures 里的原因（未实现 / 未连接 / 没有资源）。"
        : "资源用 uri 读取：ReadMcpResource(uri)。模板里的 {占位符} 要替换成实际值。",
    };
  }),
});
