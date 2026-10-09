#!/usr/bin/env node
/**
 * 记忆链路端到端：**OCR → SQLite → 建索引 → 检索**
 *
 * ⚠️ 为什么不再依赖「屏幕上有特定内容」：
 * 上一版把哨兵文字画在 Chrome 窗口里再 screencapture，但**窗口焦点不稳定** ——
 * 探针窗口没到最前时截到的是别的窗口，测试就红了。**依赖焦点的测试必然 flaky，
 * 而 flaky 的测试比没有测试更糟**（会让人不再相信它）。
 *
 * 现在的分工：
 *   · 真实截屏能不能截到东西 → 由 smoke-activity.ts 覆盖（58 项，真截真判重）
 *   · OCR 出来的文本能不能被检索回来 → 由本脚本覆盖（确定性，不碰窗口焦点）
 *
 * 哨兵文字用 OCR helper 自己的 renderTextImage 画成 PNG，
 * 再走**完全相同**的落库路径（insertSnapshot → insertOcrFrame → 倒排索引 → search）。
 */
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DB = process.env.DOVE_DB ?? "/tmp/screen-mem/db";
const TMP = "/tmp/screen-mem";
rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });

const SENTINEL = "紫水晶协议";
const SENTINEL2 = "海豚座第七码头";
let pass = 0, fail = 0; const fails = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log("  ✓ " + n); } else { fail++; fails.push(n); console.log("  ✗ " + n + (d ? " — " + d : "")); } };

// ── 1. 造一张内容已知的图（走 OCR helper 自己的渲染，不依赖窗口）─────
console.log("1) 造一张内容已知的图");
const { ensureHelper, ocrImage, renderTextImage } = await import("../packages/core/src/activity/ocr.ts");
const helper = await ensureHelper();
check("OCR helper 可用", helper.ok, helper.error ?? "");
if (!helper.ok) { console.log("\n无法继续"); process.exit(1); }

const img = `${TMP}/probe.png`;
const r0 = await renderTextImage(img, `${SENTINEL}\n${SENTINEL2}\nDOVE-SCREEN-MEMORY-PROBE`);
check("渲染出 PNG", r0.ok && existsSync(img), r0.error ?? "");
if (!existsSync(img)) { console.log("\n无法继续"); process.exit(1); }
console.log("   ", (execFileSync("/usr/bin/stat", ["-f", "%z", img], { encoding: "utf8" }).trim() / 1024).toFixed(0) + "KB");
console.log("    哨兵:", SENTINEL, "/", SENTINEL2);

// ── 2. OCR ─────────────────────────────────────────────
console.log("\n2) OCR");
const ocr = await ocrImage(img);
const text = ocr.text ?? "";
console.log("   识别", text.length, "字符:", JSON.stringify(text.replace(/\s+/g, " ").slice(0, 90)));
check("读出了 " + SENTINEL, text.includes(SENTINEL));
check("读出了 " + SENTINEL2, text.includes(SENTINEL2));

// 折行场景：中文换行不该切断 2-gram
const { tokenize } = await import("../packages/core/src/memory/screen-index.ts");
const wrapped = tokenize("紫水\n晶协\n议");
const q = tokenize(SENTINEL);
check("折行的中文也能切出完整 2-gram（跨行合并）",
  q.every((t) => wrapped.includes(t)), JSON.stringify(wrapped));

// ── 3. 落库 + 建索引（走真实 store）─────────────────────
console.log("\n3) 落 SQLite 并建索引");
const { Db } = await import("../packages/core/src/session/db.ts");
const { ActivityStore } = await import("../packages/core/src/activity/store.ts");
const db = new Db(DB);
const store = new ActivityStore(db);
const snapId = "snap_" + Date.now().toString(36);
store.insertSnapshot({
  id: snapId, sessionId: "s_e2e", timestamp: Date.now(), filePath: img,
  width: 1200, height: 300, sizeBytes: 1000, trigger: "manual",
  appName: "DOVE-PROBE-APP", windowTitle: "DOVE-PROBE-WIN", hashHex: "h", histogram: "[]",
  diffPct: 0, storageTier: "hot",
});
const frameId = store.insertOcrFrame({ snapshotId: snapId, sessionId: "s_e2e", text });
check("OCR 文本写进 activity_ocr_frames", !!frameId);
const stats = store.screenIndexStats();
check(`倒排索引建起来了（${stats.terms} 词条 / ${stats.frames} 帧）`, stats.terms > 0 && stats.frames > 0);

