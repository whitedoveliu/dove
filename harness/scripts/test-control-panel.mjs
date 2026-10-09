#!/usr/bin/env node
/**
 * 真机测试 **control-panel**（用户要保留的那个界面）跑在新内核上。
 *
 * 链路：control-panel(dist) → http://127.0.0.1:8008（兼容层）→ TS 内核 → 模型 → SSE 回界面
 *
 * 零依赖：Node 25 自带 WebSocket；静态服务用内置 http。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { join, extname } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 用相对位置推导 —— 硬编码 /Users/... 会暴露作者的用户名，别人克隆下来也跑不了
const PANEL_DIR = resolve(import.meta.dirname, "../../../control-panel/dist");
const STATIC_PORT = 3055;
const CDP_PORT = 9600 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "dove-cp-"));

let pass = 0, fail = 0; const failures = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log("  ✓ " + n); } else { fail++; failures.push(n + (d ? " — " + d : "")); console.log("  ✗ " + n + (d ? " — " + d : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 静态服务 control-panel/dist ─────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".map": "application/json" };
const staticSrv = createServer(async (req, res) => {
  try {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    const file = join(PANEL_DIR, p === "/" ? "index.html" : decodeURIComponent(p));
    const target = existsSync(file) ? file : join(PANEL_DIR, "index.html");
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => staticSrv.listen(STATIC_PORT, "127.0.0.1", r));
console.log("0) control-panel 静态服务: http://127.0.0.1:" + STATIC_PORT);

// ── Chrome ──────────────────────────────────────────────
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--remote-debugging-port=" + CDP_PORT, "--user-data-dir=" + profile,
  "--window-size=1680,1050", `http://127.0.0.1:${STATIC_PORT}/`,
], { stdio: ["ignore", "pipe", "pipe"] });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const pg = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (pg) { wsUrl = pg.webSocketDebuggerUrl; break; }
  } catch { /* wait */ }
}
if (!wsUrl) { console.error("✗ CDP 连不上"); chrome.kill(); staticSrv.close(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const pageErrors = []; const netFails = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params?.exceptionDetails?.exception?.description ?? "exception");
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") pageErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "));
  if (m.method === "Network.loadingFailed") netFails.push(m.params?.errorText ?? "fail");
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(method + " 超时")); } }, 30_000);
});
await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面 JS 抛错: " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
};

console.log("1) 等界面挂载");
await send("Page.navigate", { url: `http://127.0.0.1:${STATIC_PORT}/` });
await sleep(4000);
let mounted = false;
for (let i = 0; i < 24; i++) {
  // 阈值别定太高：control-panel 空态本身文字就不多（~75 字）
  mounted = await evalJs("document.body.innerText.length > 40 && !!document.querySelector('button, textarea, input')");
  if (mounted) break;
  await sleep(500);
}
const bodyText = await evalJs("document.body.innerText.slice(0,600)");
check("control-panel 挂载", mounted, bodyText.slice(0, 120).replace(/\n/g, " / "));

console.log("2) 建一个任务（走兼容层 8008）");
const created = await evalJs(`(async () => {
  const r = await fetch("http://127.0.0.1:8008/api/projects/create", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ name: "界面联调" })
  });
  return await r.json();
})()`);
check("兼容层能建项目", created?.success === true, JSON.stringify(created).slice(0, 140));
const PORT_ID = created?.project?.port;
check("拿到 port 形式的项目 id", !!PORT_ID, String(PORT_ID));

console.log("3) 直接打 /api/chat，看 SSE 事件（这是界面真正走的那条）");
const sse = await evalJs(`(async () => {
  const res = await fetch("http://127.0.0.1:8008/api/chat", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ project_id: "${PORT_ID}", message: "只回复两个字：你好" })
  });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", events = [], text = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\\n"); buf = lines.pop() || "";
    for (const l of lines) {
      if (!l.startsWith("data: ")) continue;
      try { const e = JSON.parse(l.slice(6)); events.push(e.type); if (e.type === "text") text += e.content; } catch {}
    }
  }
  return { events, text, uniq: [...new Set(events)] };
})()`);
console.log("   事件序列:", JSON.stringify(sse.uniq));
check("收到 session_id", sse.uniq.includes("session_id"), JSON.stringify(sse.uniq));
check("收到 text", sse.uniq.includes("text"));
check("收到 done", sse.uniq.includes("done"), JSON.stringify(sse.uniq));
check("回复内容正确", /你好/.test(sse.text), JSON.stringify(sse.text).slice(0, 80));
check("没有 error 事件", !sse.uniq.includes("error"), JSON.stringify(sse.uniq));

console.log("4) 界面能列出这个项目吗");
const listed = await evalJs(`(async () => {
  const r = await fetch("http://127.0.0.1:8008/api/projects");
  const j = await r.json();
  return j.projects.map(p => p.name);
})()`);
check("projects 里有「界面联调」", Array.isArray(listed) && listed.includes("界面联调"), JSON.stringify(listed));

console.log("5) 历史能读回来吗");
const hist = await evalJs(`(async () => {
  const r = await fetch("http://127.0.0.1:8008/api/history?project_id=${PORT_ID}");
  const j = await r.json();
  return { n: j.history.length, firstUser: j.history[0]?.user ?? null, evTypes: [...new Set((j.history[0]?.events ?? []).map(e => e.type))] };
})()`);
check("history 有 1 轮", hist.n === 1, JSON.stringify(hist));
check("history 里带回用户消息", hist.firstUser === "只回复两个字：你好", JSON.stringify(hist.firstUser));

check("页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log("6) 截图存证");
try {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/control-panel-live.png", Buffer.from(shot.data, "base64"));
  console.log("   已存 /tmp/control-panel-live.png");
} catch (e) { console.log("   截图失败:", e.message); }

console.log();
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log("失败："); for (const f of failures) console.log("  - " + f); }
ws.close(); chrome.kill("SIGKILL"); staticSrv.close();
await sleep(400);
process.exit(fail === 0 ? 0 : 1);
