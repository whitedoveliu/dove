/**
 * 兼容层「把路径交给系统打开」的准入守卫（packages/server/src/legacy/path-guard.ts）。
 *
 * 钉两件真事：
 *   ① `pickOpenRoot` 能在**多个允许根**里挑对 —— 设置里的「打开记忆文件夹」要开 `DOVE_CONFIG`
 *      （默认 `~/.dove`），它在工作区（`~/DoveProjects`）之外；只按工作区判会 403（实测过）。
 *   ② 挑根**不是放宽边界**：不在任何根里的路径照样拒，且 403/404 的顺序（先判越界、再判存在）
 *      不能反 —— 越界时连「存不存在」都不该告诉调用方。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardOpenTarget, pickOpenRoot } from "../../server/src/legacy/path-guard.ts";

function makeTree(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dove-guard-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("pickOpenRoot：配置目录里的路径挑配置根，工作区里的挑工作区根", () => {
  makeTree((dir) => {
    const cfg = join(dir, "cfg");
    const ws = join(dir, "ws");
    mkdirSync(cfg); mkdirSync(ws);
    writeFileSync(join(cfg, "SOUL.md"), "x");
    writeFileSync(join(ws, "a.txt"), "x");
    const roots = [cfg, ws];
    assert.equal(pickOpenRoot(roots, join(cfg, "SOUL.md"), ws), cfg, "配置目录里的文件 → 配置根");
    assert.equal(pickOpenRoot(roots, join(ws, "a.txt"), ws), ws, "工作区里的文件 → 工作区根");
    assert.equal(pickOpenRoot(roots, "a.txt", ws), ws, "相对路径按 base 解析");
    assert.equal(pickOpenRoot(roots, "/etc/hosts", ws), null, "哪个根都不沾 → null（调用方退回主根，照旧 403）");
    assert.equal(pickOpenRoot(roots, join(dir, "cfg-evil", "x"), ws), null, "前缀相同的兄弟目录不算在界内");
  });
});

test("pickOpenRoot：realpath 认得软链（工作区里的软链指向配置目录 → 挑配置根）", () => {
  makeTree((dir) => {
    const cfg = join(dir, "cfg");
    const ws = join(dir, "ws");
    mkdirSync(cfg); mkdirSync(ws);
    writeFileSync(join(cfg, "MEMORY.md"), "x");
    symlinkSync(join(cfg, "MEMORY.md"), join(ws, "link.md"));
    assert.equal(pickOpenRoot([cfg, ws], join(ws, "link.md"), ws), cfg);
  });
});

test("guardOpenTarget：越界 403（且不透露存不存在）、存在性 404、realpath 再判一次", () => {
  makeTree((dir) => {
    const cfg = join(dir, "cfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, "SOUL.md"), "x");
    assert.equal(guardOpenTarget(cfg, join(cfg, "SOUL.md")).ok, true);
    const missing = guardOpenTarget(cfg, join(cfg, "没有这个文件"));
    assert.equal(missing.ok, false);
    assert.equal(missing.ok === false ? missing.status : 0, 404);
    const outside = guardOpenTarget(cfg, "/etc/hosts");
    assert.equal(outside.ok, false);
    assert.equal(outside.ok === false ? outside.status : 0, 403, "越界优先判 403，不泄露存在性");
  });
});

test("guardOpenTarget：label 只改文案，不改判定（配置目录那条路要自带文案）", () => {
  makeTree((dir) => {
    const cfg = join(dir, "cfg");
    mkdirSync(cfg);
    const bad = guardOpenTarget(cfg, "/etc/hosts", "允许的目录（配置目录）");
    assert.equal(bad.ok, false);
    assert.match(bad.ok === false ? bad.message : "", /允许的目录（配置目录）/);
  });
});

test("inside/realOrNull 的 macOS 大小写口径：realpath 原样保留大小写时不许误判越界", () => {
  makeTree((dir) => {
    const real = realpathSync(dir);
    const upper = real.toUpperCase();
    const f = join(real, "f.txt");
    writeFileSync(f, "x");
    // 大小写不同（APFS 默认不敏感）仍然算在界内 —— 这正是 path-guard 里 toLowerCase 那条注释防的坑
    assert.equal(guardOpenTarget(upper, f, "测试根").ok, process.platform === "darwin");
  });
});
