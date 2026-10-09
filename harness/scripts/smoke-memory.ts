/**
 * 记忆系统自测（零依赖、离线可跑）
 *   cd harness && node --no-warnings scripts/smoke-memory.ts
 *
 * 覆盖：hash 向量 → L1 文件层 → L2 向量层 → 检索 → 去重写入 → 睡眠流水线 → 异常安全。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../packages/core/src/session/db.ts";
import { cosine, createHashEmbedding, hashVector } from "../packages/core/src/memory/embedding.ts";
import { MemoryService } from "../packages/core/src/memory/index.ts";

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

function pairCosine(service: MemoryService, id1: string, id2: string): number {
  const vecs = service.store.loadVectors().filter((v) => v.id === id1 || v.id === id2);
  return vecs.length === 2 ? cosine(vecs[0]!.vector, vecs[1]!.vector) : 0;
}

// ── 0) 环境 ──────────────────────────────────────────────────
const configDir = mkdtempSync(join(tmpdir(), "dove-memory-"));
const db = new Db(":memory:");
const svc = new MemoryService({ db, configDir, embedder: createHashEmbedding(), scope: "global" });
await svc.init();

console.log("node " + process.version + "  ·  db=:memory:  ·  embedder=" + svc.embedder.id);
console.log("configDir=" + configDir);

// ── 1) hash 向量 ─────────────────────────────────────────────
section("1. hash embedding");
const v1 = hashVector("配色");
const v2 = hashVector("配色");
check("同文本向量确定", JSON.stringify(v1) === JSON.stringify(v2));
check("自相似度 = 1", Math.abs(cosine(v1, v2) - 1) < 1e-9, "cos=" + cosine(v1, v2).toFixed(6));
const related = cosine(hashVector("配色"), hashVector("界面配色要克制"));
const unrelated = cosine(hashVector("配色"), hashVector("pnpm 依赖安装"));
check("相关文本相似度更高", related > unrelated, "related=" + related.toFixed(3) + " unrelated=" + unrelated.toFixed(3));
check("无关文本不虚高", unrelated < 0.1, "unrelated=" + unrelated.toFixed(3));
check("零向量不炸", cosine(hashVector(""), hashVector("配色")) === 0);

// ── 2) L1 文件层 ─────────────────────────────────────────────
section("2. L1 文件层");
for (const f of ["SOUL.md", "USER.md", "MEMORY.md"]) {
  check("ensureDefaults 创建 " + f, existsSync(join(configDir, f)));
}
const files0 = await svc.loadFilesForPrompt();
check("loadForPrompt 注入 SOUL 人设", files0.soul.includes("Dove"), "soul=" + files0.soul.length + " chars");
svc.files.write("USER.md", "# USER\n\n<!-- 待填 -->\n");
const files1 = await svc.loadFilesForPrompt();
check("空 / 纯模板文件被跳过", files1.user === "");

// ── 3) 写入 5 条记忆（含中文） ────────────────────────────────
section("3. 写入记忆");
const seeds = [
  { content: "用户喜欢低饱和度的莫兰迪配色，界面留白要多一些。", kind: "taste" },
  { content: "项目使用 pnpm，禁止引入任何 npm 运行时依赖。", kind: "decision" },
  { content: "用户的名字是 whitedove，习惯用中文交流。", kind: "fact" },
  { content: "做海报时优先使用思源黑体，标题控制在 12 个字以内。", kind: "preference" },
  { content: "配色方案里避免使用纯黑 #000000，改用 #1a1a1a。", kind: "preference" },
];
const ids: string[] = [];
for (const s of seeds) ids.push(await svc.remember(s.content, s.kind));
check("写入 5 条并返回 5 个 id", ids.length === 5 && new Set(ids).size === 5);
const st0 = svc.store.stats();
check("memories 表 active = 5", st0.active === 5, JSON.stringify(st0));
check("向量已落库（model + dim）", st0.indexed === 5);
const row0 = db.get("SELECT embedding_model, embedding_dim, length(embedding) AS bytes FROM memories WHERE id = ?", ids[0]);
check(
  "BLOB 维度自适应记录正确",
  String(row0?.embedding_model) === svc.embedder.id &&
    Number(row0?.embedding_dim) === svc.embedder.dim &&
    Number(row0?.bytes) === svc.embedder.dim * 4,
  "model=" + row0?.embedding_model + " dim=" + row0?.embedding_dim + " bytes=" + row0?.bytes,
);

// ── 4) recall("配色") ────────────────────────────────────────
section("4. recall 检索");
const hits = await svc.recall("配色");
check("recall('配色') 返回结果", hits.length > 0, "hits=" + hits.length);
const colorHits = hits.filter((h) => h.content.includes("配色"));
check("两条配色记忆都被召回", colorHits.length === 2, "命中 " + colorHits.length + " / 2");
check("分数都 ≥ 阈值 0.1", hits.every((h) => h.score >= 0.1), "top=" + (hits[0] ? hits[0].score.toFixed(3) : "-"));
for (const h of hits) console.log("        " + h.score.toFixed(3) + "  " + h.content.slice(0, 34));
check("命中回写 last_used_at / use_count", svc.store.list({ limit: 5 }).some((m) => m.useCount > 0));
check("空查询返回空数组", (await svc.recall("   ")).length === 0);

// ── 5) retrieveForContext ────────────────────────────────────
section("5. retrieveForContext");
const ctx = await svc.retrieveForContext("首页配色方案");
check("context 非空", ctx.context.length > 0, "len=" + ctx.context.length);
check("context 含 '## Relevant Memories'", ctx.context.includes("## Relevant Memories"));
check("usedMemories 非空", ctx.usedMemories.length > 0, "used=" + ctx.usedMemories.length);
console.log("  ---- 注入片段 ----");
for (const line of ctx.context.split("\n")) console.log("  | " + line);

// ── 6) 写入去重 ──────────────────────────────────────────────
section("6. 写入去重");
const dupId = await svc.remember("  用户喜欢低饱和度的莫兰迪配色，界面留白要多一些。 ");
check("完全相同内容不重复落库", dupId === ids[0] && svc.store.stats().active === 5, "dupId=" + (dupId === ids[0] ? "既有 id" : dupId));
const nearId = await svc.remember("用户喜欢低饱和度的莫兰迪配色，界面留白要多一些哦。", "taste");
check("近似内容按向量去重", nearId === ids[0] && svc.store.stats().active === 5);

// ── 7) 日记 ──────────────────────────────────────────────────
section("7. 日记 / captureDaily");
await svc.captureDaily("smoke 测试：记忆系统自测通过，配色偏好已记录。");
const files2 = await svc.loadFilesForPrompt();
// daily 是 { date, content }[] —— 带上日期是为了让前端能拼出 memory/<date>.md 的路径
const dailyText = files2.daily.map((d) => d.content).join("\n");
check("captureDaily 写入今天日记", files2.daily.length >= 1 && dailyText.includes("smoke 测试"));
check("日记条目带日期（拼路径要用）", files2.daily.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)));

// ── 8) 睡眠流水线 ────────────────────────────────────────────
section("8. runSleep");
const stats = await svc.runSleep({ trigger: "smoke" });
check("runSleep status=ok", stats.status === "ok", "status=" + stats.status + (stats.note ? " note=" + stats.note : ""));
check("examined = 5", stats.examined === 5, "examined=" + stats.examined);
check("无重复 / 过期 / 孤儿", stats.archivedExact + stats.archivedExpired + stats.archivedOrphan === 0);
const runRow = db.get("SELECT * FROM memory_sleep_runs WHERE id = ?", stats.runId);
check("已写 memory_sleep_runs", !!runRow, "runId=" + stats.runId);
check(
  "run 记录字段完整",
  String(runRow?.status) === "ok" && runRow?.ended_at != null && Number(runRow?.examined) === 5,
  "status=" + runRow?.status + " examined=" + runRow?.examined,
);
check("memory_sleep_runs 可累加", Number(db.get("SELECT COUNT(*) AS c FROM memory_sleep_runs")?.c ?? 0) === 1);

// ── 9) 相似度合并 ────────────────────────────────────────────
section("9. 睡眠合并");
const a = await svc.store.add({ content: "用户偏好低饱和度的莫兰迪配色方案，页面留白需要充足。", kind: "taste" });
const b = await svc.store.add({ content: "用户偏好低饱和度的莫兰迪配色方案，页面留白需要足够。", kind: "taste" });
const bandScore = pairCosine(svc, a, b);
console.log("        LLM 判定带候选余弦 = " + bandScore.toFixed(4));
check("候选落在 0.75 ~ 0.95 判定带", bandScore >= 0.75 && bandScore < 0.95, "cos=" + bandScore.toFixed(4));

const noLlm = await svc.runSleep({ trigger: "smoke-no-llm" });
check("无 LLM 时相似合并被跳过", noLlm.merged === 0 && noLlm.archivedSimilarity === 0, "note=" + (noLlm.note ?? "-"));
check("跳过时记录 llm-skip", (noLlm.note ?? "").includes("llm-skip"));
check("两条记忆都还是 active", svc.store.get(a)?.status === "active" && svc.store.get(b)?.status === "active");

const fakeLlm = {
  complete: async (prompt: string): Promise<string> => {
    const idx = [...prompt.matchAll(/^(\d+)\. A=/gm)].map((m) => Number(m[1]));
    return JSON.stringify({ merges: idx });
  },
};
const judged = await svc.runSleep({ trigger: "smoke-llm", llm: fakeLlm });
check(
  "LLM 判定后合并成一条",
  judged.llmChecked >= 1 && judged.llmMerged === 1 && judged.archivedSimilarity === 1,
  "checked=" + judged.llmChecked + " llmMerged=" + judged.llmMerged + " archived=" + judged.archivedSimilarity,
);
const bandArchived = svc.store.get(a)?.status === "archived" ? svc.store.get(a) : svc.store.get(b);
check(
  "归档原因 = llm-merge 且带 mergedInto",
  String(bandArchived?.metadata.archivedReason) === "llm-merge" && typeof bandArchived?.metadata.mergedInto === "string",
  String(bandArchived?.metadata.archivedReason),
);

const c = await svc.store.add({ content: "生成海报时优先使用思源黑体，标题控制在 10 个字以内。", kind: "preference" });
const d = await svc.store.add({ content: "生成海报时优先使用思源黑体，标题控制在 12 个字以内。", kind: "preference" });
const directScore = pairCosine(svc, c, d);
console.log("        直接合并候选余弦 = " + directScore.toFixed(4));
check("候选 ≥ 0.95（默认直接合并阈值）", directScore >= 0.95, "cos=" + directScore.toFixed(4));
const direct = await svc.runSleep({ trigger: "smoke-direct" });
check("> 0.95 直接合并归档", direct.archivedSimilarity >= 1, "archivedSimilarity=" + direct.archivedSimilarity);
const directArchived = svc.store.get(c)?.status === "archived" ? svc.store.get(c) : svc.store.get(d);
check("归档原因 = similarity", String(directArchived?.metadata.archivedReason) === "similarity", String(directArchived?.metadata.archivedReason));
check(
  "合并后只留一条 active",
  [svc.store.get(c)?.status, svc.store.get(d)?.status].filter((s) => s === "active").length === 1,
);

// ── 10) 异常安全 / 维度隔离 ──────────────────────────────────
section("10. 异常安全 / 维度隔离");
const broken = new MemoryService({
  db,
  configDir,
  embedder: {
    id: "boom",
    dim: 8,
    embed: async () => {
      throw new Error("EMBEDDING_DOWN");
    },
  },
});
const safeCtx = await broken.retrieveForContext("配色");
check("embedding 抛错 → context 为空且不抛", safeCtx.context === "" && safeCtx.usedMemories.length === 0);
check("embedding 抛错 → recall 返回空数组", (await broken.recall("配色")).length === 0);
const other = new MemoryService({ db, configDir, embedder: createHashEmbedding(128) });
check("不同 embedding model 互不干扰", (await other.recall("配色")).length === 0);

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
