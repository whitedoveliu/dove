#!/usr/bin/env node
/**
 * 记忆注入通道自测（验收脚本）
 *   cd harness && node --no-warnings scripts/smoke-inject.ts
 *
 * 覆盖：查询改写 / 记忆通道召回与不注入（按后端分档的阈值）/ 真向量（装了 ONNX 才跑）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../packages/core/src/session/db.ts";
import { injectThresholdFor, MemoryService, rewriteQuery } from "../packages/core/src/memory/index.ts";
import { createHashEmbedding } from "../packages/core/src/memory/embedding.ts";
import { MEMORY_INJECT_THRESHOLD, MEMORY_INJECT_THRESHOLD_HASH } from "../packages/core/src/constants.ts";

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log("  \u2705 " + name); }
  else { fails.push(name + (detail ? " \u2014 " + detail : "")); console.log("  \u274c " + name + (detail ? " \u2014 " + detail : "")); }
}
function section(title: string): void { console.log("\n=== " + title + " ==="); }

// ── 0) 环境：一个内存库装下记忆 ────────────────────────────────
const configDir = mkdtempSync(join(tmpdir(), "dove-inject-"));
const db = new Db(":memory:");

// ── 1) 记忆通道（hash 档）：改写 / 召回 / 不注入 / 阈值分档 ────
section("1. 记忆通道（hash 档）");
const mem = new MemoryService({ db, configDir, embedder: createHashEmbedding(), scope: "global" });
await mem.init();
await mem.remember("用户喜欢低饱和度的莫兰迪配色，界面留白要多一些。");
const q = "你好，帮我看下首页的配色方案，谢谢";
check("查询改写剥掉招呼与客套", rewriteQuery(q) === "首页的配色方案", rewriteQuery(q));
const memHit = await mem.retrieveForContext(q);
check("记忆通道：改写后仍召回", memHit.context.includes("## Relevant Memories"), "len=" + memHit.context.length);
const memMiss = await mem.retrieveForContext("量子纠缠退相干实验的噪声谱");
check("记忆通道：无关查询不注入（hash 档阈值 " + MEMORY_INJECT_THRESHOLD_HASH + "）", memMiss.context === "", "len=" + memMiss.context.length);
check("注入阈值按后端分档：真向量 " + MEMORY_INJECT_THRESHOLD + " / hash " + MEMORY_INJECT_THRESHOLD_HASH,
  injectThresholdFor("onnx:bge-small-zh-v1.5") === MEMORY_INJECT_THRESHOLD && injectThresholdFor("hash-1024") === MEMORY_INJECT_THRESHOLD_HASH);

// ── 2) 真 ONNX（装了模型才有）：同一批断言在真向量上再跑一遍 ──
// 没装就跳过，不让环境把验收搞挂
try {
  const { resolveEmbedder } = await import("../packages/server/src/embedder.ts");
  const resolved = await resolveEmbedder();
  if (resolved.note) {
    console.log("  \u23ed 跳过真向量检查：" + resolved.note);
  } else {
    const memOnnx = new MemoryService({ db, configDir, embedder: resolved.provider, scope: "global" });
    // ⚠️ 内容必须和上面 hash 档写的不同：写入去重是跨后端按内容判的，重复内容不会再落一条 ONNX 向量
    await memOnnx.remember("用户偏好低饱和度的灰绿色系，拒绝纯黑背景。");
    await memOnnx.remember("客户把评审会改到周五上午十点，记得带海报初稿。");
    const onnxHit = await memOnnx.retrieveForContext("首页配色方案要不要再压暗一点");
    const onnxMiss = await memOnnx.retrieveForContext("你好");
    check("真 " + resolved.id + "：相关 query 注入", onnxHit.context.includes("## Relevant Memories"), "used=" + onnxHit.usedMemories.length);
    check("真 " + resolved.id + "：招呼语不注入（阈值 " + MEMORY_INJECT_THRESHOLD + "）", onnxMiss.context === "", "used=" + onnxMiss.usedMemories.length);
  }
} catch (e) {
  console.log("  \u23ed 跳过真向量检查：" + String(e).slice(0, 80));
}

// ── 汇总 ──────────────────────────────────────────────────────
try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log("\n" + "=".repeat(52));
console.log("结果：" + pass + " 通过 / " + fails.length + " 失败");
for (const f of fails) console.log("  - " + f);
process.exit(fails.length === 0 ? 0 : 1);
