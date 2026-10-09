#!/usr/bin/env node
/**
 * 真机 UI 测试：用 CDP 驱动无头 Chrome，在**真实面板**里发一条消息，
 * 验证流式回复、工具卡片、状态条都真的渲染出来。
 *
 * 这是之前缺的那块 —— 截图只能证明"页面画出来了"，
 * 证明不了"发消息 → 内核 → SSE → 界面更新"这条链路是通的。
 *
 * 零依赖：Node 25 自带 WebSocket；Chrome 用 --remote-debugging-port。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PANEL = process.env.PANEL_URL ?? "http://127.0.0.1:8790/";
const PORT = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "dove-cdp-"));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 起 Chrome ──────────────────────────────────────────
console.log("1) 启动无头 Chrome（CDP 端口 " + PORT + "）");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + profile,
  "--window-size=1600,1000",
  PANEL,
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => { chromeErr += d.toString(); });

// 等 CDP 起来
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { console.error("✗ 连不上 CDP。stderr:", chromeErr.slice(-400)); chrome.kill(); process.exit(1); }
console.log("   CDP 已就绪");

// ── CDP 会话 ───────────────────────────────────────────
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(m.params?.exceptionDetails?.exception?.description ?? "unknown exception");
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
    consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "));
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + " 超时")); } }, 30_000);
  });
}
await send("Runtime.enable");
await send("Page.enable");

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面 JS 抛错: " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
}

// ── 等 React 挂载 ──────────────────────────────────────
console.log("2) 等面板挂载");
await send("Page.navigate", { url: PANEL });
await sleep(3500);
let mounted = false;
for (let i = 0; i < 20; i++) {
  mounted = await evalJs("!!document.querySelector('textarea, input[type=text]') && document.querySelectorAll('*').length > 50");
  if (mounted) break;
  await sleep(500);
}
check("面板挂载（找到输入框）", mounted);

// ── 检查初始状态 ──────────────────────────────────────
console.log("3) 初始渲染");
const init = await evalJs(`(() => {
  const t = document.body.innerText;
  return {
    hasBrand: t.includes("DOVE") || t.includes("Dove"),
    hasHome: t.includes("Home") || t.includes("首页") || t.includes("会话"),
    tabs: Array.from(document.querySelectorAll('button,[role=tab]')).map(b => b.innerText.trim()).filter(Boolean),
    bodyLen: t.length,
  };
})()`);
check("侧栏渲染", init.hasBrand, JSON.stringify(init.tabs.slice(0, 8)));
check("页面有内容（非白屏）", init.bodyLen > 100, "innerText 长度 " + init.bodyLen);

// ── 发一条消息 ─────────────────────────────────────────
console.log("4) 在真实面板里发消息（走 SSE，会真的调模型）");
const QUESTION = "用一句话说明这个项目是干什么的，不要调用任何工具。";
const sent = await evalJs(`(() => {
  const el = document.querySelector('textarea') || document.querySelector('input[type=text]');
  if (!el) return "no-input";
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(QUESTION)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`);
check("消息写进输入框", sent === QUESTION, String(sent).slice(0, 40));

// 点发送按钮，或回车
const clicked = await evalJs(`(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const send = btns.find(b => /发送|Send|↑/i.test(b.innerText)) ;
  if (send) { send.click(); return "button:" + send.innerText.trim(); }
  const el = document.querySelector('textarea') || document.querySelector('input[type=text]');
  if (el) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return "enter";
  }
  return "nothing";
})()`);
check("触发发送", clicked !== "nothing", clicked);

// ── 等流式回复 ─────────────────────────────────────────
console.log("5) 等流式回复渲染（最多 120 秒）");
const before = await evalJs("document.body.innerText.length");
let grew = false, assistantText = "";
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const st = await evalJs(`(() => {
    const t = document.body.innerText;
    return { len: t.length, tail: t.slice(-1200) };
  })()`);
  if (st.len > before + 40) { grew = true; assistantText = st.tail; }
  // 回复出现且有一段时间没再增长 → 认为完成
  if (grew && i > 6) {
    const ok = /这个项目|作品集|林知夏|静态|站点|portfolio/i.test(st.tail);
    if (ok) { assistantText = st.tail; break; }
  }
}
check("界面出现流式回复（内容增长）", grew);
check("回复内容与项目相关", /作品集|林知夏|静态|站点|visual|portfolio|design/i.test(assistantText), assistantText.slice(-160).replace(/\n/g, " ⏎ "));

// ── 检查工具卡片 / 状态条 ──────────────────────────────
console.log("6) UI 细节");
const detail = await evalJs(`(() => {
  const t = document.body.innerText;
  return {
    hasUserMsg: t.includes(${JSON.stringify(QUESTION.slice(0, 12))}),
    hasStats: /↑|↓|⚡|时长|step|token/i.test(t),
    hasEmotion: t.includes("情绪"),
    hasFatigue: t.includes("疲劳"),
    hasActivity: t.includes("感知") || t.includes("快照"),
  };
})()`);
check("用户消息出现在界面上", detail.hasUserMsg);
check("状态条渲染（情绪/疲劳）", detail.hasEmotion && detail.hasFatigue, JSON.stringify(detail));
check("感知区块渲染", detail.hasActivity);
check("无未捕获的页面异常", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

// ── 收尾 ───────────────────────────────────────────────
console.log();
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log("失败："); for (const f of failures) console.log("  - " + f); }
ws.close();
chrome.kill("SIGKILL");
await sleep(500);
process.exit(fail === 0 ? 0 : 1);
