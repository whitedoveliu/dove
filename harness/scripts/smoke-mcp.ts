/**
 * MCP host（T3.12）自测 —— 验收脚本
 * 运行：cd harness && node --no-warnings scripts/smoke-mcp.ts
 *
 * 被测对象是 scripts/mcp-fixture-server.mjs（自己写的最小 MCP server，零依赖）。
 * 覆盖：
 *   1. McpManager 连上夹具 → tools/list 拿到 2 个工具
 *   2. 桥接出来的 Dove Tool 能被调用且返回正确结果
 *   3. 工具名符合 mcp__<server>__<tool> 规范
 *   4. server 崩溃 / 命令不存在 → 明确报错且不影响其他功能
 *   5. ping 正常
 *   6. 断开后工具从列表里消失
 *   另加：注册表尾部接线（前缀缓存）、cursor 分页、协议版本协商、热重载、超时。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager, MCP_PROTOCOL_VERSION, connectMcp, mcpToolName } from "../packages/core/src/mcp/index.ts";
import type { Tool, ToolContext } from "../packages/core/src/tools/types.ts";
import { allTools, externalTools, getTool, registerExternalTools } from "../packages/core/src/tools/index.ts";
import { initMcp, makeMcpPort, syncMcpTools } from "../packages/server/src/mcp-wiring.ts";
import { handleServiceRoutes } from "../packages/server/src/routes-services.ts";
import type { Services } from "../packages/server/src/bootstrap.ts";

const FIXTURE = fileURLToPath(new URL("./mcp-fixture-server.mjs", import.meta.url));
const NODE = process.execPath;
const TMP = mkdtempSync(join(tmpdir(), "dove-mcp-smoke-"));
const CONFIG = join(TMP, "mcp.json");
const GHOST = join(TMP, "根本没有这个-mcp-命令");

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
}
function section(title: string): void { console.log("\n=== " + title + " ==="); }
function writeConfig(servers: Record<string, unknown>): void {
  writeFileSync(CONFIG, JSON.stringify({ servers }, null, 2), "utf8");
}
function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (fn()) { resolve(true); return; }
      if (Date.now() - t0 > timeoutMs) { resolve(false); return; }
      setTimeout(tick, 40);
    };
    tick();
  });
}

/** 日志出口：只收集 warn/error，保持自测输出干净 */
const logs: string[] = [];
const logger = (level: "info" | "warn" | "error", msg: string): void => { if (level !== "info") logs.push(level + " " + msg); };

const ctx: ToolContext = {
  toolCallId: "smoke-mcp", threadId: "smoke-mcp", workdir: process.cwd(), outputsDir: TMP,
  emit: () => { /* 自测不关心事件 */ },
  requestApproval: async () => ({ approved: true, decision: "allow" }),
  services: {},
};

// ── 夹具配置：正常 / 分页 / 带崩溃工具 / 命令不存在 ──────────
writeConfig({
  echo: { command: NODE, args: [FIXTURE], env: { MCP_FIXTURE_GREETING: "hi" } },
  paged: { command: NODE, args: [FIXTURE, "--paged"] },
  crashy: { command: NODE, args: [FIXTURE, "--extra-tools"] },
  ghost: { command: GHOST },
});

// 运行时工具表：bootstrap 里就是这样一个 Map（顺序 = 上 wire 顺序）
const toolsMap = new Map<string, Tool>();
const builtinNames = allTools().map((t) => t.name);
for (const t of allTools()) toolsMap.set(t.name, t);

const manager = new McpManager({
  configDir: TMP,
  logger,
  onToolsChanged: (list) => syncMcpTools(toolsMap, list),
});

// ── 1. 配置加载 ──────────────────────────────────────────
section("1. 配置加载（<configDir>/mcp.json）");
await manager.load();
check("配置路径 = <configDir>/mcp.json", manager.configPath === CONFIG, manager.configPath);
let list = manager.listServers();
check("读到 4 个 server", list.length === 4, list.map((s) => s.name).join(", "));
check("连接前 connected=false / toolCount=0", list.every((s) => !s.connected && s.toolCount === 0));

