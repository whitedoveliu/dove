#!/usr/bin/env node
/**
 * Embedding 验收：本地 ONNX 向量
 *
 * 核心判据只有一个 —— **换个说法能不能召回**。
 * 这正是 hash-1024 做不到的（「用户喜欢暖色调」↔「她偏爱偏暖的配色」只有 0.066）。
 */
import { rmSync, mkdirSync, existsSync } from "node:fs";

const DB = process.env.DOVE_DB ?? "/tmp/emb-smoke/db";
const CFG = "/tmp/emb-smoke/cfg";
let pass = 0, fail = 0; const fails = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log("  ✓ " + n); } else { fail++; fails.push(n); console.log("  ✗ " + n + (d ? " — " + d : "")); } };

rmSync("/tmp/emb-smoke", { recursive: true, force: true });
mkdirSync(CFG, { recursive: true });

const { Db } = await import("../packages/core/src/session/db.ts");
const { MemoryService } = await import("../packages/core/src/memory/index.ts");
const { createHashEmbedding, cosine } = await import("../packages/core/src/memory/embedding.ts");
const { createOnnxEmbedding } = await import("../packages/embedding/src/onnx.ts");
const { resolveModelDir, isModelReady, DEFAULT_MODEL } = await import("../packages/embedding/src/model-path.ts");

// ── 1. 模型可用性 ──────────────────────────────────────
console.log("1) 模型与 provider");
const dir = resolveModelDir();
console.log("   模型目录:", dir);
check("模型已下载（" + DEFAULT_MODEL + "）", isModelReady(), "跑 packages/embedding/scripts/fetch-model.mjs 可下");
const onnx = await createOnnxEmbedding({ modelDir: dir });
check("ONNX provider 创建成功", !!onnx, "检查 onnxruntime-node 是否装了");
if (!onnx) { console.log("\n无法继续（没有 ONNX provider）"); process.exit(1); }
check("provider id 正确", onnx.id.startsWith("onnx:"), onnx.id);
check("维度是 512", onnx.dim === 512 || (await onnx.embed(["x"]))[0].length === 512, String(onnx.dim));

// ── 2. 语义质量（换词召回）──────────────────────────────
console.log("\n2) 语义质量 —— 换种说法能不能召回");
const hash = createHashEmbedding();
const bench = [
  { q: "我的配色偏好是什么", right: "用户喜欢暖色调、低饱和的配色",
    wrong: ["服务器磁盘占用到 80% 了", "这个项目的构建命令是 npm run build", "用户的名字叫林知夏"] },
  { q: "我用什么前端框架", right: "这个项目前端是 React 19 + Vite",
    wrong: ["用户偏好暖色调配色", "数据库用 SQLite 存储", "每天早上九点开会"] },
  { q: "项目的数据库是什么", right: "底层存储用的是 node:sqlite",
    wrong: ["她喜欢暖色系的视觉风格", "部署在阿里云上海机房", "每周五下午做周报"] },
  { q: "用户喜欢暖色调", right: "用户喜欢暖色调的配色", wrong: ["用户讨厌暖色调，明确说过要冷色"] },
];
async function benchScore(p) {
  let hits = 0; const margins = [];
  for (const c of bench) {
    const vs = await p.embed([c.q, c.right, ...c.wrong]);
    const rs = cosine(vs[0], vs[1]);
    let worst = -2;
    for (let i = 0; i < c.wrong.length; i++) worst = Math.max(worst, cosine(vs[0], vs[2 + i]));
    if (rs > worst) hits++;
    margins.push(rs - worst);
  }
  return { hits, min: Math.min(...margins), avg: margins.reduce((a, b) => a + b, 0) / margins.length };
}
const o = await benchScore(onnx);
const h = await benchScore(hash);
console.log(`   ONNX : ${o.hits}/${bench.length}   最小余量 ${o.min >= 0 ? "+" : ""}${o.min.toFixed(4)}`);
console.log(`   hash : ${h.hits}/${bench.length}   最小余量 ${h.min >= 0 ? "+" : ""}${h.min.toFixed(4)}`);
check("ONNX 全部答对", o.hits === bench.length, o.hits + "/" + bench.length);
check("ONNX 最小余量 > 0.05（有安全边界，不是碰巧）", o.min > 0.05, o.min.toFixed(4));
check("ONNX 明显优于 hash", o.min > h.min, `onnx ${o.min.toFixed(3)} vs hash ${h.min.toFixed(3)}`);

