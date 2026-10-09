#!/usr/bin/env node
/**
 * Dove CLI —— 用于命令行驱动 agent（测试与自动化）
 * 用法：
 *   node scripts/cli.ts <threadId> "你的消息"           单轮
 *   node scripts/cli.ts --new "标题"                    建线程
 *   node scripts/cli.ts --home "消息"                   用 Home 线程
 */
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { finish } from "./_lifecycle.ts";
import type { AgentEvent } from "../packages/core/src/agent/events.ts";

const cfg = loadConfig();
const svc = await bootstrap(cfg);
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("用法: node scripts/cli.ts [--home | --new <标题> | <threadId>] \"消息\"");
  process.exit(0);
}

let threadId: string;
let message: string;

if (args[0] === "--home") {
  threadId = svc.store.getOrCreateHomeThread().id;
  message = args.slice(1).join(" ");
} else if (args[0] === "--new") {
  const title = args[1] ?? "CLI 会话";
  const th = svc.store.createThread({ id: `th_cli_${Date.now().toString(36)}`, kind: "home", title });
  threadId = th.id;
  message = args.slice(2).join(" ");
} else {
  threadId = args[0]!;
  message = args.slice(1).join(" ");
}

if (!message) { console.error("缺少消息内容"); process.exit(1); }

const COLORS: Record<string, string> = {
  text: "\x1b[0m", reasoning: "\x1b[2m", tool_start: "\x1b[36m", tool_result: "\x1b[32m",
  error: "\x1b[31m", stats: "\x1b[35m", repair: "\x1b[33m", compaction: "\x1b[33m",
};
const started = Date.now();
let lastWasText = false;

const sink = (e: AgentEvent): void => {
  const c = COLORS[e.type];
  if (e.type === "text") {
    if (!lastWasText) process.stdout.write("\n");
    process.stdout.write(String(e.content ?? ""));
    lastWasText = true;
    return;
  }
  lastWasText = false;
  if (e.type === "reasoning") return;
  if (e.type === "turn_start") { console.log("\n\x1b[1m▶ 回合开始\x1b[0m"); return; }
  if (e.type === "step_start") { console.log(`\x1b[2m  ── step ${e.step} ──\x1b[0m`); return; }
  if (e.type === "tool_start") {
    const inp = JSON.stringify(e.input ?? {}).slice(0, 160);
    console.log(`  \x1b[36m⚙ ${e.tool}\x1b[0m ${inp}`);
    return;
  }
  if (e.type === "tool_result") {
    const body = JSON.stringify(e.result ?? e.error ?? "").slice(0, 220);
    console.log(`  ${e.ok ? "\x1b[32m✓" : "\x1b[31m✗"} ${e.tool}\x1b[0m (${e.durationMs}ms) ${body}`);
    return;
  }
  if (e.type === "tool_approval") { console.log(`  \x1b[33m⏸ 需要审批: ${e.title}\x1b[0m ${e.message}`); return; }
  if (e.type === "ask_user") { console.log(`  \x1b[33m? 提问: ${e.question}\x1b[0m`); return; }
  if (e.type === "repair") { console.log(`  \x1b[33m⚠ 崩溃修复: ${JSON.stringify(e.findings).slice(0, 200)}\x1b[0m`); return; }
  if (e.type === "compaction") { console.log(`  \x1b[33m⊟ 压缩: ${e.from} → ${e.to} 条\x1b[0m`); return; }
  if (e.type === "stats") {
    const u = e.usage as { inputTokens: number; outputTokens: number; cacheReadTokens: number } | undefined;
    console.log(`\n\x1b[35m━━ 完成: ${((Date.now() - started) / 1000).toFixed(1)}s · ${e.steps} 步 · 闸门 ${JSON.stringify(e.gates)} · in ${u?.inputTokens ?? 0} / cache ${u?.cacheReadTokens ?? 0} / out ${u?.outputTokens ?? 0}\x1b[0m`);
    return;
  }
  if (e.type === "error") { console.log(`\n\x1b[31m✗ 错误: ${e.content}\x1b[0m`); return; }
  if (c) console.log(`  ${c}${e.type}\x1b[0m ${JSON.stringify(e).slice(0, 200)}`);
};

try {
  await svc.runtime.run({ threadId, userText: message, sink });
} catch (e) {
  console.error("\n[cli] 运行失败:", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
} finally {
  // 只关 db 不够：子进程 / 定时器 / 连接池会吊住事件循环，进程永不退出
  finish(svc, process.exitCode ?? 0);
}