// ── 2. 连接 + 握手 + tools/list（含 cursor 分页） ─────────
section("2. 连接（initialize 握手）与 tools/list");
const conn = await manager.connectAll();
check("echo / paged / crashy 全部连上", ["echo", "paged", "crashy"].every((n) => conn.connected.includes(n)), conn.connected.join(", "));
check("ghost（命令不存在）连接失败但不抛出", conn.failed.some((f) => f.name === "ghost"), conn.failed.map((f) => f.name + ": " + f.error).join(" | "));

const echoConn = await manager.connect("echo");
check("验收 1：tools/list 拿到 2 个工具", echoConn.ok && echoConn.tools.length === 2, echoConn.tools.join(", "));
check("重复 connect 幂等（不重复起进程）", echoConn.tools.join(",") === (await manager.connect("echo")).tools.join(","));
const pagedConn = await manager.connect("paged");
check("分页：cursor 翻页后同样拿到 2 个工具", pagedConn.tools.length === 2, pagedConn.tools.join(", "));

const echoEntry = manager.listServers().find((s) => s.name === "echo");
const ghostEntry = manager.listServers().find((s) => s.name === "ghost");
check("listServers 状态正确（connected / toolCount）", echoEntry?.connected === true && echoEntry?.toolCount === 2, JSON.stringify(echoEntry));
check("验收 4：命令不存在 → 明确报错", !ghostEntry?.connected && /启动失败|ENOENT|no such file/i.test(ghostEntry?.error ?? ""), (ghostEntry?.error ?? "(无 error)").slice(0, 140));
check("验收 4：一个 server 失败不影响其他（2+2+4=8 个工具在表）", manager.tools().length === 8, manager.tools().length + " 个");

// ── 3. 桥接出来的 Dove Tool ──────────────────────────────
section("3. 桥接：MCP 工具 → Dove Tool");
const allNames = manager.tools().map((t) => t.name);
check("验收 3：工具名符合 mcp__<server>__<tool>", allNames.every((n) => /^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/.test(n)), allNames.join(", "));
check("验收 3：不含冒号等非法字符", allNames.every((n) => !n.includes(":") && !n.includes("-")));
const echoTools = manager.tools().filter((t) => t.name.startsWith("mcp__echo__")).map((t) => t.name);
check("同一 server 工具按名字排序（前缀稳定）", echoTools.join(",") === "mcp__echo__add,mcp__echo__echo", echoTools.join(","));
const longName = mcpToolName("server-" + "x".repeat(80), "tool" + "y".repeat(80));
check("超长工具名截断到 64 且稳定", longName.length <= 64 && longName === mcpToolName("server-" + "x".repeat(80), "tool" + "y".repeat(80)), longName);

const addTool = getTool("mcp__echo__add");
const echoTool = getTool("mcp__echo__echo");
check("description 带 [MCP:<server>] 前缀", addTool?.description.startsWith("[MCP:echo] ") === true, (addTool?.description ?? "").slice(0, 60));
check("outputTier=compact / approval=heuristic / concurrencySafe=false",
  addTool?.outputTier === "compact" && addTool?.approval === "heuristic" && addTool?.concurrencySafe === false,
  [addTool?.outputTier, addTool?.approval, String(addTool?.concurrencySafe)].join(" / "));
const params = addTool?.parameters as { type?: string; properties?: Record<string, unknown> } | undefined;
check("inputSchema 过 normalize（object + properties）", params?.type === "object" && !!params?.properties?.a && !!params?.properties?.b, JSON.stringify(params).slice(0, 100));