// ── 3. 反义陷阱（偏好记忆最怕这个）──────────────────────
console.log("\n3) 反义陷阱");
const [pv, nv, qv] = await onnx.embed(["用户喜欢暖色调", "用户讨厌暖色调，要冷色", "用户喜欢暖色调"]);
const sp = cosine(qv, pv), sn = cosine(qv, nv);
console.log(`   「喜欢暖色调」↔「喜欢暖色调」: ${sp.toFixed(4)}`);
console.log(`   「喜欢暖色调」↔「讨厌暖色调」: ${sn.toFixed(4)}`);
check("正向明显高于反向", sp > sn + 0.05, `差 ${(sp - sn).toFixed(4)}`);

// ── 4. 端到端：通过 MemoryService 换词召回 ──────────────
console.log("\n4) 端到端 —— 写一条记忆，换个说法召回");
const db = new Db(DB);
const mem = new MemoryService({ db, configDir: CFG, embedder: onnx });
await mem.init();
mem.remember("用户喜欢暖色调、低饱和的配色，讨厌高饱和", "preference");
mem.remember("这个项目前端用 React 19 + Vite 构建", "fact");
mem.remember("构建命令是 npm run build", "fact");
mem.remember("数据库用 node:sqlite，不用外部服务", "fact");
await new Promise((r) => setTimeout(r, 800));

const row = db.get("SELECT embedding_model, embedding_dim FROM memories LIMIT 1");
check("embedding_model 记为 onnx", String(row?.embedding_model ?? "").startsWith("onnx"), String(row?.embedding_model));
check("embedding_dim 记为 512", Number(row?.embedding_dim) === 512, String(row?.embedding_dim));

// 换词召回：查询与记忆**没有字面重叠**才算数
for (const [q, expect] of [
  ["我喜欢什么颜色", "暖色调"],
  ["前端技术栈是什么", "React"],
  ["数据存在哪里", "sqlite"],
]) {
  const r = await mem.retrieveForContext(q);
  const top = r.usedMemories[0]?.content ?? "";
  console.log(`   查「${q}」→ ${top.slice(0, 34) || "(空)"}`);
  check(`换词召回「${expect}」`, top.includes(expect), "实际: " + top.slice(0, 50));
}

// 诚实记录一条**能力边界**：概念级同义（打包 ↔ build）分数很低，
// 不是 bug、也不是调阈值能修的，所以不写成测试期望假装通过 —— 只记录、只断言它确实还在。
const { cosine: cos } = await import("../packages/core/src/memory/embedding.ts");
const [q2, m2, n2] = await onnx.embed(["怎么打包", "构建命令是 npm run build", "谢谢"]);
const sMatch = cos(q2, m2), sNoise = cos(q2, n2);
const TH = 0.44;
const verdict = sMatch < TH ? "低于阈值" : "高于阈值";
console.log(`   （能力边界：「怎么打包」↔「构建命令是 npm run build」= ${sMatch.toFixed(3)}（${verdict} ${TH}），`);
console.log(`     参照：同一句对「谢谢」的噪声分 ${sNoise.toFixed(3)}。`);
console.log(`     ${sMatch < sNoise ? "低于噪声 → 单阈值无解" : "高于噪声但仍在阈值附近 → 不稳"}，需要更大模型或查询改写）`);
check("能力边界被如实记录（不伪装成通过）", sMatch < 0.55, sMatch.toFixed(3));

// ── 5. 降级路径 ────────────────────────────────────────
console.log("\n5) 降级：没有 ONNX 时仍能工作");
const db2 = new Db("/tmp/emb-smoke/db2");
const mem2 = new MemoryService({ db: db2, configDir: CFG });
await mem2.init();
check("无 embedder 时自动降级 hash", mem2.embedder.id.startsWith("hash"), mem2.embedder.id);
mem2.remember("用户喜欢暖色调", "preference");
await new Promise((r) => setTimeout(r, 600));
const r2 = await mem2.retrieveForContext("用户喜欢暖色调");
check("降级后字面召回仍可用", (r2.usedMemories[0]?.content ?? "").includes("暖色调"));
check("两个 provider 的向量互不污染（按 model 隔离）",
  String(db2.get("SELECT embedding_model FROM memories LIMIT 1")?.embedding_model).startsWith("hash"));

// ── 6. 批量与边界 ──────────────────────────────────────
console.log("\n6) 批量与边界");
const batch = await onnx.embed(Array.from({ length: 20 }, (_, i) => `第 ${i} 条测试文本`));
check("批量 20 条返回 20 个向量", batch.length === 20 && batch.every((v) => v.length === 512));
const empty = await onnx.embed([""]);
check("空串不崩且返回 512 维", empty[0].length === 512);
const long = await onnx.embed(["很长的一段话。".repeat(500)]);
check("超长文本被截断后不崩", long[0].length === 512);
const zeros = empty[0].every((x) => x === 0);
console.log(`   （空串向量是否全零: ${zeros}）`);

console.log("\n" + "=".repeat(48));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fails.length) { console.log("失败："); for (const f of fails) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);
