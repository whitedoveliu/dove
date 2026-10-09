#!/usr/bin/env node
/**
 * 最小 MCP server（自测夹具，T3.12）
 *
 * 零依赖、stdio + newline-delimited JSON-RPC 2.0，用来当 Dove MCP host 的被测对象。
 * 默认暴露 2 个工具：echo / add。
 *
 * 开关（命令行）：
 *   --paged        tools/list 每次只回 1 个工具并带 nextCursor（测分页）
 *   --extra-tools  多暴露 crash（调用即 exit(3)）和 fail（返回 isError=true）
 *   --hang         收到任何请求都不回复（测超时）
 *   --protocol X   initialize 返回的 protocolVersion（测版本协商）
 *   --name X       serverInfo.name
 * 环境变量：
 *   MCP_FIXTURE_GREETING  echo 的返回值会带上它（测 env 透传）
 *
 * ⚠️ stdout 只允许出现 JSON-RPC 帧；调试信息一律走 stderr。
 */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flagValue = (f, def) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const PAGED = has("--paged");
const EXTRA_TOOLS = has("--extra-tools");
const HANG = has("--hang");
const PROTOCOL = flagValue("--protocol", "2024-11-05");
const SERVER_NAME = flagValue("--name", "fixture");

const TOOLS = [
  {
    name: "echo",
    description: "回显输入文本（自测用）",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "两数相加（自测用）",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];
if (EXTRA_TOOLS) {
  TOOLS.push({ name: "crash", description: "让本进程立刻退出（自测崩溃路径）", inputSchema: { type: "object", properties: {} } });
  TOOLS.push({ name: "fail", description: "返回 isError=true（自测错误内容）", inputSchema: { type: "object", properties: {} } });
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

process.stderr.write("[fixture] 启动 name=" + SERVER_NAME + " paged=" + String(PAGED) + " extra=" + String(EXTRA_TOOLS) + "\n");

function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false }, resources: {} },
      serverInfo: { name: SERVER_NAME, version: "0.0.1" },
      instructions: "Dove 自测夹具；只用于验证 MCP host。",
    });
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") return reply(id, {});

  if (method === "tools/list") {
    if (!PAGED) return reply(id, { tools: TOOLS });
    const cursor = params.cursor ? String(params.cursor) : "";
    const idx = cursor ? Number(cursor) : 0;
    const tool = TOOLS[idx];
    if (!tool) return reply(id, { tools: [] });
    const next = idx + 1 < TOOLS.length ? String(idx + 1) : undefined;
    return reply(id, next ? { tools: [tool], nextCursor: next } : { tools: [tool] });
  }

  if (method === "tools/call") {
    const name = String(params.name || "");
    const args = params.arguments || {};
    if (name === "echo") {
      const greeting = process.env.MCP_FIXTURE_GREETING ? " " + process.env.MCP_FIXTURE_GREETING : "";
      return reply(id, { content: [{ type: "text", text: "echo:" + String(args.text === undefined ? "" : args.text) + greeting }] });
    }
    if (name === "add") {
      const sum = Number(args.a) + Number(args.b);
      return reply(id, { content: [{ type: "text", text: "sum=" + String(sum) }], structuredContent: { sum } });
    }
    if (name === "fail") {
      return reply(id, { content: [{ type: "text", text: "夹具故意失败：boom" }], isError: true });
    }
    return reply(id, { content: [{ type: "text", text: "未知工具 " + name }], isError: true });
  }

  if (method === "resources/list") {
    return reply(id, { resources: [{ uri: "fixture://hello", name: "hello", mimeType: "text/plain" }] });
  }
  if (method === "resources/read") {
    return reply(id, { contents: [{ uri: String(params.uri || ""), mimeType: "text/plain", text: "hello from fixture" }] });
  }
  if (id !== undefined && id !== null) replyError(id, -32601, "Method not found: " + String(method));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (!line) continue;
    if (HANG) continue;                       // 故意装死：由客户端超时收场
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg && msg.method === "tools/call" && msg.params && msg.params.name === "crash") {
      process.stderr.write("[fixture] crash 工具被调用，进程退出\n");
      process.exit(3);
    }
    try { handle(msg || {}); } catch (e) { process.stderr.write("[fixture] 处理失败：" + String(e) + "\n"); }
  }
});
process.stdin.on("end", () => process.exit(0));