const rEcho = await echoTool!.execute({ text: "dove" }, ctx);
check("验收 2：调用桥接工具返回正确结果", String(rEcho.content ?? "") === "echo:dove hi", JSON.stringify(rEcho.content));
check("env 透传给子进程", String(rEcho.content ?? "").includes("hi"));
const rAdd = await addTool!.execute({ a: 2, b: 3 }, ctx);
check("验收 2：add(2,3) = 5", String(rAdd.content ?? "") === "sum=5", JSON.stringify(rAdd.content));
check("structuredContent 透传", JSON.stringify(rAdd.structured ?? null) === JSON.stringify({ sum: 5 }), JSON.stringify(rAdd.structured));
check("结果里带来源信息（server/tool/duration_ms）", rAdd.server === "echo" && rAdd.tool === "add" && typeof rAdd.duration_ms === "number");
const rFail = await getTool("mcp__crashy__fail")!.execute({}, ctx);
check("isError=true → 结构化 error", rFail.isError === true && String(rFail.error ?? "").includes("boom"), JSON.stringify(rFail.error));

// ── 4. 注册表接线（尾部追加，保护前缀缓存） ───────────────
section("4. 注册表接线：allTools() 尾部追加");
const nowNames = allTools().map((t) => t.name);
check("内置工具顺序一字未动（前缀缓存）", nowNames.slice(0, builtinNames.length).join(",") === builtinNames.join(","));
check("MCP 工具全部追加在尾部", nowNames.slice(builtinNames.length).join(",") === allNames.join(","), nowNames.slice(builtinNames.length).join(","));
check("externalTools() 与 manager.tools() 一致", externalTools().map((t) => t.name).join(",") === allNames.join(","));
check("getTool() 能命中 MCP 工具", !!getTool("mcp__echo__echo"));
check("运行时工具表与注册表同序（= wire 顺序）", [...toolsMap.keys()].join(",") === nowNames.join(","));
const fakeRead: Tool = { ...addTool!, name: "Read" };
registerExternalTools([fakeRead, addTool!]);
check("与内置重名的外部工具被丢弃（内置优先）", externalTools().length === 1 && externalTools()[0]?.name === "mcp__echo__add");
syncMcpTools(toolsMap, manager.tools());
check("重新同步后 MCP 工具回到尾部", [...toolsMap.keys()].join(",") === nowNames.join(","));

// ── 5. ping / 资源接口 / 协议版本协商 ─────────────────────
section("5. ping、资源接口与协议版本");
const direct = await connectMcp({ name: "echo-direct", command: NODE, args: [FIXTURE] }, { logger });
let pingOk = false;
try { await direct.ping(); pingOk = true; } catch { pingOk = false; }
check("验收 5：ping 正常", pingOk);
check("healthy() = true", (await direct.healthy()) === true);
check("协议版本 = " + MCP_PROTOCOL_VERSION, direct.protocolVersion === MCP_PROTOCOL_VERSION, direct.protocolVersion);
check("serverInfo / capabilities 解析", direct.serverInfo.name === "fixture" && typeof direct.capabilities.tools === "object", JSON.stringify(direct.serverInfo));
const first = await direct.listTools();
const second = await direct.listTools();
check("tools/list 有缓存、force 可刷新", first === second && (await direct.listTools(true)).length === 2);
const resources = await direct.listResources();
check("resources/list 可用", resources.length === 1 && resources[0]?.uri === "fixture://hello", JSON.stringify(resources));
const read = await direct.readResource("fixture://hello");
check("resources/read 可用", read.contents?.[0]?.text === "hello from fixture", JSON.stringify(read.contents));
direct.close();
check("close() 后 alive=false 且 healthy()=false", !direct.alive && (await direct.healthy()) === false);

const proto = await connectMcp({ name: "proto", command: NODE, args: [FIXTURE, "--protocol", "2025-03-26"] }, { logger });
check("服务端版本不同 → 以服务端为准", proto.protocolVersion === "2025-03-26", proto.protocolVersion);
check("版本不一致记了日志", logs.some((l) => l.includes("协议版本不一致")), logs.find((l) => l.includes("协议版本")) ?? "(无)");
proto.close();

