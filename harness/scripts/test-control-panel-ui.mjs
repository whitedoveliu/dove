#!/usr/bin/env node
/**
 * 最终验收：**在内核自己托管的 control-panel 里，真的打字、真的发出去**。
 *
 * 前面的 test-control-panel.mjs 验的是「界面能加载 + SSE 契约对」；
 * 这个脚本验的是**人真的用起来**：点任务 → 输入 → Enter → 看见流式回复。
 *
 * 零依赖 CDP。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL_BASE = process.env.DOVE_URL ?? "http://127.0.0.1:8790/";
const CDP = 9800 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(tmpdir(), "dove-ui-"));

let pass = 0, fail = 0; const failures = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log("  ✓ " + n); } else { fail++; failures.push(n + (d ? " — " + d : "")); console.log("  ✗ " + n + (d ? " — " + d : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--remote-debugging-port=" + CDP, "--user-data-dir=" + profile, "--window-size=1680,1050", URL_BASE],
  { stdio: ["ignore", "pipe", "pipe"] });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const p = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch {}
}
if (!wsUrl) { console.error("✗ CDP 连不上"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const errs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params?.exceptionDetails?.exception?.description ?? "ex");
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(method)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(method + " 超时")); } }, 30_000);
});
await send("Runtime.enable"); await send("Page.enable");
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面抛错: " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
};

console.log("1) 打开内核托管的 control-panel: " + URL_BASE);
await sleep(4000);
for (let i = 0; i < 24; i++) { if (await ev("document.body.innerText.length > 40")) break; await sleep(500); }
const title = await ev("document.title");
check("标题是 control-panel", /Dove/.test(title), title);

console.log("2) 建任务并用 localStorage 进入（界面自己恢复项目就是这么走的）");
const made = await ev(`(async () => {
  const r = await fetch("http://127.0.0.1:8008/api/projects/create", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ name: "UI 实打实" })
  });
  return (await r.json()).project.port;
})()`);
check("建任务成功 port=" + made, !!made);

// App.tsx 的 initProject 就是读 localStorage.dove_port 恢复项目的
await ev(`localStorage.setItem("dove_port", ${JSON.stringify(String(made))}); "ok"`);
await send("Page.navigate", { url: URL_BASE });
await sleep(4000);
for (let i = 0; i < 20; i++) {
  if (await ev("!!document.querySelector('textarea')")) break;
  await sleep(500);
}
const inChat = await ev("document.body.innerText.includes('UI 实打实') || !!document.querySelector('textarea')");
check("已进入该任务的对话界面", inChat);

console.log("3) 在输入框里打字并回车");
const QUESTION = "只回复四个字：收到了吗";
const typed = await ev(`(() => {
  const el = document.querySelector('textarea') || document.querySelector('input[type=text]');
  if (!el) return "no-input";
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(QUESTION)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  return el.value;
})()`);
check("文字进了输入框", typed === QUESTION, String(typed).slice(0, 50));

// 走 Enter —— 界面提示就是「按 Enter 开始 / Enter 发送」。
// （别去猜哪个图标按钮是发送：实测会点到回形针，反而发不出去）
const sent = await ev(`(() => {
  const el = document.querySelector('textarea') || document.querySelector('input[type=text]');
  if (!el) return { how: "no-input" };
  el.focus();
  const o = { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true };
  el.dispatchEvent(new KeyboardEvent('keydown', o));
  el.dispatchEvent(new KeyboardEvent('keypress', o));
  el.dispatchEvent(new KeyboardEvent('keyup', o));
  return { how: "enter", value: el.value };
})()`);
check("触发了发送（Enter）", sent.how === "enter", JSON.stringify(sent));
await sleep(3000);

console.log("4) 等界面出现回复");
// ⚠️ 别用「文本长度增长 N 字符」当判据 —— "你好" 只加 5 个字符，阈值一大就误判失败。
//    直接找 AI 那段回复的正文。
const EXPECT = /收到了吗|收到/;
let tail = "", userIdSeen = false, aiSeen = false;
for (let i = 0; i < 100; i++) {
  await sleep(1000);
  const st = await ev(`(() => {
    const t = document.body.innerText;
    return { tail: t.slice(-900), hasUser: t.includes(${JSON.stringify(QUESTION.slice(0, 5))}) };
  })()`);
  tail = st.tail; userIdSeen = userIdSeen || st.hasUser;
  // AI 回复 = 出现在 "AI Agent" 之后的那段
  aiSeen = /AI Agent[\s\S]{0,400}?(收到了吗|收到)/.test(tail) || /收到了吗|收到/.test(tail.replace(/只回复四个字：?收到了吗/g, ""));
  if (aiSeen) break;
}
check("用户消息渲染在界面上", userIdSeen);
check("界面出现 AI 回复且内容正确", aiSeen, tail.slice(-160).replace(/\n/g, " ⏎ "));
check("回复带时间戳（历史/实时渲染正常）", /\d{2}:\d{2}:\d{2}/.test(tail), tail.slice(-80).replace(/\n/g, " ⏎ "));
check("无未捕获异常", errs.length === 0, errs.slice(0, 2).join(" | "));

console.log("5) 截图");
try {
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync("/tmp/control-panel-chat.png", Buffer.from(s.data, "base64"));
  console.log("   已存 /tmp/control-panel-chat.png");
} catch (e) { console.log("   失败:", e.message); }

console.log();
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log("失败："); for (const f of failures) console.log("  - " + f); }
ws.close(); chrome.kill("SIGKILL"); await sleep(400);
process.exit(fail === 0 ? 0 : 1);
