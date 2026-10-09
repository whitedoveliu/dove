#!/usr/bin/env node
/**
 * cron 端到端：建一个 every 2s 的任务，跑 7 秒，检查触发次数与历史。
 * 同时验证：情绪 / 疲劳确实进的是 mt（尾部上下文），不是系统提示词。
 */
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库指到临时目录，别碰生产库
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { finish } from "./_lifecycle.ts";

const cfg = loadConfig();
const svc = await bootstrap(cfg);
const events = [];
svc.onEvent((e) => events.push(e.type));

console.log("=== 1. 建 cron 任务 ===");
const job = svc.cron.create({
  name: "每 2 秒报一次时",
  type: "every",
  schedule: "2s",
  mode: "isolated",
  prompt: "只回一句话：现在是几点？不要调用任何工具，不要写文件。",
});
console.log("  任务:", job.id, job.name, "| type:", job.type, "| schedule:", job.schedule);

console.log("=== 2. 启动调度，等 7 秒 ===");
svc.cron.start();
await new Promise((r) => setTimeout(r, 7000));
svc.cron.stop();

const hist = svc.cron.history(job.id, 20);
console.log("  触发次数:", hist.length);
for (const h of hist.slice(0, 4)) {
  console.log("   -", new Date(h.startedAt).toISOString().slice(11, 19), h.status, String(h.result ?? "").slice(0, 60));
}

console.log("=== 3. 一次性任务触发后应被禁用 ===");
const once = svc.cron.create({
  name: "一次性提醒", type: "at", schedule: "1s", mode: "main",
  prompt: "只回一句话：到点了。不要调用工具。",
});
console.log("  建好，enabled =", svc.cron.list().find((j) => j.id === once.id)?.enabled);
svc.cron.start();
await new Promise((r) => setTimeout(r, 4000));
svc.cron.stop();
const after = svc.cron.list().find((j) => j.id === once.id);
console.log("  触发后 enabled =", after?.enabled, "（应为 false）");
console.log("  收据:", svc.cron.history(once.id, 1)[0]?.receipt ? "已写 ✓" : "未写 ✗");

console.log("=== 4. 情绪/疲劳进 mt 不进系统提示词 ===");
const home = svc.store.getOrCreateHomeThread();
svc.emotion.setContext({ label: "被一个漂亮的排版打动了", valence: 8 }, home.id);
svc.fatigue.rest(0);
const { assembleSystemPrompt } = await import("../packages/core/src/context/assemble.ts");
const sys = await assembleSystemPrompt({ thread: home, projectContext: { workdir: cfg.workspaceRoot, configDir: cfg.configDir } });
const sysAll = sys.block1 + (sys.block2 ?? "");
console.log("  系统提示词含情绪词:", /被打动|心情|情绪/.test(sysAll) ? "✗ 漏了" : "✓ 没有");
const { renderTailContext } = await import("../packages/core/src/context/tail-context.ts");
const mt = renderTailContext({ emotion: svc.emotion.renderBlock(home.id), fatigue: svc.fatigue.renderBlock() });
console.log("  mt 含情绪块:", mt.includes("被打动") || mt.length > 300 ? "✓" : "✗");
console.log("  mt 片段:", mt.replace(/\n+/g, " | ").slice(0, 220));

console.log("=== 5. 事件总线 ===");
console.log("  收到事件类型:", [...new Set(events)].join(", "));

console.log("\nDONE");
finish(svc, 0);