// ── 6. 崩溃 / 超时 ───────────────────────────────────────
section("6. 崩溃与超时（明确报错 + 不影响其他功能）");
const crashTool = getTool("mcp__crashy__crash");
const rCrash = await crashTool!.execute({}, ctx);
check("验收 4：崩溃时返回结构化 error（不抛）", typeof rCrash.error === "string" && rCrash.error.length > 0, String(rCrash.error).slice(0, 140));
const gone = await waitFor(() => !getTool("mcp__crashy__crash") && manager.listServers().find((s) => s.name === "crashy")?.connected === false);
check("验收 4：崩溃后该 server 的工具从表里摘掉", gone, manager.listServers().find((s) => s.name === "crashy")?.error ?? "(无 error)");
check("验收 4：崩溃不影响其他 server", !!getTool("mcp__echo__echo") && !!getTool("mcp__paged__add"));
const rAlive = await getTool("mcp__echo__echo")!.execute({ text: "still-alive" }, ctx);
check("验收 4：其他 server 仍可正常调用", String(rAlive.content ?? "").includes("echo:still-alive"), JSON.stringify(rAlive.content));
check("stderr 有转发到日志", logs.some((l) => l.includes("[mcp:stderr]") || l.includes("连接中断")), logs.slice(-2).join(" / ").slice(0, 140));

let timeoutErr = "";
try {
  await connectMcp({ name: "hanger", command: NODE, args: [FIXTURE, "--hang"], timeoutMs: 400 }, { logger });
} catch (e) { timeoutErr = e instanceof Error ? e.message : String(e); }
check("握手超时 → 明确报错", /超时/.test(timeoutErr), timeoutErr.slice(0, 140));

// ── 7. 断开 / 热重载 ─────────────────────────────────────
section("7. 断开与热重载");
manager.disconnect("echo");
check("验收 6：断开后工具从列表里消失", !getTool("mcp__echo__echo") && manager.tools().every((t) => !t.name.startsWith("mcp__echo__")));
const echoAfter = manager.listServers().find((s) => s.name === "echo");
check("验收 6：listServers 反映断开状态", echoAfter?.connected === false && echoAfter?.toolCount === 0, JSON.stringify(echoAfter));
check("断开不影响其他 server", !!getTool("mcp__paged__add"));

writeConfig({
  echo: { command: NODE, args: [FIXTURE], env: { MCP_FIXTURE_GREETING: "yo" } },
  crashy: { command: NODE, args: [FIXTURE, "--extra-tools"] },
  ghost: { command: GHOST },
  reloaded: { command: NODE, args: [FIXTURE] },
});
const rl = await manager.reload();
check("reload 报告 added/removed/changed",
  rl.added.includes("reloaded") && rl.removed.includes("paged") && rl.changed.includes("echo"),
  JSON.stringify({ added: rl.added, removed: rl.removed, changed: rl.changed }));
check("reload：移除的 server 工具已消失", !getTool("mcp__paged__add"));
check("reload：新增的 server 工具已注册", !!getTool("mcp__reloaded__add"));
const rReloaded = await getTool("mcp__echo__echo")!.execute({ text: "x" }, ctx);
check("reload：配置变更的 server 用新 env 重连", String(rReloaded.content ?? "") === "echo:x yo", JSON.stringify(rReloaded.content));
check("reload：崩溃过的 server 不被自动重连（防崩溃循环）", manager.listServers().find((s) => s.name === "crashy")?.connected === false);
check("reload：内置工具顺序仍然未动", allTools().map((t) => t.name).slice(0, builtinNames.length).join(",") === builtinNames.join(","));

// ── 8. HTTP 路由接线 ─────────────────────────────────────
section("8. HTTP 路由接线（GET /api/mcp、reload、connect）");
const port = makeMcpPort(manager);
let last: { code: number; data: unknown } = { code: 0, data: null };
const json = (_res: unknown, code: number, data: unknown): void => { last = { code, data }; };
const readBody = async (): Promise<Record<string, unknown>> => ({});
const req = (method: string): never => ({ method } as never);
const svc = { mcp: port } as unknown as Services;

