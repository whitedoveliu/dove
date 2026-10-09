#!/usr/bin/env node
/**
 * D7 硬约束②：依赖方向单向
 * server → loop → {context, tools, memory, agents, projects} → session → providers
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("../packages/core/src", import.meta.url).pathname.replace(/\/$/, "");
// security 与 media 是最底层：任何层都可以用它们，它们不依赖任何业务层
// （media 只依赖 node: 内置模块与 swiftc 产物）
// embedding 是可选叶子层（整个仓库唯一带 npm 依赖的包，刻意隔离）；core 只认接口
const ORDER = ["security", "media", "docs", "embedding", "providers", "session", "tools", "memory", "context", "activity", "projects", "loop", "agent"];
const SKIP = new Set(["node_modules", ".git"]);

function layerOf(path) {
  const m = /packages\/core\/src\/([^/]+)\//.exec(path);
  return m ? m[1] : null;
}

const violations = [];
function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (extname(e) !== ".ts") continue;
    const from = layerOf(full);
    if (!from) continue;
    const src = readFileSync(full, "utf8");
    for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
      const target = m[1];
      if (!target.includes("core/src/")) continue;
      const to = layerOf(target.replace(/\.ts$/, ""));
      if (!to || to === from) continue;
      const fi = ORDER.indexOf(from), ti = ORDER.indexOf(to);
      if (fi >= 0 && ti >= 0 && ti > fi) {
        violations.push(`${full.replace(ROOT, "")}  (${from}) → ${to}  —— 下层不能依赖上层`);
      }
    }
  }
}
walk(ROOT);

if (violations.length) {
  console.error("✗ 依赖方向违规：");
  for (const v of violations) console.error("   " + v);
  process.exit(1);
}
console.log("✓ 依赖方向检查通过");
