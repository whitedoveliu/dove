/**
 * 主动性系统自测（M6 / T6.6–T6.8）：情绪 + 疲劳 + cron + heartbeat（零依赖、离线可跑）
 *   cd harness && node --no-warnings scripts/smoke-proactive.ts
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Db } from "../packages/core/src/session/db.ts";
import {
  EMOTION_FUSION_BASE,
  EMOTION_FUSION_CONTEXT,
  EMOTION_NEUTRAL,
  EmotionService,
  FatigueService,
} from "../packages/core/src/emotion/index.ts";
import {
  CRON_TICK_MS,
  CronScheduler,
  HEARTBEAT_OK,
  Heartbeat,
  inActiveHours,
  isHeartbeatOk,
  nextCronTime,
  parseCronExpr,
} from "../packages/core/src/scheduler/index.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log("  PASS  " + name + (detail ? "   [" + detail + "]" : ""));
  } else {
    failures.push(name + (detail ? " — " + detail : ""));
    console.log("  FAIL  " + name + (detail ? "   [" + detail + "]" : ""));
  }
}

function section(title: string): void {
  console.log("\n── " + title + " " + "─".repeat(Math.max(0, 46 - title.length)));
}

function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 目标时区的 YYYY-MM-DD HH:mm（校验 cron 下次触发用） */
function fmt(ts: number | null, tz: string): string {
  if (ts === null) return "null";
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts));
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? "";
  const hour = g("hour") === "24" ? "00" : g("hour");
  return g("year") + "-" + g("month") + "-" + g("day") + " " + hour + ":" + g("minute");
}

// ── 0) 环境 ──────────────────────────────────────────────────
const configDir = mkdtempSync(join(tmpdir(), "dove-proactive-"));
const ROOT = resolve(import.meta.dirname, "..");
const T0 = Date.parse("2026-10-05T10:00:00+08:00");
const NIGHT = Date.parse("2026-10-05T03:00:00+08:00");
let nowMs = T0;
const clock = (): Date => new Date(nowMs);
const HOUR = 3_600_000;

console.log("node " + process.version + "  ·  configDir=" + configDir);
console.log("T0 = " + new Date(T0).toISOString());

// ── 1) 情绪：融合 + 衰减 + 渲染 ───────────────────────────────
section("1. 情绪 EmotionService");
const emo = new EmotionService({ configDir, now: clock });
emo.setBase({ valence: 10, label: "兴奋", reason: "刚交付了一个满意的版本" });
emo.setContext({ valence: 0, label: "平静", reason: "在等用户反馈" }, "chat-1");

const s0 = emo.getState("chat-1");
const expectFused = EMOTION_FUSION_BASE * 10 + EMOTION_FUSION_CONTEXT * 0;
check("融合 = 0.3×base + 0.7×context", near(s0.fused.valence, expectFused), "fused=" + s0.fused.valence);
check("融合标签跟着偏离基线更远的那一层", s0.fused.label === "平静", "base 10/ctx 0，离基线 6 更远的是 ctx → label=" + s0.fused.label);
check("base.md 落盘（markdown + frontmatter）", readFileSync(emo.basePath, "utf8").startsWith("---"));
check("context 按 chatId 分文件", existsSync(join(configDir, "emotions", "context", "chat-1.md")));
check("缺省 chatId = default", emo.contextPath() === join(configDir, "emotions", "context", "default.md"));

nowMs = T0 + 1 * HOUR;
const s1 = emo.getState("chat-1");
check("1h：base 向 6 回落（未到）", s1.base.valence < 10 && s1.base.valence > EMOTION_NEUTRAL, "base=" + s1.base.valence);
check("1h：context 向 6 回升（未到）", s1.context.valence > 0 && s1.context.valence < EMOTION_NEUTRAL, "ctx=" + s1.context.valence);

nowMs = T0 + 2 * HOUR;
const s2 = emo.getState("chat-1");
check("2h：context 恰好回到基线 6", near(s2.context.valence, 6), "ctx=" + s2.context.valence);
check("2h：base 只走到 8.67（6h 窗口）", near(s2.base.valence, 8.67, 0.01), "base=" + s2.base.valence);

nowMs = T0 + 6 * HOUR;
const s3 = emo.getState("chat-1");
check("6h：base 恰好回到基线 6", near(s3.base.valence, 6), "base=" + s3.base.valence);
check("6h：融合值也是 6", near(s3.fused.valence, 6), "fused=" + s3.fused.valence);
check("回落目标是 6 不是 0", EMOTION_NEUTRAL === 6);

