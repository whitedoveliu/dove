#!/usr/bin/env node
/** D7 硬约束①：单文件 ≤ 400 行 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MAX = 400;
const SKIP = new Set(["node_modules", ".git", "dist", ".data", "fixtures"]);
const EXT = new Set([".ts", ".tsx", ".mjs", ".js"]);

const offenders = [];
function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e) || e.startsWith(".")) continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) { walk(full); continue; }
    if (!EXT.has(extname(e))) continue;
    const lines = readFileSync(full, "utf8").split("\n").length;
    if (lines > MAX) offenders.push({ file: full.replace(ROOT, ""), lines });
  }
}
walk(ROOT.replace(/\/$/, ""));

if (offenders.length) {
  console.error("✗ 有文件超过 " + MAX + " 行：");
  for (const o of offenders) console.error(`   ${o.lines} 行  ${o.file}`);
  process.exit(1);
}
console.log("✓ 文件大小检查通过（全部 ≤ " + MAX + " 行）");
