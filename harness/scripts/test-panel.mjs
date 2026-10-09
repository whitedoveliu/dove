#!/usr/bin/env node
/**
 * 面板真机测试：用无头 Chrome 打开真实内核托管的面板，验证渲染与后端联通。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.PANEL_URL ?? "http://127.0.0.1:8790/";
const profile = mkdtempSync(join(tmpdir(), "dove-chrome-"));

function run(args) {
  return new Promise((res) => {
    const p = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => res({ code, out, err }));
  });
}

console.log("1) 无头 Chrome 打开面板…");
const r = await run([
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--user-data-dir=" + profile,
  "--virtual-time-budget=8000",
  "--dump-dom", URL,
]);
const dom = r.out;
console.log("   DOM 长度:", dom.length);

console.log("2) 断言…");
const checks = [
  ["React 已挂载（有 #root 内容）", /<div id="root">[\s\S]{200,}/.test(dom)],
  ["侧栏渲染出 DOVE", dom.includes("DOVE") || dom.includes("Dove")],
  ["渲染出会话/项目区域", dom.includes("会话") || dom.includes("项目") || dom.includes("侧栏")],
  ["输入框存在", /<textarea|<input/i.test(dom)],
  ["未出现白屏错误边界", !dom.includes("Something went wrong") && !dom.includes("Uncaught")],
  ["加载了打包产物", dom.includes("assets/index-")],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? "  ✓ " : "  ✗ ") + name); if (!pass) ok = false; }

if (!ok) {
  console.log("\n--- DOM 片段 ---");
  console.log(dom.slice(0, 1500));
}

console.log("3) 控制台错误…");
if (r.err.trim()) {
  const lines = r.err.split("\n").filter((l) => /error|Error|failed/i.test(l) && !/DevTools|GPU|Fontconfig|voice|Vulkan/i.test(l));
  console.log(lines.length ? lines.slice(0, 6).join("\n") : "  ✓ 无关键错误");
} else console.log("  ✓ 无 stderr 输出");

process.exit(ok ? 0 : 1);
