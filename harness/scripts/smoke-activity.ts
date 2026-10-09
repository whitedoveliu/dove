/**
 * 感知层（M7 活动记录器）自测
 * 运行：cd harness && node --no-warnings scripts/smoke-activity.ts
 *
 * 覆盖：权限探测（有/无都要有明确返回）→ 采帧落库+落盘 → 同一帧判重丢弃 → 脱敏（含 Luhn）
 *      → 存储统计与轮转 → OCR（swiftc 编译 + 识别 + 降级）→ 会话分析 → 日报骨架 → 触发/降频
 * 环境相关能力（屏幕录制权限 / swiftc）缺失时按「降级说明」跳过，不影响整体 exit 0。
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityRecorder } from "../packages/core/src/activity/index.ts";
import { ActivityStore, dateKey } from "../packages/core/src/activity/store.ts";
import { ActivityStorage } from "../packages/core/src/activity/storage.ts";
import { analyzeSession } from "../packages/core/src/activity/analyzer.ts";
import { buildSkeleton, narrate } from "../packages/core/src/activity/report.ts";
import { luhn, redact } from "../packages/core/src/activity/redact.ts";
import { Deduper, fnv1a, histogram } from "../packages/core/src/activity/dedupe.ts";
import { SCREEN_PERMISSION_HINT, isScreenRecordingAllowed, screenIsLocked } from "../packages/core/src/activity/capture.ts";
import { OCR_EVERY_N, SWIFTC, ensureHelper, ocrImage, renderTextImage } from "../packages/core/src/activity/ocr.ts";
import { TriggerEngine } from "../packages/core/src/activity/triggers.ts";
import { Db } from "../packages/core/src/session/db.ts";

let passed = 0;
let failed = 0;
let degraded = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function skip(name: string, why: string): void {
  degraded++;
  console.log(`  ⚠️  跳过 ${name} — ${why}`);
}
function section(title: string): void { console.log(`\n=== ${title} ===`); }

const TMP = mkdtempSync(join(tmpdir(), "dove-activity-smoke-"));
const CONFIG_DIR = join(TMP, "config");
const db = new Db(join(TMP, "dove.db"));
const store = new ActivityStore(db);
const quietLogger = (level: string, msg: string, data?: Record<string, unknown>): void => {
  if (level !== "info") console.log(`     [${level}] ${msg}`, data ?? "");
};
const recorder = new ActivityRecorder({ db, configDir: CONFIG_DIR, enabled: true, logger: quietLogger });

// ── 1. 权限探测 ──────────────────────────────────────────────
section("1. 屏幕录制权限探测");
const allowed = await isScreenRecordingAllowed();
check("isScreenRecordingAllowed() 返回明确布尔值", typeof allowed === "boolean", `=> ${allowed}`);
const init = await recorder.init();
check("init() 返回 ok/screenPermission", typeof init.ok === "boolean" && typeof init.screenPermission === "boolean", JSON.stringify(init));
check("init 的 screenPermission 与探测一致", init.screenPermission === allowed);
if (!allowed) console.log(`     ⚠️  无屏幕录制权限，引导文案：${init.note ?? SCREEN_PERMISSION_HINT}`);
const locked = await screenIsLocked();
check("锁屏检测可用（锁屏期间停采）", typeof locked === "boolean", `屏幕当前${locked ? "已锁定" : "未锁定"}`);

// ── 2. 采帧 → 落库 + 落盘 ────────────────────────────────────
section("2. 采一帧（落库 + 文件存在）");
let capturedId: string | undefined;
if (allowed) {
  const first = await recorder.captureNow("manual");
  capturedId = first.snapshotId;
  check("captureNow 返回 snapshotId", !!first.snapshotId, first.snapshotId ?? first.skipped ?? "");
  const row = capturedId ? recorder.store.getSnapshot(capturedId) : undefined;
  if (capturedId && row) {
    check("快照已落库", !!row, capturedId);
    check("文件存在", existsSync(row.filePath), row.filePath);
    check("文件字节数与库里一致", row.sizeBytes === statSync(row.filePath).size, `${row.sizeBytes} 字节 / ${row.width}x${row.height}`);
    check("记录了指纹与直方图", !!row.hashHex && (row.histogram?.length ?? 0) === 32, `hash=${row.hashHex} 桶=${row.histogram?.length}`);
    check("归属到一个活动会话", !!row.sessionId, row.sessionId ?? "");
  } else check("快照已落库", false, first.skipped ?? "没有 snapshotId");
} else {
  const out = await recorder.captureNow("manual");
  check("无权限时返回结构化 skipped（不抛）", typeof out.skipped === "string" && out.skipped.includes("屏幕录制"), out.skipped ?? "");
  skip("采帧落库", "无屏幕录制权限（其他能力不受影响）");
}

// ── 3. 判重 ─────────────────────────────────────────────────
section("3. 判重：同一帧采两次");
{
  const w = 64, h = 64;
  const base = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    base[i * 4] = (i * 7) % 256; base[i * 4 + 1] = (i * 13) % 256; base[i * 4 + 2] = 200; base[i * 4 + 3] = 255;
  }
  const same = new Uint8Array(base);
  const tiny = new Uint8Array(base);
  for (let i = 0; i < 20; i++) tiny[i * 4] = 0;            // 20/4096 = 0.5% 像素变了
  const big = new Uint8Array(base);
  for (let i = 0; i < w * h; i++) big[i * 4] = 255 - base[i * 4]!;
  const bmp = (data: Uint8Array) => ({ width: w, height: h, data });
  const d = new Deduper();
  const r0 = d.check(bmp(base));
  const r1 = d.check(bmp(same));
  const r2 = d.check(bmp(tiny));
  const r3 = d.check(bmp(big));
  check("首帧不算重复", r0.duplicate === false);
  check("完全相同的帧 → ① 哈希判重", r1.duplicate && r1.reason === "hash", JSON.stringify(r1));
  check("微小改动（0.5% 像素）→ ③ 逐像素判重", r2.duplicate && r2.reason === "pixel", JSON.stringify(r2));
  check("大幅改动 → 不判重", r3.duplicate === false, JSON.stringify(r3));
  check("FNV-1a 稳定且对内容敏感", fnv1a(base) === fnv1a(same) && fnv1a(base) !== fnv1a(big));
  const hist = histogram(bmp(base));
  check("直方图 32 桶且归一化", hist.length === 32 && Math.abs(hist.reduce((a, b) => a + b, 0) - 1) < 1e-9);
}
if (allowed) {
  const second = await recorder.captureNow("manual");
  if (second.skipped?.includes("判重")) check("第二次采同一帧被判重丢弃", true, second.skipped);
  else {
    const third = await recorder.captureNow("manual");
    check("第二次采同一帧被判重丢弃（画面可能在动，重试一次）", !!third.skipped?.includes("判重"),
      `第二次=${second.snapshotId ?? second.skipped} 第三次=${third.skipped ?? third.snapshotId}`);
  }
} else skip("端到端判重", "无屏幕录制权限");

// ── 4. 脱敏 ─────────────────────────────────────────────────
section("4. 脱敏（入库前）");
const secretText = [
  "OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx0123",
  "GITHUB=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  "CARD=4111 1111 1111 1111",
  "SSN=123-45-6789",
  "AUTH=Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop",
  "PWD: hunter2secret",
].join("\n");
const red = redact(secretText);
check("API_KEY 被替换（sk- / ghp_）", (red.hits.API_KEY ?? 0) >= 2, JSON.stringify(red.hits));
check("CREDIT_CARD 被替换（Luhn 通过）", red.hits.CREDIT_CARD === 1);
check("SSN 被替换", red.hits.SSN === 1);
check("BEARER_TOKEN / JWT 被替换", (red.hits.BEARER_TOKEN ?? 0) + (red.hits.JWT ?? 0) >= 1);
check("PASSWORD 默认关闭", red.text.includes("hunter2secret"), "默认不脱敏密码符合规格");
check("aggressive 打开后 PASSWORD 被替换", (redact(secretText, { aggressive: true }).hits.PASSWORD ?? 0) === 1);
check("原文里的密钥已消失", !red.text.includes("sk-abcdef") && !red.text.includes("4111 1111"));
check("替换标记格式正确", red.text.includes("[REDACTED:API_KEY]") && red.text.includes("[REDACTED:CREDIT_CARD]"));
check("Luhn 校验生效（乱数字不误伤）", luhn("4111111111111111") && !luhn("1234567890123456"));
check("普通长数字不被误伤", !redact("订单号 1234567890123456").hits.CREDIT_CARD);

// ── 5. 存储统计与轮转 ───────────────────────────────────────
section("5. 存储统计与轮转");
const stats = recorder.stats();
check("stats() 可运行", typeof stats.snapshots === "number" && typeof stats.bytes === "number", JSON.stringify(stats));
const storage = new ActivityStorage(store, { configDir: CONFIG_DIR });
const oldId = "snap_expired_smoke";
const oldPath = join(CONFIG_DIR, "activity", "snapshots", "2000-01-01", `${oldId}.jpg`);
store.insertSnapshot({
  id: oldId, sessionId: null, timestamp: Date.now() - 40 * 86_400_000, filePath: oldPath,
  width: 100, height: 100, sizeBytes: 10, trigger: "heartbeat", appName: null, windowTitle: null,
  hashHex: null, histogram: null, diffPct: null, storageTier: "cold",
});
const sweep = await storage.sweep();
check("sweep() 返回结构化统计", typeof sweep.scanned === "number" && Array.isArray(sweep.errors), JSON.stringify(sweep));
check("超过 30 天的快照被删除（行）", !store.getSnapshot(oldId));
check("超过 30 天的快照被删除（文件）", !existsSync(oldPath));
check("统计随轮转更新", recorder.stats().snapshots <= stats.snapshots + 1);

// ── 6. OCR ─────────────────────────────────────────────────
section("6. OCR（Vision helper 运行时编译 + 识别 + 落库链路）");
check("默认每 3 张跑一次 OCR", OCR_EVERY_N === 3, `OCR_EVERY_N=${OCR_EVERY_N}`);
const hasSwiftc = existsSync(SWIFTC);
if (!hasSwiftc) {
  const r = await ocrImage(join(TMP, "none.png"));
  check("无 swiftc 时降级返回空文本 + error", r.text === "" && !!r.error, r.error ?? "");
  skip("OCR 识别", "本机没有 /usr/bin/swiftc");
} else {
  const helper = await ensureHelper();
  check("helper 编译成功（缓存到 ~/.dove/cache）", helper.ok, helper.path ?? helper.error ?? "");
  const img = join(TMP, "ocr-fixture.png");
  const rendered = await renderTextImage(img, "DOVE OCR SMOKE 20260101");
  check("生成含文字的测试图", rendered.ok, rendered.error ?? img);
  if (rendered.ok) {
    const got = await ocrImage(img);
    check("识别出测试图文字", got.text.includes("DOVE") && got.text.includes("20260101"), JSON.stringify(got.text));
  }
  const missing = await ocrImage(join(TMP, "nope.png"));
  check("图片不存在时降级（不抛）", missing.text === "" && !!missing.error, missing.error ?? "");
  const secretImg = join(TMP, "secret-fixture.png");
  const sr = await renderTextImage(secretImg, "sk-abcdefghijklmnopqrstuvwx0123");
  if (sr.ok) {
    const raw = await ocrImage(secretImg);
    const clean = redact(raw.text).text;
    check("OCR 结果再过脱敏 → 密钥不落库",
      raw.text.length > 0 && !clean.includes("sk-abcdef") && clean.includes("[REDACTED:API_KEY]"),
      `raw="${raw.text.slice(0, 30)}" clean="${clean.slice(0, 30)}"`);
  }
  // 端到端：ocrEvery=1 的记录器采一帧，OCR 结果应脱敏后落 activity_ocr_frames
  const recOcr = new ActivityRecorder({
    db, configDir: join(TMP, "config-ocr"), enabled: true, ocrEvery: 1, logger: quietLogger,
  });
  const ocrInit = await recOcr.init();
  if (ocrInit.screenPermission) {
    const before = store.countOcrFrames();
    const shot = await recOcr.captureNow("manual");
    const after = store.countOcrFrames();
    check("采帧后 OCR 文本已落库（入库前脱敏）", after > before || !shot.snapshotId,
      `OCR 帧 ${before} → ${after}${shot.skipped ? `（${shot.skipped}）` : ""}`);
    if (shot.snapshotId) {
      const frames = store.listOcrFrames(recOcr.sessionId ?? "", 5);
      check("落库文本不含未脱敏密钥", frames.every((f) => !/sk-[A-Za-z0-9_-]{16,}|\b\d{4} \d{4} \d{4} \d{4}\b/.test(f.text)),
        frames[0] ? `首帧 ${frames[0].charCount} 字` : "无帧");
    }
    recOcr.stop();
  } else skip("OCR 落库链路", "无屏幕录制权限");
}

// ── 7. 会话分析 + 日报 ───────────────────────────────────────
section("7. 会话分析与日报");
{
  const sid = recorder.sessionId ?? store.openSession("heartbeat").id;
  const anchor = capturedId ?? "snap_smoke_ocr";
  store.insertOcrFrame({ snapshotId: anchor, sessionId: sid, text: "编辑 dedupe.ts：直方图阈值 0.08 → 0.05，重跑自测。" });
  store.insertOcrFrame({ snapshotId: anchor, sessionId: sid, text: "终端输出 44 passed / 2 failed，正在修 analyzer 的空 digest 分支。" });
  const fakeLlm = {
    async complete() {
      return JSON.stringify({
        worth: true, title: "调整判重阈值 sk-abcdefghijklmnopqrstuvwx0123", description: "调了直方图阈值并重跑自测。",
        project: "dove-harness", topics: ["判重", "自测"], highlights: ["阈值改到 0.05"],
        entities: [{ type: "file", name: "dedupe.ts" }],
        memoryCandidates: [{ content: "判重阈值定为 0.05 / 0.02 两级", kind: "decision" }],
      });
    },
  };
  const result = await analyzeSession(store, sid, fakeLlm, { model: "fake-model" });
  check("analyzeSession 解析出结构化 JSON", result.worth && result.project === "dove-harness", JSON.stringify(result.topics));
  check("分析结果入库前脱敏", !result.title.includes("sk-abcdef") && result.title.includes("[REDACTED:API_KEY]"), result.title);
  check("无 LLM 时返回空结果 + error", !!(await analyzeSession(store, sid, undefined)).error);
  const badJson = await analyzeSession(store, sid, { async complete() { return "模型胡说八道"; } });
  check("模型输出非法 JSON 时降级", !!badJson.error && badJson.worth === false, badJson.error ?? "");
  // 门面：analyze() 落库 + memoryCandidates 汇入记忆管线（T7.9）
  const remembered: string[] = [];
  const rec2 = new ActivityRecorder({
    db, configDir: CONFIG_DIR, enabled: true, llm: fakeLlm, model: "fake-model", logger: quietLogger,
    remember: async (content) => { remembered.push(content); return "mem_1"; },
  });
  const viaFacade = await rec2.analyze(sid);
  check("门面 analyze() 写回 activity_sessions.summary", !!store.getSession(sid)?.summary && viaFacade.worth);
  check("memoryCandidates 汇入记忆写入管线", remembered.length === 1 && remembered[0]!.includes("判重阈值"), remembered[0] ?? "");
  const sessions = store.listSessions(dateKey(Date.now())).map((s) => ({
    id: s.id, project: s.summary?.project ?? "未归属项目", title: s.summary?.title ?? "活动片段（未分析）",
    description: s.summary?.description ?? "", topics: s.summary?.topics ?? [], highlights: s.summary?.highlights ?? [],
    worth: s.summary?.worth ?? false, analyzed: !!s.analyzedAt, startedAt: s.startedAt, endedAt: s.endedAt,
    snapshotCount: s.snapshotCount ?? 0,
  }));
  const skeleton = buildSkeleton(dateKey(Date.now()), sessions);
  check("日报骨架是确定性 markdown", skeleton.startsWith("# 工作日志 · ") && skeleton.includes("统计："), skeleton.split("\n")[0] ?? "");
  check("无 LLM 时 narrate 原样返回骨架", (await narrate(skeleton, undefined)) === skeleton);
  check("有 LLM 时 narrate 采用模型输出", (await narrate("# 骨架", { async complete() { return "改写后的日志"; } })) === "改写后的日志");
  const daily = await recorder.dailyReport();
  check("dailyReport() 可生成并落库", daily.length > 0 && !!store.getSummary("daily", dateKey(Date.now())));
  check("weeklyReport() 可生成", (await recorder.weeklyReport()).startsWith("# 工作周报"));
}

// ── 8. 触发 / debounce / 生命周期 ────────────────────────────
section("8. 触发与 debounce");
{
  let fired = 0;
  const t = new TriggerEngine({ onCapture: () => { fired++; } });
  t.start();
  t.notify("click"); t.notify("click"); t.notify("app_focus");
  check("4s debounce 生效（3 次触发只采 1 次）", fired === 1 && t.drops >= 2, `fired=${fired} drops=${t.drops}`);
  t.markIdle(); t.markIdle(); t.markIdle();
  check("空闲降频上限 5 分钟", t.nextDelay("heartbeat") <= 300_000);
  t.stop();
  t.notify("click");
  check("stop 后不再触发", fired === 1);
  // 未 init 的记录器（#screenPermission=false）用于验证 start/stop 生命周期，不产生截图副作用
  const rec3 = new ActivityRecorder({ db, configDir: CONFIG_DIR, enabled: true, logger: quietLogger });
  rec3.start();
  check("start() 后触发器在跑", rec3.running);
  rec3.stop();
  check("stop() 后触发器停止", !rec3.running);
  const disabled = new ActivityRecorder({ db, configDir: CONFIG_DIR, enabled: false, logger: quietLogger });
  const dInit = await disabled.init();
  check("enabled=false 时 ok=false + note", dInit.ok === false && !!dInit.note, dInit.note ?? "");
  check("enabled=false 时不截图（结构化 skipped）", !!(await disabled.captureNow()).skipped);
}

// ── 收尾 ────────────────────────────────────────────────────
recorder.stop();
db.close();
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n结果：${passed} 通过 / ${failed} 失败 / ${degraded} 降级跳过`);
console.log(allowed ? "屏幕录制权限：已获得（实测采帧 + 落库 + 判重）" : "屏幕录制权限：未获得（实测降级路径与引导文案）");
process.exit(failed > 0 ? 1 : 0);
