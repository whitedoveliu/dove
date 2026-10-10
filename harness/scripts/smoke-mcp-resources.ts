/**
 * MCP 资源链路端到端（P0）—— 验收脚本
 * 运行：cd harness && node --no-warnings scripts/smoke-mcp-resources.ts
 *
 * 为什么单独一个脚本：MCP 资源（resources/list、resources/read、resources/templates/list）
 * 要穿过 **bootstrap → AgentServices.mcp → runtime 转发 → wire.ts → ToolServices.mcp → 工具**
 * 五段。任何一段断了都不会报错，只是工具永远说「MCP 未接入」——
 * 所以这里用**真实的 MCP server**（scripts/mcp-fixture-server.mjs）从头跑到尾。
 */
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库/配置指到临时目录
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { finish } from "./_lifecycle.ts";
import { buildExecDeps } from "../packages/core/src/agent/wire.ts";
import { getTool } from "../packages/core/src/tools/index.ts";
import type { ToolContext } from "../packages/core/src/tools/types.ts";

const FIXTURE = fileURLToPath(new URL("./mcp-fixture-server.mjs", import.meta.url));

let pass = 0, fail = 0;
function check(name: string, ok: boolean, note = ""): void {
  if (ok) { pass++; console.log("  PASS  " + name + (note ? "   [" + note + "]" : "")); }
  else { fail++; console.log("  FAIL  " + name + (note ? "   [" + note + "]" : "")); }
}

const cfg = loadConfig();
mkdirSync(cfg.configDir, { recursive: true });
writeFileSync(
  join(cfg.configDir, "mcp.json"),
  JSON.stringify({ servers: { fixture: { command: process.execPath, args: [FIXTURE] } } }),
  "utf8",
);

console.log("=== 1. bootstrap（真实 MCP 客户端 + cron 调度器） ===");
const svc = await bootstrap(cfg);
check("bootstrap 后 runtime.services.mcp 已注入（第①、②处接线）", !!svc.runtime.services.mcp);
check("bootstrap 后 runtime.services.cron 已注入", !!svc.runtime.services.cron);
check("工具表里有 ListMcpResources / ReadMcpResource", !!svc.tools.get("ListMcpResources") && !!svc.tools.get("ReadMcpResource"));

// 用**真实的工具执行管线**（runtime 每轮就是这么造的），验证第③④处接线
const deps = buildExecDeps({
  runtime: { services: { pending: svc.pending, mcp: svc.runtime.services.mcp, cron: svc.runtime.services.cron } },
  sink: () => { /* 冒烟不关心事件 */ },
  threadId: "th_smoke_mcp", workdir: process.cwd(), outputsDir: join(process.cwd(), "outputs"),
  onApprovalNeeded: () => { /* 不审批 */ },
});
const ctx: ToolContext = {
  ...deps.ctxBase, toolCallId: "smoke-mcp-res",
  requestApproval: async () => ({ approved: true, decision: "allow" }),
};

console.log("=== 2. ListMcpResources（resources/list + resources/templates/list） ===");
const listOut = await getTool("ListMcpResources")!.execute({}, ctx);
check("走真实 MCP 客户端，没报 MCP_UNAVAILABLE", listOut.error === undefined, JSON.stringify(listOut.error ?? ""));
check("列到 fixture://hello", JSON.stringify(listOut.resources ?? []).includes("fixture://hello"), JSON.stringify(listOut.resources ?? []).slice(0, 160));
const notes = (listOut.notes as { note?: string }[] | undefined) ?? [];
check("没实现 resources/templates/list 时给出可读说明（-32601）",
  notes.some((n) => /32601|没有实现/.test(String(n.note))), JSON.stringify(notes).slice(0, 160));

console.log("=== 3. ReadMcpResource（resources/read） ===");
const readOut = await getTool("ReadMcpResource")!.execute({ uri: "fixture://hello" }, ctx);
const text = JSON.stringify(readOut.contents ?? []);
check("读到真实内容", text.includes("hello from fixture"), text.slice(0, 160));
const badServer = await getTool("ReadMcpResource")!.execute({ uri: "fixture://hello", server: "并没有这个服务器" }, ctx);
check("指定了不存在的服务器 → 结构化错误 + 可用服务器列表",
  typeof badServer.error === "string" && JSON.stringify(badServer.configured ?? []).includes("fixture"),
  JSON.stringify(badServer.error));

console.log("=== 4. 顺手验证 cron 工具走的是 bootstrap 的调度器 ===");
const cronList = await getTool("CronList")!.execute({}, ctx);
check("CronList 未报 CRON_UNAVAILABLE", cronList.error === undefined);
check("给出了时区", typeof cronList.timezone === "string", String(cronList.timezone));
const created = await getTool("CronCreate")!.execute({ name: "冒烟一次性", type: "at", schedule: "1h", prompt: "只回一句话" }, ctx);
check("CronCreate 真落库", created.ok === true, JSON.stringify(created.id ?? created.error));
const deleted = await getTool("CronDelete")!.execute({ id: String(created.id) }, ctx);
check("CronDelete 真删掉", deleted.ok === true);
check("删完再看列表已经没了", !JSON.stringify((await getTool("CronList")!.execute({}, ctx)).jobs ?? []).includes(String(created.id)));

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
console.log(fail === 0 ? "MCP 资源 + cron 接线全部通过 ✅" : "存在失败项 ❌");
finish(svc, fail === 0 ? 0 : 1);
