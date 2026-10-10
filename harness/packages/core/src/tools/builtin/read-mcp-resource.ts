/**
 * ReadMcpResource —— 读取一个 MCP 资源（resources/read）
 * 纪律：blob 内容只报字节数（base64 塞进上下文既没用又贵）；失败返回结构化说明，不抛。
 */
import { defineTool, S } from "../types.ts";
import { guarded, str, optStr } from "./util.ts";

/** 单个资源内容的字符上限：超了截断并说明（正文可能几 MB） */
const MAX_TEXT_CHARS = 8_000;

export const ReadMcpResourceTool = defineTool({
  name: "ReadMcpResource",
  discoverable: "按 uri 读取 MCP 资源内容（resources/read）",
  description: [
    "按 uri 读取一个 MCP 资源的内容（先用 ListMcpResources 拿 uri）。",
    "",
    "- 不传 server 时会向所有已连接的服务器各试一次，返回每个服务器上的结果；",
    "- 文本内容超过 " + MAX_TEXT_CHARS + " 字符会截断并说明；二进制 blob 只报字节数（本 host 不转存）；",
    "- 服务器没实现该能力（-32601）/ uri 不存在 → 结构化错误说明，不会中断这一轮。",
  ].join("\n"),
  parameters: S.obj({
    uri: S.str("资源 uri（从 ListMcpResources 来；模板要先把占位符替换成实际值）"),
    server: S.str("指定 MCP 服务器（省略 = 所有已连接服务器都试）"),
  }, ["uri"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const uri = str(input, "uri");
    const port = ctx.services?.mcp;
    if (!port) {
      return {
        uri, available: false, error: "MCP_UNAVAILABLE",
        note: "这个进程里没有接入 MCP（ctx.services.mcp 为空），读不到任何外部资源。",
      };
    }
    const server = optStr(input, "server");
    const results = await port.read(uri, server);
    if (results.length === 0) {
      const names = port.servers().map((s) => s.name);
      return {
        uri, available: true, contents: [],
        error: server ? "找不到 MCP 服务器：" + server : "没有已连接的 MCP 服务器",
        configured: names,
        note: names.length > 0 ? "可用的服务器：" + names.join("、") + "（先看它们的连接状态）。" : "还没有配置 MCP 服务器。",
      };
    }
    const contents = results.flatMap((r) => (r.contents ?? []).map((c) => ({
      server: r.server,
      uri: c.uri ?? uri,
      mimeType: c.mimeType,
      text: typeof c.text === "string" && c.text.length > MAX_TEXT_CHARS
        ? c.text.slice(0, MAX_TEXT_CHARS) + "\n…（已截断，原文 " + c.text.length + " 字符）"
        : c.text,
      blobBytes: c.blobBytes,
      note: c.note,
    })));
    const failures = results.filter((r) => !r.ok).map((r) => ({ server: r.server, error: r.error, note: r.note }));
    return {
      uri,
      available: true,
      contentCount: contents.length,
      contents,
      failures,
      ok: contents.length > 0,
      note: contents.length > 0
        ? "以上是资源原文。"
        : "没有读到内容 —— 看 failures 里的原因（服务器未实现 / uri 不存在 / 未连接）。",
    };
  }),
});