const handled = await handleServiceRoutes("/api/mcp", new URL("http://x/api/mcp"), req("GET"), {} as never, svc, json as never, readBody);
const status = last.data as { available?: boolean; servers?: { name: string }[]; toolCount?: number };
check("GET /api/mcp 返回服务器状态", handled && last.code === 200 && status.available === true && (status.servers?.length ?? 0) >= 3, JSON.stringify(status).slice(0, 130));
check("GET /api/mcp 带外部工具数", status.toolCount === manager.tools().length && status.toolCount > 0, String(status.toolCount));

await handleServiceRoutes("/api/mcp/reload", new URL("http://x/api/mcp/reload"), req("POST"), {} as never, svc, json as never, readBody);
const reloaded = last.data as { ok?: boolean; added?: string[]; removed?: string[] };
check("POST /api/mcp/reload 可用", reloaded.ok === true && Array.isArray(reloaded.added) && Array.isArray(reloaded.removed), JSON.stringify(reloaded).slice(0, 130));

await handleServiceRoutes("/api/mcp/ghost/connect", new URL("http://x/api/mcp/ghost/connect"), req("POST"), {} as never, svc, json as never, readBody);
check("POST /api/mcp/:name/connect 失败回 400 + 原因", last.code === 400 && (last.data as { ok?: boolean }).ok === false, JSON.stringify(last.data).slice(0, 110));

const noMcp = await handleServiceRoutes("/api/mcp", new URL("http://x/api/mcp"), req("GET"), {} as never, {} as Services, json as never, readBody);
check("MCP 未接入时优雅降级（available:false）", noMcp && (last.data as { available?: boolean }).available === false, JSON.stringify(last.data));
const other = await handleServiceRoutes("/api/emotion", new URL("http://x/api/emotion"), req("GET"), {} as never, {} as Services, json as never, readBody);
const miss = await handleServiceRoutes("/api/nope", new URL("http://x/api/nope"), req("GET"), {} as never, {} as Services, json as never, readBody);
check("路由分发不受影响（其他路由照旧 true / 未知 false）", other === true && miss === false);

// ── 9. 收尾 ──────────────────────────────────────────────
section("9. 收尾：close()");
manager.close();
check("close 后全部断开", manager.listServers().every((s) => !s.connected));
check("close 后外部工具清空", externalTools().length === 0 && !getTool("mcp__reloaded__add"));
check("close 后工具表只剩内置工具", [...toolsMap.keys()].join(",") === builtinNames.join(","));

// ── 10. bootstrap 接线（initMcp 全流程） ──────────────────
section("10. bootstrap 接线（initMcp 全流程）");
const CFG2 = join(TMP, "boot");
mkdirSync(CFG2, { recursive: true });
writeFileSync(join(CFG2, "mcp.json"), JSON.stringify({ servers: { boot: { command: NODE, args: [FIXTURE] } } }), "utf8");
const bootMap = new Map<string, Tool>();
for (const t of allTools()) bootMap.set(t.name, t);
const wiring = await initMcp({ configDir: CFG2, tools: bootMap });
check("initMcp 读配置 + 连接 + 工具进表", wiring.toolNames.length === 2 && wiring.manager.listServers()[0]?.connected === true, wiring.toolNames.join(", "));
check("initMcp 的工具同时进注册表与运行时表", !!getTool("mcp__boot__echo") && bootMap.has("mcp__boot__echo"));
check("initMcp 端口可读状态", wiring.port.toolCount() === 2 && wiring.port.listServers().length === 1, String(wiring.port.toolCount()));
const rBoot = await getTool("mcp__boot__echo")!.execute({ text: "boot" }, ctx);
check("initMcp 注册的工具可直接调用", String(rBoot.content ?? "").startsWith("echo:boot"), JSON.stringify(rBoot.content));
wiring.manager.close();
check("关闭后回到纯内置工具表", externalTools().length === 0 && !getTool("mcp__boot__echo") && [...bootMap.keys()].join(",") === builtinNames.join(","));

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log("\n结果：" + passed + " 通过 / " + failed + " 失败（warn/error 日志 " + logs.length + " 条）");
console.log(passed > 0 && failed === 0 ? "MCP host 全部验收项通过 ✅" : "存在失败项 ❌");
process.exit(failed > 0 ? 1 : 0);