nowMs = T0;
writeFileSync(
  emo.contextPath("chat-1"),
  "---\nvalence: -4\nlabel: 低落\nreason: 手写测试\nupdatedAt: " + T0 + "\n---\n\n> 人手改的\n",
  "utf8",
);
const manual = emo.getState("chat-1");
check("手写 frontmatter 可被读回", near(manual.context.valence, -4) && manual.context.label === "低落");
const block = emo.renderBlock("chat-1");
const blockLines = block.split("\n");
check("renderBlock 非空", block.trim().length > 0);
check("renderBlock 3–6 行", blockLines.length >= 3 && blockLines.length <= 6, blockLines.length + " 行");
check("renderBlock 说清心情 / 为什么", block.indexOf("心情：") === 0 && block.includes("为什么：") && block.includes("低落"));
console.log("  ---- 情绪块 ----");
for (const line of blockLines) console.log("  | " + line);

// ── 2) 疲劳：自然增长 + sleep/wake/rest ───────────────────────
section("2. 疲劳 FatigueService");
nowMs = T0;
const fat = new FatigueService({ configDir, now: clock });
const f0 = fat.snapshot();
check("初始 0 疲劳 / 100 能量 / awake", f0.fatigue === 0 && f0.energy === 100 && f0.state === "awake");

nowMs = T0 + 4 * HOUR;
const f1 = fat.snapshot();
check("自然增长：醒 4h → 16", near(f1.fatigue, 16, 0.05), "fatigue=" + f1.fatigue);
check("能量与疲劳同步", near(f1.energy, 100 - f1.fatigue));

nowMs = T0 + 14 * HOUR;
const f2 = fat.snapshot();
check("阈值：≥55 → tired", f2.state === "tired" && f2.fatigue >= 55, "state=" + f2.state + " fatigue=" + f2.fatigue);

nowMs = T0 + 21 * HOUR;
const f3 = fat.snapshot();
check("阈值：≥80 → sleepy", f3.state === "sleepy", "state=" + f3.state + " fatigue=" + f3.fatigue);
check("清醒时长正确", near(f3.hours, 21, 0.01), "hours=" + f3.hours.toFixed(2));

fat.sleep();
check("sleep() → sleeping 并落盘", fat.snapshot().state === "sleeping" && existsSync(join(configDir, "fatigue.json")));
nowMs = T0 + 25 * HOUR;
const f4 = fat.snapshot();
check("睡眠 4h：快速回落到 24", near(f4.fatigue, 24, 0.05) && f4.state === "sleeping", "fatigue=" + f4.fatigue);

nowMs = T0 + 27 * HOUR;
const f5 = fat.snapshot();
check("睡够自然醒（8 + 余下清醒增长）", f5.state === "awake" && f5.fatigue > 8 && f5.fatigue < 20, "fatigue=" + f5.fatigue);

fat.wake();
const f6 = fat.snapshot();
check("wake() → awake 且重置清醒时长", f6.state === "awake" && f6.hours < 0.01, "hours=" + f6.hours.toFixed(3));

fat.set(60, "刚连续改了三小时代码");
const beforeRest = fat.snapshot().fatigue;
fat.rest(30);
const afterRest = fat.snapshot().fatigue;
check("rest(30) 疲劳下降 12", near(beforeRest - afterRest, 12, 0.05), beforeRest + " → " + afterRest);

nowMs += 2.5 * HOUR;
const f7 = fat.snapshot();
check("再自然增长 2.5h → +10 且转 tired", near(f7.fatigue - afterRest, 10, 0.05) && f7.state === "tired", "fatigue=" + f7.fatigue);
const fblock = fat.renderBlock();
const fLines = fblock.split("\n");
check("renderBlock 非空且 3–6 行", fblock.trim().length > 0 && fLines.length >= 3 && fLines.length <= 6, fLines.length + " 行");
console.log("  ---- 疲劳块 ----");
for (const line of fLines) console.log("  | " + line);

// ── 3) cron：every 1s 跑 3 秒 ─────────────────────────────────
section("3. cron every / 历史");
const db = new Db(":memory:");
const fired: string[] = [];
const cron = new CronScheduler({
  db,
  configDir,
  tickMs: 250,
  run: async (job) => {
    fired.push(job.id);
    return "done:" + job.name;
  },
});
check("tick 常量 = 30 秒", CRON_TICK_MS === 30_000);
const every = cron.create({ name: "每秒任务", type: "every", schedule: "1s", mode: "main", prompt: "ping", deliverTo: "home" });
check("create 返回完整任务", every.enabled === true && (every.nextRunAt ?? 0) > Date.now(), "nextRunAt=+" + Math.round(((every.nextRunAt ?? 0) - Date.now()) / 1000) + "s");
check("list 读回 1 条", cron.list().length === 1);

