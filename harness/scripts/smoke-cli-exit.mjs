#!/usr/bin/env node
/**
 * CLI 退出回归 —— 防止「任务做完但进程永不退出」这个 bug 回来。
 *
 * 背景（实测 2026-10-06）：4 个脚本 bootstrap 之后只关了 db，没调 svc.shutdown()。
 * 输入监听的子进程 stdin 管道 / cron 定时器 / undici 连接池都会吊住事件循环，
 * 结果是：
 *   任务本体 13.6s / 42.6s / 82s / 353.6s
 *   进程实际挂了 2491s / 3893s / 4442s / 3893s，最后全被 SIGKILL（退出码 137）
 *
 * **这个 bug 不会报错、不会崩溃，只会静默挂死 —— CI 上就是跑满 6 小时然后超时。**
 * 所以必须有一条测试专门盯它。
 */
import { spawn } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const TMP = "/tmp/cli-exit";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0; const fails = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log("  ✓ " + n); } else { fail++; fails.push(n); console.log("  ✗ " + n + (d ? " — " + d : "")); } };

/**
 * 跑一个脚本，返回 { code, seconds, killed, log }
 * @param timeoutS 超过这个时间就杀掉并标记为挂住
 */
function run(script, args, timeoutS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", ["--no-warnings", script, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        DOVE_APPROVE: "auto",
        DOVE_WORKSPACE: TMP + "/ws",
        DOVE_CONFIG: TMP + "/cfg",
        DOVE_DB: TMP + "/db-" + Math.random().toString(36).slice(2, 7),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    p.stdout.on("data", (d) => { log += d.toString(); });
    p.stderr.on("data", (d) => { log += d.toString(); });
    let killed = false;
    const timer = setTimeout(() => { killed = true; p.kill("SIGKILL"); }, timeoutS * 1000);
    p.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, seconds: (Date.now() - t0) / 1000, killed, log });
    });
  });
}

console.log("=== 1. 静态检查：bootstrap 了就必须 shutdown ===");
const { readdirSync, readFileSync } = await import("node:fs");
const scripts = readdirSync(ROOT + "scripts").filter((f) => /\.(ts|mjs)$/.test(f));
const offenders = [];
for (const f of scripts) {
  const src = readFileSync(ROOT + "scripts/" + f, "utf8");
  if (!/bootstrap\(/.test(src)) continue;
  // 走 withServices 的也算合规（它内部会收尾）
  if (/finish\(|shutdown\(\)|withServices\(/.test(src)) continue;
  offenders.push(f);
}
check(`${scripts.length} 个脚本里没有「bootstrap 却不收尾」的`, offenders.length === 0, offenders.join(", "));

// 同样重要：bootstrap 却不隔离数据库的，会**直接写生产库**
// 实测踩过：smoke-cron-e2e 建的「每 2 秒报时」落进生产库，攒了 4 个副本，
// App 一启动就 25 分钟烧了 1080 轮模型调用。
// 只管**测试脚本**（smoke-* / verify-*）：产品入口（cli.ts / run-task.ts）
// 用真库本来就是对的 —— 那是给人用的命令行，不是自动化测试。
const polluters = [];
for (const f of scripts) {
  if (!/^(smoke|verify)-/.test(f)) continue;
  const src = readFileSync(ROOT + "scripts/" + f, "utf8");
  if (!/bootstrap\(/.test(src)) continue;
  if (/_isolate\.ts|DOVE_DB|tmpdir|mkdtemp/.test(src)) continue;
  polluters.push(f);
}
check(`没有「bootstrap 却不隔离数据库」的脚本`, polluters.length === 0,
  polluters.length ? polluters.join(", ") + " —— 加一行 import \"./_isolate.ts\"; 即可" : "");

// 「写了 stop 忘了 start」是这套代码里最容易犯的错：调度器建好了、shutdown 也停了，
// 但启动侧没人调 —— 功能静默失效，测试还全绿（因为测试直接调业务函数、绕过调度器）。
// 实测踩过：MemoryService.startScheduler() 从来没被调用过，「每天 3 点归档记忆」
// 这条流水线一次都没跑，模型说「我的日记本还是空的」。
const bootstrapSrc = readFileSync(ROOT + "packages/server/src/bootstrap.ts", "utf8");
const schedulerPairs = [
  { name: "cron", stop: "cron.stop()", start: /cron\.start\(\)/ },
  { name: "heartbeat", stop: "heartbeat.stop()", start: /heartbeat\.start\(\)/ },
  { name: "activity", stop: "activity?.stop()", start: /activity\.start\(\)/ },
  { name: "memory 睡眠", stop: "memory?.stopScheduler()", start: /memory\.startScheduler\(\)/ },
];
const unwired = schedulerPairs.filter((p) => bootstrapSrc.includes(p.stop) && !p.start.test(bootstrapSrc));
check("每个 stop 了的调度器都有对应的 start", unwired.length === 0,
  unwired.length ? unwired.map((p) => p.name).join(", ") + " —— shutdown 里有 stop，但启动侧没 start" : "");

console.log("\n=== 2. 真的跑一个任务，看它退不退 ===");
// 用一个不需要模型的任务太重；直接跑最小冒烟，它同样会 bootstrap
const r = await run("scripts/smoke-bootstrap.ts", [], 60);
console.log(`   smoke-bootstrap: 退出码 ${r.code}，耗时 ${r.seconds.toFixed(1)}s${r.killed ? "（被杀）" : ""}`);
check("smoke-bootstrap 在 30s 内自然退出", !r.killed && r.seconds < 30, r.seconds.toFixed(1) + "s");
check("退出码是 0", r.code === 0, String(r.code));

console.log("\n=== 3. run-task 也要能退（真调模型，慢一点）===");
if (process.env.DOVE_SKIP_LLM === "1") {
  console.log("   （DOVE_SKIP_LLM=1，跳过）");
} else {
  const r2 = await run("scripts/run-task.ts", ["dove-studio", "只回复两个字：收到"], 90);
  const stats = /━━ ([0-9.]+)s/.exec(r2.log);
  console.log(`   run-task: 退出码 ${r2.code}，进程耗时 ${r2.seconds.toFixed(1)}s，任务本体 ${stats ? stats[1] + "s" : "?"}${r2.killed ? "（被杀）" : ""}`);
  check("run-task 在 60s 内自然退出", !r2.killed && r2.seconds < 60, r2.seconds.toFixed(1) + "s");
  if (stats) {
    const body = Number(stats[1]);
    check(`进程耗时没有远超任务耗时（本体 ${body}s / 进程 ${r2.seconds.toFixed(1)}s）`,
      r2.seconds < body + 20, `差 ${(r2.seconds - body).toFixed(1)}s`);
  }
  check("任务确实跑完了（有 stats 行）", !!stats);
}

console.log("\n" + "=".repeat(50));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fails.length) { console.log("失败："); for (const f of fails) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);
