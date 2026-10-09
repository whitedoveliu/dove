#!/usr/bin/env node
/**
 * 记忆链路体检：截图 → OCR → SQLite → 检索
 *
 * 用一个**内容已知**的窗口，逐段验证这条链在哪一环断掉。
 * 第 1 步在屏幕上放一段别处不可能出现的文字，后面才敢说"检索到了"。
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP = "/tmp/screen-mem";
rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });

// 一段别处不可能出现的哨兵文本（检索时必须只可能来自屏幕）
const SENTINEL = "紫水晶协议";
const SENTINEL2 = "海豚座第七码头";
const html = `<!doctype html><meta charset="utf-8">
<body style="font: 64px -apple-system,'PingFang SC';padding:80px;background:#fff">
<h1 style="color:#111">${SENTINEL}</h1>
<p style="color:#222">${SENTINEL2} · DOVE-SCREEN-MEMORY-PROBE</p>
</body>`;
writeFileSync(join(TMP, "probe.html"), html);

console.log("=== 1. 在屏幕上放一段已知文本 ===");
console.log("  哨兵:", SENTINEL, "/", SENTINEL2);
const { spawn, execFileSync: ex } = await import("node:child_process");
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--new-window", "--window-size=1400,800", "--window-position=60,60",
  `file://${TMP}/probe.html`,
], { stdio: "ignore", detached: true });
chrome.unref();
await new Promise((r) => setTimeout(r, 6000));
// 关键：必须把窗口带到最前，否则 screencapture 截到的是别的窗口
try {
  ex("/usr/bin/osascript", ["-e", 'tell application "Google Chrome" to activate']);
  await new Promise((r) => setTimeout(r, 2500));
} catch (e) { console.log("  （激活 Chrome 失败，可能截到别的窗口）"); }

console.log("\n=== 2. 截图 ===");
const shot = join(TMP, "shot.png");
execFileSync("/usr/sbin/screencapture", ["-x", "-t", "png", shot]);
const size = (await import("node:fs")).statSync(shot).size;
console.log("  ✓ 截图", shot, (size / 1024).toFixed(0) + "KB");

console.log("\n=== 3. OCR ===");
const { ensureHelper, ocrImage } = await import("../packages/core/src/activity/ocr.ts");
const helper = await ensureHelper();
if (!helper.ok) { console.log("  ✗ OCR helper 不可用:", helper.error); process.exit(1); }
const r = await ocrImage(shot);
console.log("  ✓ OCR 完成，识别到", (r.text ?? "").length, "字符");
console.log("  文本片段:", JSON.stringify((r.text ?? "").slice(0, 120)));
const hit1 = (r.text ?? "").includes(SENTINEL);
const hit2 = (r.text ?? "").includes(SENTINEL2);
console.log("  哨兵命中:", hit1 ? "✓" + SENTINEL : "✗", "/", hit2 ? "✓" + SENTINEL2 : "✗");

console.log("\n=== 4. 有没有别的窗口干扰 ===");
console.log("  （屏幕上还有别的内容，下面检索必须靠哨兵排除侥幸）");

console.log("\n=== 5. 从真实数据库里查 ===");
const dbPath = process.env.DOVE_DB ?? "/tmp/rt/db";
let db;
try { db = new DatabaseSync(dbPath); } catch (e) { console.log("  ✗ 打不开数据库", dbPath, String(e.message).slice(0,80)); process.exit(1); }
const all = (sql, ...p) => db.prepare(sql).all(...p);
const n = all("SELECT COUNT(1) c FROM activity_ocr_frames")[0].c;
console.log("  activity_ocr_frames 行数:", n);
const rows = all("SELECT text FROM activity_ocr_frames ORDER BY created_at DESC LIMIT 40");
const found = rows.filter((x) => String(x.text).includes(SENTINEL));
console.log("  含哨兵的行数:", found.length, found.length ? "✓ 存进去了" : "✗ 库里没有");
if (found.length) console.log("  命中内容:", JSON.stringify(String(found[0].text).slice(0, 140)));

console.log("\n=== 6. 「检索」这一环 —— 现在能不能查回来？ ===");
// 6a 有没有全文索引
const idx = all("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND (name LIKE '%fts%' OR name LIKE '%index%' OR name LIKE '%search%')");
console.log("  与检索相关的表:", idx.map((x) => x.name).join(", ") || "(无)");
// 6b memories 表里有没有屏幕内容
const memAll = all("SELECT COUNT(1) c FROM memories")[0].c;
const memScreen = all("SELECT COUNT(1) c FROM memories WHERE kind = 'screen' OR content LIKE ?", "%" + SENTINEL + "%")[0].c;
console.log("  memories 总行数:", memAll, "| 含屏幕内容的:", memScreen);
// 6c 用 LIKE 硬搜（模拟"没有索引时的最笨办法"）
const like = all("SELECT COUNT(1) c FROM activity_ocr_frames WHERE text LIKE ?", "%" + SENTINEL + "%")[0].c;
console.log("  LIKE 硬搜能命中:", like, "行（说明数据在，只是没有被检索能力覆盖）");

console.log("\n=== 结论 ===");
if (found.length && memScreen === 0) {
  console.log("  截图→OCR→SQLite ✓ 通的");
  console.log("  SQLite→检索     ✗ 断的：OCR 文本只被报表读取，agent 检索不到");
} else if (found.length && memScreen > 0) {
  console.log("  全链路 ✓");
} else {
  console.log("  前面就断了");
}
try { execFileSync("/usr/bin/pkill", ["-f", "probe.html"]); } catch { /* 已经关了 */ }
