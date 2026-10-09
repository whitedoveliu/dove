/**
 * 全局输入监听自测（T7.4）
 * 运行：cd harness && node --no-warnings scripts/smoke-input.ts
 *
 * 覆盖：ensureMonitor()（swiftc 编译缓存）→ isAccessibilityGranted() → attachInputMonitor 接进 ActivityRecorder
 *      → 3 秒内收到 app 切换事件（无辅助功能权限时也要有明确说明）→ 键盘节流 200ms
 *      → detach 后进程真的退出（ps 验证，不留僵尸）
 * 无 swiftc / 无辅助功能权限都只影响覆盖度，不影响 exit 0；脚本自身逻辑错了才 exit 1。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InputMonitor, KEY_THROTTLE_MS, type InputEvent, ensureMonitor, keyThrottle, parseLine,
} from "../packages/core/src/activity/input-monitor.ts";
import { activeMonitor, attachInputMonitor, currentAppInfo, detachInputMonitor, dispatch } from "../packages/core/src/activity/focus.ts";
import { ActivityRecorder } from "../packages/core/src/activity/index.ts";
import { isScreenRecordingAllowed } from "../packages/core/src/activity/capture.ts";
import { Db } from "../packages/core/src/session/db.ts";

let passed = 0, failed = 0, degraded = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};
const skip = (name: string, why: string): void => { degraded++; console.log("  ⚠️  跳过 " + name + " — " + why); };
const section = (t: string): void => { console.log("\n=== " + t + " ==="); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ps 查进程：查不到返回空串（macOS 上 ps -p 不存在时退出码非 0） */
function psLookup(pid: number): string {
  try { return execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=,stat=,comm="], { encoding: "utf8" }).trim(); }
  catch { return ""; }
}
function psAllMonitors(): string[] {
  try {
    return execFileSync("/bin/ps", ["-eo", "pid=,comm="], { encoding: "utf8" })
      .split("\n").map((l) => l.trim()).filter((l) => l.includes("input-monitor"));
  } catch { return []; }
}

const TMP = mkdtempSync(join(tmpdir(), "dove-input-smoke-"));
const events: InputEvent[] = [];
let pid: number | null = null;

try {
  // ── 1. helper 编译与缓存 ─────────────────────────────────
  section("1. ensureMonitor()（swiftc 运行时编译 + 缓存）");
  const helper = await ensureMonitor();
  check("ensureMonitor() 返回明确结果", typeof helper.ok === "boolean", JSON.stringify(helper).slice(0, 200));
  if (!helper.ok || !helper.bin) {
    console.log("\n⚠️  明确降级：" + String(helper.error));
    console.log("   输入监听不可用（无 swiftc / 编译失败），activity 的其他能力不受影响。按验收：有明确返回即 exit 0。");
    console.log("\n通过 " + passed + " / 失败 " + failed + " / 降级跳过 " + degraded);
    process.exit(0);
  }
  check("编译产物存在且可执行", existsSync(helper.bin) && (statSync(helper.bin).mode & 0o111) !== 0, helper.bin);
  check("二次调用复用同一产物（内容哈希缓存）", (await ensureMonitor()).bin === helper.bin);

  // ── 2. 辅助功能权限 ──────────────────────────────────────
  section("2. 辅助功能权限实测");
  const probe = new InputMonitor();
  const granted = await probe.isAccessibilityGranted();
  check("isAccessibilityGranted() 返回明确布尔值", typeof granted === "boolean", "granted=" + granted);
  if (!granted) {
    console.log("     ⚠️  当前进程未获「辅助功能」权限：键盘/鼠标事件会被系统屏蔽，");
    console.log("        但 app 切换事件走 NSWorkspace 通知，不需要权限（本次仍应收到）。");
    console.log("        授权入口：openAccessibilitySettings() → x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  }

  // ── 3. 事件解析与节流（确定性，不依赖权限） ──────────────
  section("3. 事件解析与键盘节流（纯函数）");
  const parsed = parseLine('{"kind":"key","keyCode":12,"modifiers":["cmd"],"ts":1699999999999}');
  check("parseLine：解析 keyCode/修饰键（无字符字段）", parsed?.kind === "key" && parsed.keyCode === 12 && (parsed.modifiers ?? []).includes("cmd"), JSON.stringify(parsed));
  check("parseLine：非 JSON / 缺 kind → null", parseLine("not-json") === null && parseLine('{"ts":1}') === null);
  check("parseLine：key 事件里没有 characters 字段（隐私纪律）", !Object.keys(parsed ?? {}).some((k) => /char|input|text/i.test(k)), Object.keys(parsed ?? {}).join(","));
  const st = new Map<number, number>();
  const t1 = keyThrottle(st, 12, 1_000), t2 = keyThrottle(st, 12, 1_100), t3 = keyThrottle(st, 12, 1_000 + KEY_THROTTLE_MS);
  check("节流：同一 keyCode " + KEY_THROTTLE_MS + "ms 内只放行一次", t1 && !t2 && t3, "1000ms→" + t1 + " / 1100ms→" + t2 + " / " + (1_000 + KEY_THROTTLE_MS) + "ms→" + t3);

  // ── 4. 接到 ActivityRecorder ─────────────────────────────
  section("4. attachInputMonitor() → ActivityRecorder（app 切换 → notify）");
  const db = new Db(join(TMP, "dove.db"));
  const recorder = new ActivityRecorder({
    db, configDir: join(TMP, "config"), enabled: true,
    logger: (level, msg, data) => { if (level !== "info") console.log("     [activity:" + level + "] " + msg, data ?? ""); },
  });
  await recorder.init();
  const attached = await attachInputMonitor(recorder, {
    onEvent: (e) => { events.push(e); },
    logger: (level, msg, data) => { if (level !== "info") console.log("     [monitor:" + level + "] " + msg, data ?? ""); },
  });
  check("attachInputMonitor 返回明确结果", typeof attached.ok === "boolean", JSON.stringify(attached).slice(0, 200));
  if (!attached.ok) throw new Error("监听启动失败：" + String(attached.error));
  const mon = activeMonitor();
  pid = mon?.pid ?? null;
  check("监听进程已拉起（有 pid）", typeof pid === "number" && pid > 0, "pid=" + String(pid));

  // 3 秒窗口内至少一条 app 事件（无权限时事件流仍应有 permission 说明）
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !events.some((e) => e.kind === "app")) await sleep(100);
  const appEvent = events.find((e) => e.kind === "app");
  const permEvent = events.find((e) => e.kind === "permission");
  check("3 秒内收到 app 切换事件", !!appEvent && !!appEvent.app, appEvent ? JSON.stringify({ app: appEvent.app, bundleId: appEvent.bundleId, windowTitle: appEvent.windowTitle }) : "没收到 app 事件");
  check("permission 事件已在启动时上报", !!permEvent && typeof permEvent.granted === "boolean", JSON.stringify(permEvent));
  if (appEvent && appEvent.app) {
    check("焦点缓存同步更新（currentAppInfo）", currentAppInfo()?.appName === appEvent.app, JSON.stringify(currentAppInfo()));
  } else skip("焦点缓存", "没有 app 事件");
  const kinds = events.reduce<Record<string, number>>((m, e) => { m[e.kind] = (m[e.kind] ?? 0) + 1; return m; }, {});
  console.log("     事件统计：" + JSON.stringify(kinds) + "（有辅助功能权限时还会有 key/leftMouseDown/scroll）");

  // ── 5. 事件 → 触发 的翻译（不依赖权限） ──────────────────
  section("5. 事件 → activity 触发 的翻译");
  const sinkKinds: string[] = [];
  const sinkMeta: Array<Record<string, unknown>> = [];
  const sink = { notify: (kind: string, meta?: Record<string, unknown>): void => { sinkKinds.push(kind); sinkMeta.push(meta ?? {}); } };
  dispatch(sink, { kind: "app", ts: Date.now(), app: "DOVE-SMOKE-APP", windowTitle: "DOVE-SMOKE-WIN" });
  dispatch(sink, { kind: "key", ts: Date.now(), keyCode: 12, modifiers: ["cmd"] });
  dispatch(sink, { kind: "leftMouseDown", ts: Date.now(), x: 10, y: 20 });
  check("app → notify('app_focus', {appName, windowTitle})", sinkKinds[0] === "app_focus" && sinkMeta[0].appName === "DOVE-SMOKE-APP" && sinkMeta[0].windowTitle === "DOVE-SMOKE-WIN", JSON.stringify(sinkMeta[0]));
  check("key → notify('typing_pause')（停手后采一帧）", sinkKinds[1] === "typing_pause", sinkKinds[1]);
  check("click → notify('click')", sinkKinds[2] === "click", sinkKinds[2]);
  check("触发都带上了当前前台 app（meta 不被冲掉）", sinkMeta[1]?.appName === "DOVE-SMOKE-APP" && sinkMeta[2]?.appName === "DOVE-SMOKE-APP", JSON.stringify(sinkMeta[2]));

  const screenOk = await isScreenRecordingAllowed();
  if (screenOk) {
    // 把事件真发给 ActivityRecorder，再采一帧：验证 app_name / window_title 真的落进快照行
    dispatch(recorder, { kind: "app", ts: Date.now(), app: "DOVE-SMOKE-APP", windowTitle: "DOVE-SMOKE-WIN" });
    const out = await recorder.captureNow("manual");
    const row = out.snapshotId ? recorder.store.getSnapshot(out.snapshotId) : undefined;
    check("采集快照时 app_name / window_title 已填上（不再是 null）",
      !!row && row.appName === "DOVE-SMOKE-APP" && row.windowTitle === "DOVE-SMOKE-WIN",
      JSON.stringify({ appName: row?.appName, windowTitle: row?.windowTitle }) + (out.skipped ? " / skipped=" + out.skipped : ""));
  } else {
    skip("快照 app_name 落库", "无屏幕录制权限 → 无法采帧；meta 已按 " + JSON.stringify(sinkMeta[0]) + " 交给记录器（notify 路径已由第 5 节验证）");
  }

  // ── 6. stop 后不留僵尸 ───────────────────────────────────
  section("6. detachInputMonitor() → 进程真的退出（ps 验证）");
  check("stop 前进程活着", pid !== null && psLookup(pid) !== "", "ps: " + psLookup(pid ?? 0));
  detachInputMonitor();
  await sleep(700);   // 超过 STOP_GRACE_MS，SIGTERM 应已生效
  const left = pid !== null ? psLookup(pid) : "";
  check("stop 后 ps 查不到该 pid（无僵尸/孤儿）", left === "", left === "" ? "pid=" + String(pid) + " 已消失" : "仍在：" + left);
  const all = psAllMonitors();
  console.log("     全局扫描残留 input-monitor 进程：" + (all.length === 0 ? "无" : JSON.stringify(all)));
} catch (e) {
  failed++;
  console.log("  ❌ 自测异常：" + String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 400));
  detachInputMonitor();
} finally {
  if (pid !== null && psLookup(pid) !== "") { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
  rmSync(TMP, { recursive: true, force: true });
}

console.log("\n通过 " + passed + " / 失败 " + failed + " / 降级跳过 " + degraded);
process.exit(failed > 0 ? 1 : 0);
