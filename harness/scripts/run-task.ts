#!/usr/bin/env node
/**
 * 任务运行器：在夹具副本上跑一个任务，并把全过程打出来。
 * 用法：
 *   node scripts/run-task.ts <fixture> <taskText>
 *   node scripts/run-task.ts dove-studio "把配色改成暖色"
 * 环境：DOVE_WORKSPACE / DOVE_CONFIG / DOVE_DB 由调用方指定。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { finish } from "./_lifecycle.ts";

const [fixture, ...rest] = process.argv.slice(2);
const taskText = rest.join(" ");
if (!fixture || !taskText) { console.error("用法: node scripts/run-task.ts <fixture> <任务>"); process.exit(1); }

const cfg = loadConfig();
const projectId = "studio";
const projectDir = join(cfg.workspaceRoot, projectId);

// 每次跑之前把夹具复制成干净的项目
const fixtureDir = resolve(import.meta.dirname, "../fixtures", fixture);
if (!existsSync(fixtureDir)) { console.error("夹具不存在:", fixtureDir); process.exit(1); }
rmSync(projectDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
cpSync(fixtureDir, projectDir, { recursive: true });

const svc = await bootstrap(cfg);
svc.store.upsertProject({ id: projectId, name: "林知夏作品集", path: projectDir, kind: "website" });

// 把夹具的记忆文件搬进 Dove 的配置目录，让记忆层能看到
const memSrc = join(projectDir, "MEMORY.md");
if (existsSync(memSrc) && svc.memory) {
  const { readFileSync } = await import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  await svc.memory.writeFile("MEMORY.md", readFileSync(memSrc, "utf8"));
  console.log("已注入夹具记忆:", memSrc);
}

const th = svc.store.createThread({ id: "th_" + Date.now().toString(36), kind: "project", projectId, title: "任务" });
console.log("═══════════════════════════════════════════════");
console.log("任务:", taskText);
console.log("工作目录:", projectDir);
console.log("线程:", th.id);
console.log("═══════════════════════════════════════════════");

const COLORS: Record<string, string> = { tool_start: "\x1b[36m", tool_result: "\x1b[32m", error: "\x1b[31m", stats: "\x1b[35m", repair: "\x1b[33m", compaction: "\x1b[33m" };
let lastWasText = false;
const started = Date.now();

const sink = (e: Record<string, unknown>): void => {
  const type = String(e.type);
  if (type === "text") {
    if (!lastWasText) process.stdout.write("\n");
    process.stdout.write(String(e.content ?? ""));
    lastWasText = true;
    return;
  }
  lastWasText = false;
  if (type === "reasoning" || type === "step_start" || type === "turn_start") return;
  if (type === "tool_start") { console.log("\n  \x1b[36m⚙ " + e.tool + "\x1b[0m " + JSON.stringify(e.input ?? {}).slice(0, 200)); return; }
  if (type === "tool_result") {
    const body = JSON.stringify(e.result ?? e.error ?? "").slice(0, 260);
    console.log("  " + (e.ok ? "\x1b[32m✓" : "\x1b[31m✗") + " " + e.tool + "\x1b[0m (" + e.durationMs + "ms) " + body);
    return;
  }
  if (type === "tool_approval") { console.log("  \x1b[33m⏸ 审批: " + e.title + "\x1b[0m"); return; }
  if (type === "repair") { console.log("  \x1b[33m⚠ 崩溃修复\x1b[0m"); return; }
  if (type === "compaction") { console.log("  \x1b[33m⊟ 压缩 " + e.from + " → " + e.to + "\x1b[0m"); return; }
  if (type === "error") { console.log("\n\x1b[31m✗ 错误: " + e.content + "\x1b[0m"); return; }
  if (type === "stats") {
    const u = e.usage as { inputTokens: number; outputTokens: number; cacheReadTokens: number };
    console.log("\n\x1b[35m━━ " + ((Date.now() - started) / 1000).toFixed(1) + "s · " + e.steps + " 步 · 闸门 " + JSON.stringify(e.gates) + " · in " + u?.inputTokens + " / cache " + u?.cacheReadTokens + " / out " + u?.outputTokens + "\x1b[0m");
  }
};

try {
  await svc.runtime.run({ threadId: th.id, userText: taskText, projectId, sink: sink as never });
} catch (err) {
  console.error("\n运行失败:", err instanceof Error ? err.stack : err);
  process.exitCode = 1;
} finally {
  // ⚠️ 只关 db 不够 —— 输入监听子进程 / cron 定时器 / undici 连接池都会吊住事件循环。
  //    实测：任务 13s 做完，进程却挂了 2491s 才被 SIGKILL（退出码 137）。
  //    **任何用 CLI 跑任务的脚本或 CI 都会永久挂住。**
  finish(svc, process.exitCode ?? 0);
}
