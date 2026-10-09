#!/usr/bin/env node
/**
 * 通过真实 HTTP + SSE 接口驱动一个任务 —— 这就是浏览器面板走的那条路。
 * 用法: node scripts/drive-http.mjs <任务文本>
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const BASE = "http://127.0.0.1:8790";
const args = process.argv.slice(2);
// 可选：--fixture <名字> 先把夹具复制进新建的项目目录
const fi = args.indexOf("--fixture");
const fixture = fi >= 0 ? args[fi + 1] : null;
const task = args.filter((a, i) => i !== fi && i !== fi + 1).join(" ") || "这个项目是干什么的？";
const WORKSPACE = process.env.DOVE_WORKSPACE ?? join(process.env.HOME ?? "/tmp", "DoveProjects");

async function post(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return r.json();
}

console.log("1) 健康检查:", JSON.stringify(await (await fetch(BASE + "/api/health")).json()));

console.log("2) 建项目…");
const proj = await post("/api/projects", { name: "HTTP 驱动测试" });
console.log("   ->", proj.id, proj.path);

if (fixture) {
  const src = resolve(import.meta.dirname, "../fixtures", fixture);
  if (!existsSync(src)) { console.error("夹具不存在:", src); process.exit(1); }
  cpSync(src, proj.path, { recursive: true });
  console.log("   夹具已复制:", fixture);
}

console.log("3) 建线程…");
const th = await post("/api/threads", { kind: "project", title: "HTTP 测试", projectId: proj.id });
console.log("   ->", th.id);

console.log("4) 发消息（SSE 流）…\n");
const res = await fetch(BASE + "/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ threadId: th.id, message: task, content: task, projectId: proj.id }),
});

if (!res.ok || !res.body) { console.error("✗ /api/chat 失败:", res.status, await res.text()); process.exit(1); }

const seen = new Map();
let gotText = "", sawApproval = false, sawDone = false, lastSeq = 0;
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("id:")) { const n = Number(line.slice(3)); if (Number.isFinite(n)) lastSeq = n; continue; }
    if (!line.startsWith("data:")) continue;
    let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
    seen.set(ev.type, (seen.get(ev.type) ?? 0) + 1);
    if (ev.type === "text") { gotText += ev.content ?? ""; process.stdout.write(ev.content ?? ""); }
    if (ev.type === "tool_start") console.log("\n   ⚙ " + ev.tool + " " + JSON.stringify(ev.input ?? {}).slice(0, 120));
    if (ev.type === "tool_approval") { sawApproval = true; console.log("\n   ⏸ 审批: " + ev.title); }
    if (ev.type === "done") sawDone = true;
    if (ev.type === "stats") console.log("\n   ━━ " + ev.steps + " 步 · cache " + (ev.usage?.cacheReadTokens ?? 0) + "/" + (ev.usage?.inputTokens ?? 0));
  }
}

console.log("\n\n=== 断言 ===");
const checks = [
  ["SSE 带 id: (断点续传)", lastSeq > 0],
  ["收到 done 事件", sawDone],
  ["收到 text 增量", gotText.length > 0],
  ["收到 tool_start/tool_result", (seen.get("tool_start") ?? 0) > 0 && (seen.get("tool_result") ?? 0) > 0],
  ["收到 stats", (seen.get("stats") ?? 0) > 0],
  ["文本有实际内容", gotText.length > 30],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? "  ✓ " : "  ✗ ") + name); if (!pass) ok = false; }
console.log("\n事件统计:", JSON.stringify([...seen.entries()]));

const msgs = await (await fetch(BASE + "/api/threads/" + th.id + "/messages")).json();
console.log("落库消息数:", msgs.length, "| parts:", msgs.map(m => (m.parts || []).length).join(","));
const hasToolPart = msgs.some(m => (m.parts || []).some(p => String(p.type).startsWith("tool-")));
console.log(hasToolPart ? "  ✓ 工具调用已落库为 parts" : "  ✗ 工具 part 未落库");

const logs = await (await fetch(BASE + "/api/logs?limit=20")).json();
console.log("事件日志文件:", logs.sessions?.[0] ?? "(无)", "| 记录", logs.records?.length ?? 0);

process.exit(ok && hasToolPart ? 0 : 1);
