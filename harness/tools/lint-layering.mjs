#!/usr/bin/env node
/**
 * D7 硬约束②：依赖方向单向
 * server → loop → {context, tools, memory, agents, projects} → session → providers
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname, dirname, resolve as resolvePath } from "node:path";

const ROOT = new URL("../packages/core/src", import.meta.url).pathname.replace(/\/$/, "");
// security 与 media 是最底层：任何层都可以用它们，它们不依赖任何业务层
// （media 只依赖 node: 内置模块与 swiftc 产物）
// embedding 是可选叶子层（整个仓库唯一带 npm 依赖的包，刻意隔离）；core 只认接口
const ORDER = ["security", "media", "docs", "embedding", "providers", "session", "tools", "memory", "context", "projects", "loop", "agents", "agent"];
const SKIP = new Set(["node_modules", ".git"]);

function layerOf(path) {
  const m = /packages\/core\/src\/([^/]+)\//.exec(path);
  return m ? m[1] : null;
}

const violations = [];
const checked = [];
/** 静态 import 与动态 import() 都要看 */
const SPECIFIER_RE = /(?:from|import)\s*\(?\s*"([^"]+)"/g;

/**
 * 把 import 说明符解析成「层」。
 *
 * ⚠️ 这里以前只认 `target.includes("core/src/")` —— 而本仓库**全部**用相对路径
 *    （`from "../session/store.ts"`），于是这个检查一个依赖都没看过，
 *    常年「通过」但实际是空的。相对路径必须按当前文件所在目录解析成绝对路径再判层。
 */
function layerOfSpecifier(fromFile, spec) {
  let abs;
  if (spec.includes("core/src/")) abs = spec;
  else if (spec.startsWith(".")) abs = resolvePath(dirname(fromFile), spec);
  else return null; // 裸包名（node: / npm 依赖）不参与分层判定
  return layerOf(abs.replace(/\.ts$/, ""));
}

walk(ROOT);

function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (extname(e) !== ".ts") continue;
    const from = layerOf(full);
    if (!from) continue;
    const src = readFileSync(full, "utf8");
    for (const m of src.matchAll(SPECIFIER_RE)) {
      const to = layerOfSpecifier(full, m[1]);
      if (!to) continue;
      checked.push(1);
      if (to === from) continue;
      const fi = ORDER.indexOf(from), ti = ORDER.indexOf(to);
      if (fi >= 0 && ti >= 0 && ti > fi) {
        violations.push(`${full.replace(ROOT, "")}  (${from}) → ${to}  —— 下层不能依赖上层`);
      }
    }
  }
}

if (violations.length) {
  console.error("✗ 依赖方向违规：");
  for (const v of violations) console.error("   " + v);
  process.exit(1);
}
console.log(`✓ 依赖方向检查通过（本次解析了 ${checked.length} 条跨文件 import —— 为 0 说明检查又变成空转了）`);