const atJob = cron.create({ name: "一次性提醒", type: "at", schedule: "1200ms", prompt: "提醒喝水" });
cron.start();
await sleep(3300);
cron.stop();
await sleep(400);

const everyRuns = fired.filter((f) => f === every.id).length;
const atRuns = fired.filter((f) => f === atJob.id).length;
const everyHist = cron.history(every.id);
check("every 1s 跑 3.3 秒触发 ≥2 次", everyRuns >= 2, "fired=" + everyRuns);
check("历史有记录且条数一致", everyHist.length === everyRuns && everyRuns >= 2, "history=" + everyHist.length);
check("历史字段完整", everyHist[0]?.ok === true && everyHist[0]?.result === "done:每秒任务" && everyHist[0]?.finishedAt != null);
check("trigger = schedule", everyHist[0]?.trigger === "schedule");
const everyAfter = cron.get(every.id);
check("every 仍 enabled 且下一次在未来", everyAfter?.enabled === true && (everyAfter?.nextRunAt ?? 0) > Date.now());
check("runCount 累计", (everyAfter?.runCount ?? 0) >= 2, "runCount=" + everyAfter?.runCount);

// ── 4) cron：一次性 at 触发后禁用 + 收据 ──────────────────────
section("4. cron 一次性任务收据");
const atAfter = cron.get(atJob.id);
check("at 触发后 enabled = false", atAfter?.enabled === false && atAfter?.nextRunAt === null);
check("at 只触发一次", atRuns === 1, "fired=" + atRuns);
const atHist = cron.history(atJob.id);
check("history 留收据文本", atHist.length === 1 && (atHist[0]?.receipt ?? "").includes("一次性任务"), atHist[0]?.receipt ?? "(空)");
const receiptDir = join(configDir, "cron", "receipts");
check("收据文件落盘", existsSync(receiptDir) && readdirSync(receiptDir).length >= 1, "files=" + (existsSync(receiptDir) ? readdirSync(receiptDir).length : 0));

section("4b. cron 管理接口");
const manualRun = await cron.runNow(every.id);
check("runNow 立即执行一次", manualRun.ok === true && manualRun.result === "done:每秒任务", String(manualRun.result));
check("runNow 记 manual 历史", cron.history(every.id)[0]?.trigger === "manual");
check("enable(false) 停用", cron.enable(every.id, false) === true && cron.get(every.id)?.enabled === false);
check("enable(true) 重排下一次", cron.enable(every.id, true) === true && (cron.get(every.id)?.nextRunAt ?? 0) > Date.now());
check("remove 删除 / 不存在返回 false", cron.remove(atJob.id) === true && cron.remove("nope") === false);
check("非法调度建不出来", (() => { try { cron.create({ name: "坏任务", type: "cron", schedule: "61 * * * *" }); return false; } catch { return true; } })());

// ── 5) cron：5 段表达式解析 ──────────────────────────────────
section("5. cron 表达式解析");
const c1 = parseCronExpr("*/5 * * * *");
check("*/5 分钟 = 12 个且都能被 5 整除", c1?.minutes.length === 12 && c1.minutes.every((m) => m % 5 === 0), c1?.minutes.join(","));
check("*/5 小时 = 全天 24 个", c1?.hours.length === 24);
const c2 = parseCronExpr("0 3 * * *");
check("0 3 * * *", c2?.minutes.join(",") === "0" && c2?.hours.join(",") === "3");
const c3 = parseCronExpr("30 8 * * 1-5");
check("30 8 * * 1-5", c3?.minutes.join(",") === "30" && c3?.hours.join(",") === "8" && c3?.daysOfWeek.join(",") === "1,2,3,4,5");
check("7 = 周日", parseCronExpr("0 0 * * 7")?.daysOfWeek.join(",") === "0");
check("非法表达式返回 null", parseCronExpr("61 * * * *") === null && parseCronExpr("* * * *") === null && parseCronExpr("a b c d e") === null);

const TZ = "Asia/Shanghai";
const monday = Date.parse("2026-10-05T00:00:00+08:00");
check("周一 00:00 → */5 下一次 00:05", fmt(nextCronTime("*/5 * * * *", monday, TZ), TZ) === "2026-10-05 00:05");
check("周一 00:00 → 0 3 * * * 下一次 03:00", fmt(nextCronTime("0 3 * * *", monday, TZ), TZ) === "2026-10-05 03:00");
check("周一 00:00 → 工作日 08:30", fmt(nextCronTime("30 8 * * 1-5", monday, TZ), TZ) === "2026-10-05 08:30");
const friday = Date.parse("2026-10-09T09:00:00+08:00");
check("周五 09:00（错过 08:30）→ 周一 08:30", fmt(nextCronTime("30 8 * * 1-5", friday, TZ), TZ) === "2026-10-12 08:30");
check("周字段限定：周一才跑", fmt(nextCronTime("0 9 * * 1", friday, TZ), TZ) === "2026-10-12 09:00");
check("时区覆盖：UTC 03:00 = 上海 11:00", fmt(nextCronTime("0 3 * * *", monday, "UTC"), TZ) === "2026-10-05 11:00");