// ── 4. 检索 ────────────────────────────────────────────
console.log("\n4) 检索 —— 这一步以前是断的");
const hits = store.searchScreen(SENTINEL, { limit: 5 });
check("用哨兵检索能命中", hits.length > 0, "命中 " + hits.length + " 条");
if (hits.length) {
  const h = hits[0];
  check("命中的是那一帧", h.text.includes(SENTINEL));
  check("命中词是完整 2-gram", JSON.stringify(h.matched) === JSON.stringify(["紫水", "水晶", "晶协", "协议"]), JSON.stringify(h.matched));
  check("带上了 app / 窗口上下文", h.appName === "DOVE-PROBE-APP" && h.windowTitle === "DOVE-PROBE-WIN", `${h.appName}/${h.windowTitle}`);
}
check("第二个哨兵也能查到", store.searchScreen(SENTINEL2, { limit: 5 }).length > 0);
check("查不相干的词不乱命中", store.searchScreen("量子纠缠退相干实验装置", { limit: 5 }).length === 0);

// ── 5. Recall 工具（agent 实际走的路）──────────────────
console.log("\n5) 通过 Recall 工具（agent 真正调的就是它）");
const { RecallTool } = await import("../packages/core/src/tools/builtin/recall.ts");
const emitted = [];
const ctx = {
  toolCallId: "t1", threadId: "th", workdir: TMP,
  services: {
    recall: async () => [],
    searchScreen: (q, n) => store.searchScreen(q, { limit: n ?? 5 }),
  },
  emit: (k, v) => emitted.push({ k, v }),
};
const res = await RecallTool.execute({ query: SENTINEL, limit: 5 }, ctx);
const out = typeof res === "string" ? JSON.parse(res) : res;
check("Recall 返回 screenMemories 字段", Array.isArray(out.screenMemories));
check("Recall 里能查到屏幕内容", (out.screenMemories ?? []).length > 0);
check("Recall 事件带 screenFound", emitted.some((e) => e.k === "tool:memory-recalled" && e.v.screenFound > 0));

// ── 6. rebuild（升级老库用）─────────────────────────────
console.log("\n6) rebuild");
db.run("DELETE FROM activity_ocr_terms");
const rb = store.rebuildScreenIndex();
check("rebuild 把索引补回来了", rb.frames > 0 && store.searchScreen(SENTINEL, { limit: 3 }).length > 0, JSON.stringify(rb));

// ── 7. 真实截屏（只验「能截能 OCR」，不断言内容）────────
console.log("\n7) 真实截屏（不断言屏幕上有什么 —— 那是焦点决定的，不是代码决定的）");
const shot = `${TMP}/real.png`;
execFileSync("/usr/sbin/screencapture", ["-x", "-t", "png", shot]);
const realSize = Number(execFileSync("/usr/bin/stat", ["-f", "%z", shot], { encoding: "utf8" }).trim());
check("screencapture 能出图（>100KB）", realSize > 100_000, (realSize / 1024).toFixed(0) + "KB");
const real = await ocrImage(shot);
check("真实截图 OCR 有输出（>50 字符）", (real.text ?? "").length > 50, (real.text ?? "").length + " 字符");
const realFrame = store.insertOcrFrame({ snapshotId: snapId, sessionId: "s_real", text: real.text ?? "" });
check("真实截图也进了索引", !!realFrame && store.screenIndexStats().frames >= 2);

console.log("\n" + "=".repeat(48));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fails.length) { console.log("失败："); for (const f of fails) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);
