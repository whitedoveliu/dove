#!/usr/bin/env node
/**
 * 零依赖「构建」：校验 HTML 引用的资源是否都存在、CSS 括号是否配平、JS 是否能解析。
 * 故意保留真实构建会报的错（缺失引用 / 语法错误）。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const errors = [];
const pages = ["index.html", "works.html", "contact.html", "about.html"];

function checkHtml(page) {
  const p = join(root, page);
  if (!existsSync(p)) { errors.push(`缺少页面：${page}`); return; }
  const html = readFileSync(p, "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  for (const r of refs) {
    if (r.startsWith("http") || r.startsWith("data:")) continue;
    const target = join(root, r);
    if (!existsSync(target)) errors.push(`${page} 引用了不存在的文件：${r}`);
  }
  // 检查 <script> 里引用的函数是否在 JS 里定义（模拟"引用了不存在的组件"）
  const scriptSrc = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  for (const s of scriptSrc) {
    const sp = join(root, s);
    if (!existsSync(sp)) continue;
    const js = readFileSync(sp, "utf8");
    const calls = [...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]);
    for (const c of calls) {
      if (!new RegExp(`(function\\s+${c}\\b|const\\s+${c}\\s*=|let\\s+${c}\\s*=|\\b${c}\\s*=\\s*\\()`).test(js)) {
        errors.push(`${page} 调用了未定义的函数：${c}()`);
      }
    }
  }
}

function checkCss() {
  const p = join(root, "styles", "main.css");
  if (!existsSync(p)) { errors.push("缺少 styles/main.css"); return; }
  const css = readFileSync(p, "utf8");
  const open = (css.match(/{/g) ?? []).length, close = (css.match(/}/g) ?? []).length;
  if (open !== close) errors.push(`styles/main.css 花括号不配平（{ ${open} 个，} ${close} 个）`);
  const vars = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const v of vars) if (!defined.has(v)) errors.push(`styles/main.css 使用了未定义的变量：${v}`);
}

function checkJs() {
  const files = ["scripts/main.js", "scripts/data.js"];
  for (const f of files) {
    const p = join(root, f);
    if (!existsSync(p)) { errors.push(`缺少 ${f}`); continue; }
    const src = readFileSync(p, "utf8");
    try { new Function(src); }
    catch (e) { errors.push(`${f} 语法错误：${e.message}`); }
  }
}

for (const page of pages) checkHtml(page);
checkCss();
checkJs();

if (errors.length > 0) {
  console.error("构建失败：");
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log("构建成功：4 个页面、样式与脚本均通过校验。");