// ── 6) heartbeat ─────────────────────────────────────────────
section("6. heartbeat");
writeFileSync(join(configDir, "HEARTBEAT.md"), "# 清单\n- 检查未完成的任务\n- 检查有没有要提醒的事\n", "utf8");
const delivered: string[] = [];
const prompts: string[] = [];
let mode = "ok";
let resolveSlow: ((v: string) => void) | null = null;
const hb = new Heartbeat({
  configDir,
  now: clock,
  deliver: (t) => delivered.push(t),
  run: async (p) => {
    prompts.push(p);
    if (mode === "report") return "构建挂了，需要你看一眼。";
    if (mode === "slow") return await new Promise<string>((res) => { resolveSlow = res; });
    return HEARTBEAT_OK + "\n";
  },
});

nowMs = NIGHT;
const nightTick = await hb.tick();
check("非工作时段不跑", nightTick.ran === false && nightTick.reason === "off-hours", "reason=" + nightTick.reason + " hour=" + new Date(NIGHT).getHours());
check("工作时段判定左闭右开", inActiveHours(7) === false && inActiveHours(8) === true && inActiveHours(22) === true && inActiveHours(23) === false);
check("HEARTBEAT_OK 判定", isHeartbeatOk("HEARTBEAT_OK") && isHeartbeatOk(" heartbeat_ok。 ") && !isHeartbeatOk("HEARTBEAT_OK 但是我发现构建挂了"));

nowMs = T0;
const okTick = await hb.tick();
check("HEARTBEAT_OK → suppressed，不打扰用户", okTick.ran === true && okTick.suppressed === true && okTick.reason === "heartbeat-ok");
check("被抑制时不调用 deliver", delivered.length === 0);
check("prompt 带上了 HEARTBEAT.md 清单", (prompts[0] ?? "").includes("检查未完成的任务") && (prompts[0] ?? "").includes("HEARTBEAT_OK"));

mode = "report";
const reportTick = await hb.tick();
check("真有事才 deliver", reportTick.ran === true && reportTick.suppressed === false && delivered.length === 1 && delivered[0] === "构建挂了，需要你看一眼。");

mode = "slow";
const slow = hb.tick();
const second = await hb.tick();
check("单飞：上一轮没跑完 → 跳过", second.ran === false && second.reason === "in-flight", "reason=" + second.reason);
resolveSlow?.(HEARTBEAT_OK);
const slowDone = await slow;
check("在飞的这一轮正常收尾", slowDone.ran === true && slowDone.suppressed === true);
check("HEARTBEAT.md 缺失时用兜底清单", new Heartbeat({ configDir: join(configDir, "empty"), run: async () => HEARTBEAT_OK, deliver: () => {} }).checklist().includes("主动性检查单"));
hb.start();
check("start() 进入定时模式", hb.running === true);
hb.stop();
check("stop() 退出定时模式", hb.running === false);

// ── 7) 文件大小硬约束 ────────────────────────────────────────
section("7. 文件大小（≤400 行）");
const files = [
  "packages/core/src/emotion/frontmatter.ts",
  "packages/core/src/emotion/emotion.ts",
  "packages/core/src/emotion/fatigue.ts",
  "packages/core/src/emotion/index.ts",
  "packages/core/src/scheduler/cron-parse.ts",
  "packages/core/src/scheduler/cron-model.ts",
  "packages/core/src/scheduler/cron.ts",
  "packages/core/src/scheduler/heartbeat.ts",
  "packages/core/src/scheduler/index.ts",
  "packages/core/src/session/schema.ts",
  "scripts/smoke-proactive.ts",
];
for (const f of files) {
  const n = readFileSync(join(ROOT, f), "utf8").split("\n").length;
  check(f.replace("packages/core/src/", ""), n <= 400, n + " 行");
}

// ── 汇总 ─────────────────────────────────────────────────────
const total = passed + failures.length;
console.log("\n" + "═".repeat(56));
if (failures.length) {
  console.log("FAILED  " + failures.length + " / " + total);
  for (const f of failures) console.log("  - " + f);
} else {
  console.log("ALL " + total + " CHECKS PASSED");
}
rmSync(configDir, { recursive: true, force: true });
db.close();
process.exit(failures.length ? 1 : 0);
