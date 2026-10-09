#!/usr/bin/env node
/**
 * 三条运行时注入通道自测（验收脚本）
 *   cd harness && node --no-warnings scripts/smoke-inject.ts
 *
 * 覆盖：isGreeting 五语种 / 问候通道 / 语义通道（向量腿 + 词袋腿）/ 阈值 /
 *       350ms 超时 / 失败静默 / 不落库 / 短消息与问候互斥 /
 *       接线（tailState + 渲染顺序 + 记忆通道阈值与改写）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../packages/core/src/session/db.ts";
import { Store } from "../packages/core/src/session/store.ts";
import { ActivityStore } from "../packages/core/src/activity/store.ts";
import { buildActivityInjection, SEMANTIC_TITLE } from "../packages/core/src/context/activity-inject.ts";
import { isGreeting } from "../packages/core/src/context/greeting.ts";
import { renderTailContext } from "../packages/core/src/context/tail-context.ts";
import { makeAssembler } from "../packages/core/src/agent/assemble-adapter.ts";
import { injectThresholdFor, MemoryService, rewriteQuery } from "../packages/core/src/memory/index.ts";
import { createHashEmbedding } from "../packages/core/src/memory/embedding.ts";
import { ACTIVITY_INJECT, MEMORY_INJECT_THRESHOLD, MEMORY_INJECT_THRESHOLD_HASH } from "../packages/core/src/constants.ts";
import type { ScreenHit } from "../packages/core/src/memory/screen-index.ts";
import type { Message } from "../packages/core/src/session/types.ts";

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log("  \u2705 " + name); }
  else { fails.push(name + (detail ? " \u2014 " + detail : "")); console.log("  \u274c " + name + (detail ? " \u2014 " + detail : "")); }
}
function section(title: string): void { console.log("\n=== " + title + " ==="); }

// ── 0) 环境：一个内存库装下「会话 + 屏幕 + 记忆」 ──────────────
const configDir = mkdtempSync(join(tmpdir(), "dove-inject-"));
const db = new Db(":memory:");
const store = new Store(db);
const thread = store.createThread({ id: "th_smoke", kind: "home", title: "注入自测" });
const mkMsg = (id: string, role: Message["role"], text: string): Message =>
  ({ id, threadId: thread.id, role, parts: [{ type: "text", text }], createdAt: Date.now() });
store.addMessage(mkMsg("m1", "user", "先放两条历史消息，用来验注入不落库"));
store.addMessage(mkMsg("m2", "assistant", "收到"));

const act = new ActivityStore(db);
const now = Date.now();
const insertFrame = (id: string, windowTitle: string, text: string): string => {
  act.insertSnapshot({
    id, sessionId: "s1", timestamp: now, filePath: "/tmp/" + id + ".png", width: 1, height: 1,
    sizeBytes: 1, trigger: "manual", appName: "Google Chrome", windowTitle,
    hashHex: id, histogram: "[]", diffPct: 0, storageTier: "hot",
  });
  return act.insertOcrFrame({ snapshotId: id, sessionId: "s1", text });
};
insertFrame("snap_a", "index.html — 我的落地页", "文件 编辑 显示 紫水晶协议 dashboard 首页配色方案 莫兰迪灰 留白 组件库 按钮间距 落地页首屏");
insertFrame("snap_b", "系统设置", "文件 编辑 显示 帮助 关于本机 系统设置 网络 蓝牙 打印机 辅助功能 键盘 鼠标");
// snap_v：和查询**没有任何字面重合**，只有语义相关 —— 专门用来验向量腿
insertFrame("snap_v", "深色主题预览", "深色主题预览：整体色调偏冷，留白充足，四角圆润");

const searchScreen = (q: string, limit: number): ScreenHit[] =>
  act.searchScreen(q, { limit, since: Date.now() - ACTIVITY_INJECT.semanticWindowMs });
let listCalls = 0;
const listFrames = (since: number, limit: number) => { listCalls++; return act.listRecentOcrFrames(since, limit); };
const countMessages = (): number => Number(db.get("SELECT COUNT(1) AS n FROM messages")?.n ?? -1);
const countFrames = (): number => Number(db.get("SELECT COUNT(1) AS n FROM activity_ocr_frames")?.n ?? -1);

// ── 1) isGreeting：五语种正例 + 反例 ──────────────────────────
section("1. isGreeting（中/英/日/韩/西 + 反例）");
const positives: [string, string[]][] = [
  ["中文", ["你好", "您好！", "在吗", "早上好", "好久不见"]],
  ["英文", ["hi", "Hello!", "hey there", "good morning", "What's up?"]],
  ["日文", ["こんにちは", "おはようございます", "やあ"]],
  ["韩文", ["안녕하세요", "안녕", "반가워요"]],
  ["西文", ["hola", "buenos días", "¿qué tal?", "buenas tardes"]],
];
for (const [lang, list] of positives) {
  const bad = list.filter((s) => !isGreeting(s));
  check(lang + " 正例 " + list.length + " 条全部判 true", bad.length === 0, "漏判：" + JSON.stringify(bad));
}
const negatives = [
  "你好，帮我看下 index.html",
  "hi，帮我把首页改一下",
  "Hello, can you fix the login button?",
  "早上好，今天有什么安排",
  "在吗？帮我看下这个报错",
  "谢谢你",
  "ok",
  "这屏幕上的配色再压暗一档",
  "你好".repeat(20),
];
const wrong = negatives.filter((s) => isGreeting(s));
check("反例 " + negatives.length + " 条全部判 false", wrong.length === 0, "误判：" + JSON.stringify(wrong));

// ── 2) 问候通道：摘要 + 硬性指令块 ────────────────────────────
section("2. 问候通道");
const summary48h = "最近 48 小时：\n- 01:12–02:40 Xcode — assemble-adapter.ts｜在给尾部上下文加注入";
const greet = await buildActivityInjection({ userText: "你好呀", recentSummary: async () => summary48h });
check("meta.greetingHit = true", greet.meta.greetingHit === true);
check("注入了最近活动摘要", greet.greeting.includes("assemble-adapter.ts"));
check("含硬性指令：必须提到一件具体的事", greet.greeting.includes("必须提到一件具体的事"));
check("含硬性指令：禁止空话", greet.greeting.includes("禁止") && greet.greeting.includes("How can I help?"));
check("含硬性指令：禁止复述摘要原文", greet.greeting.includes("禁止复述摘要原文"));
check("问候命中时不走语义通道", greet.semantic === "" && greet.meta.skipped === "greeting");
check("问候不做向量（没 embedder 也照样出块）", greet.greeting.length > 0 && greet.meta.path === undefined);
const greetNoSummary = await buildActivityInjection({ userText: "hello", recentSummary: async () => null });
check("无摘要时仍给兜底硬性指令", greetNoSummary.greeting.includes("禁止") && greetNoSummary.greeting.length > 0);

// ── 3) 语义通道（词袋腿）：相关消息命中 top3 + 固定标题 ────────
section("3. 语义通道 · 词袋腿（命中）");
const sem = await buildActivityInjection({ userText: "首页的配色方案再调一下", searchScreen });
check("注入块标题固定", sem.semantic.startsWith(SEMANTIC_TITLE), sem.semantic.slice(0, 60));
check("命中了屏幕帧正文", sem.semantic.includes("莫兰迪灰") && sem.semantic.includes("落地页首屏"));
check("命中条数 = " + sem.meta.semanticHits, sem.meta.semanticHits === 1, "hits=" + sem.meta.semanticHits);
check("带上了 app / 窗口上下文", sem.semantic.includes("Google Chrome") && sem.semantic.includes("index.html"));
check("没有 embedder → 走词袋腿", sem.meta.path === "lexical", String(sem.meta.path));
check("命中时问候块为空（互斥）", sem.greeting === "");

// ── 4) 语义通道：阈值生效（原始检索有命中，注入却为空）───────
section("4. 语义通道（阈值）");
const rawHits = searchScreen("这个文件怎么打开", 6);
const thr = await buildActivityInjection({ userText: "这个文件怎么打开", searchScreen });
check("原始检索确实有命中（不是索引为空）", rawHits.length > 0, "raw=" + rawHits.length);
check("只蹭到通用词 → 注入为空（词袋阈值 " + ACTIVITY_INJECT.semanticThresholdLexical + "）",
  thr.semantic === "", JSON.stringify(rawHits[0]?.matched));
check("无关消息完全查不到 → 注入为空", (await buildActivityInjection({ userText: "量子纠缠退相干实验", searchScreen })).semantic === "");

// ── 5) 超时：350ms 放弃语义通道 ──────────────────────────────
section("5. 350ms 超时");
const never = (() => new Promise<ScreenHit[]>(() => { /* 永不 resolve */ })) as never;
const t0 = Date.now();
const to = await buildActivityInjection({ userText: "首页的配色方案再调一下", searchScreen: never });
const elapsed = Date.now() - t0;
check("约 350ms 返回（实测 " + elapsed + "ms）", elapsed >= 330 && elapsed <= 900, elapsed + "ms");
check("超时 → 语义为空且 meta.skipped=timeout", to.semantic === "" && to.meta.skipped === "timeout", String(to.meta.skipped));
check("超时不抛异常（能走到这一行即证明）", true);

// ── 6) 失败静默 ───────────────────────────────────────────────
section("6. 失败静默");
const boom = (() => { throw new Error("SCREEN_INDEX_DOWN"); }) as never;
const r6 = await buildActivityInjection({ userText: "首页的配色方案再调一下", searchScreen: boom });
check("检索抛错 → 整体仍返回且语义为空", r6.semantic === "" && r6.meta.skipped === "search-error", String(r6.meta.skipped));
const r6b = await buildActivityInjection({ userText: "你好", searchScreen: boom, recentSummary: async () => "刚才在改 index.html" });
check("检索炸了，问候通道照常", r6b.greeting.includes("刚才在改 index.html") && r6b.meta.greetingHit === true);
const r6c = await buildActivityInjection({ userText: "你好", recentSummary: async () => { throw new Error("DB_DOWN"); } });
check("摘要抛错 → 问候块降级但不为空", r6c.greeting.includes("禁止") && r6c.meta.skipped === "greeting-summary-error", String(r6c.meta.skipped));

// ── 7) 不落库 ─────────────────────────────────────────────────
section("7. 不落库");
const msgBefore = countMessages();
const frameBefore = countFrames();
await buildActivityInjection({ userText: "首页的配色方案再调一下", searchScreen });
await buildActivityInjection({ userText: "你好", searchScreen, recentSummary: async () => summary48h });
check("messages 表行数不变（" + msgBefore + "）", countMessages() === msgBefore, String(countMessages()));
check("activity_ocr_frames 行数不变（" + frameBefore + "）", countFrames() === frameBefore, String(countFrames()));
const stored = store.recentMessages(thread.id, 10).map((m) => JSON.stringify(m.parts)).join("\n");
check("历史消息里搜不到注入正文", !stored.includes("Relevant past activity") && !stored.includes("莫兰迪灰"));

// ── 8) 短消息（<4 字符）不走语义通道 ──────────────────────────
section("8. 短消息");
let searched = 0;
const spy = (q: string, limit: number): ScreenHit[] => { searched++; return searchScreen(q, limit); };
const short = await buildActivityInjection({ userText: "改下", searchScreen: spy });
check("2 字符 → 语义为空且 skipped=too-short", short.semantic === "" && short.meta.skipped === "too-short", String(short.meta.skipped));
check("短消息根本没有发起检索", searched === 0, "searched=" + searched);

// ── 9) 问候与语义互斥（问候不检索）────────────────────────────
section("9. 问候不走语义");
searched = 0;
const g9 = await buildActivityInjection({ userText: "早上好", searchScreen: spy, recentSummary: async () => null });
check("问候命中 → 不发起检索", searched === 0 && g9.meta.skipped === "greeting", "searched=" + searched);
check("问候命中 → 语义块为空", g9.semantic === "");

// ── 10) 向量腿：真向量可用时走向量，不可用时降级词袋 ──────────
section("10. 向量腿 / 词袋降级");
/** 假向量：把话题映射到三个正交维度（模拟真 BGE 的语义聚类能力） */
const fakeVec = (t: string): number[] => {
  const v = [0, 0, 0.01];
  if (/配色|颜色|色调|色|莫兰迪|暗|留白/.test(t)) v[0] = 1;
  if (/字体|海报|黑体|标题/.test(t)) v[1] = 1;
  if (/量子|纠缠|噪声/.test(t)) v[2] = 0.5;
  return v;
};
let embedCalls = 0;
const fakeEmbedder = {
  id: "fake-bge-zh", dim: 3,
  embed: async (texts: string[]): Promise<number[][]> => { embedCalls += texts.length; return texts.map(fakeVec); },
};
const Q_VEC = "把这个配色再压暗一档好不好";
const lexOnly = await buildActivityInjection({ userText: Q_VEC, searchScreen });
check("词袋腿：与查询无字面重合 → 一条都不注入", lexOnly.semantic === "", String(lexOnly.meta.semanticHits));
const vec = await buildActivityInjection({ userText: Q_VEC, searchScreen, embedder: fakeEmbedder, listFrames });
check("有 embedder → 走向量腿", vec.meta.path === "vector", String(vec.meta.path));
check("embed 真的被调用了", embedCalls > 0, "calls=" + embedCalls);
check("listFrames 候选池被调用了", listCalls > 0, "calls=" + listCalls);
check("向量腿命中了无语字面重合的帧", vec.semantic.includes("整体色调偏冷"), vec.semantic.slice(0, 80));
check("向量腿仍然过滤掉无关帧", !vec.semantic.includes("系统设置"));
check("向量腿标题同样固定", vec.semantic.startsWith(SEMANTIC_TITLE));
const noEmbedder = await buildActivityInjection({ userText: "首页的配色方案再调一下", searchScreen, listFrames });
check("没有 embedder → 自动降级词袋且仍工作", noEmbedder.meta.path === "lexical" && noEmbedder.semantic.includes("莫兰迪灰"));
const badEmbedder = { id: "boom", dim: 3, embed: async (): Promise<number[][]> => { throw new Error("ONNX_DOWN"); } };
const degraded = await buildActivityInjection({ userText: "首页的配色方案再调一下", searchScreen, embedder: badEmbedder, listFrames });
check("向量后端炸了 → 降级词袋仍命中", degraded.meta.path === "lexical" && degraded.semantic.includes("莫兰迪灰"), String(degraded.meta.path));

// ── 11) 向量腿通了但 0 命中：不回退词袋；24h 窗口两条腿都生效 ──
section("11. 向量腿一致性 / 24h 窗口");
const Q_ORTHO = "把落地页首屏的间距再调一版";
const lexControl = await buildActivityInjection({ userText: Q_ORTHO, searchScreen });
check("对照组：这条消息在词袋腿上本来是命中的", lexControl.semantic.includes("莫兰迪灰"), String(lexControl.meta.semanticHits));
/** 故意让 query 与所有帧正交：验「向量腿通了但 0 命中」不回落词袋（两条腿阈值语义不混） */
const ortho = { id: "ortho-test", dim: 4, embed: async (texts: string[]): Promise<number[][]> => texts.map((t) => (t === Q_ORTHO ? [0, 1, 0, 0] : [1, 0, 0, 0])) };
const orthoRes = await buildActivityInjection({ userText: Q_ORTHO, searchScreen, embedder: ortho, listFrames });
check("向量腿 0 命中 → 注入为空且 path=vector（不回落词袋）", orthoRes.semantic === "" && orthoRes.meta.path === "vector", String(orthoRes.meta.path));
const old48h = Date.now() - 48 * 3_600_000;
db.run("UPDATE activity_ocr_frames SET created_at = ? WHERE snapshot_id IN ('snap_a','snap_b')", old48h);
db.run("UPDATE activity_ocr_terms SET at = ? WHERE frame_id IN (SELECT id FROM activity_ocr_frames WHERE snapshot_id IN ('snap_a','snap_b'))", old48h);
const winLex = await buildActivityInjection({ userText: "首页的配色方案再调一下", searchScreen });
check("48h 前的帧：词袋腿按 24h 窗口忽略", winLex.semantic === "", String(winLex.meta.semanticHits));
const winVec = await buildActivityInjection({ userText: "把这个配色再压暗一档好不好", searchScreen, embedder: fakeEmbedder, listFrames });
check("48h 前的帧：向量腿按 24h 窗口忽略", !winVec.semantic.includes("莫兰迪灰"));
check("24h 内的帧照常命中", winVec.semantic.includes("整体色调偏冷"));

// ── 12) 接线：tailState 收 userText / 渲染顺序 / 记忆通道 ──────
section("12. 接线");
let seenThread = "", seenText = "";
const assembler = makeAssembler({
  tailState: async (threadId: string, userText: string) => { seenThread = threadId; seenText = userText; return { activity: "## ACTIVITY_BLOCK" }; },
});
const assembled = await assembler({ thread, projectId: null, userText: "你好呀", workdir: "/tmp/demo", outputsDir: "/tmp/demo/outputs" });
check("tailState 收到 threadId", seenThread === thread.id);
check("tailState 收到本轮 userText", seenText === "你好呀", seenText);
check("activity 渲染进 mt", assembled.tailContext.includes("## ACTIVITY_BLOCK"));
check("activity 在时间锚之后", assembled.tailContext.indexOf("## ACTIVITY_BLOCK") > assembled.tailContext.indexOf("Authoritative Local DateTime"));
const withTasks = renderTailContext({ date: new Date(), activity: "## ACTIVITY_BLOCK", tasks: [{ title: "T" }] });
check("activity 排在其它块之前", withTasks.indexOf("## ACTIVITY_BLOCK") < withTasks.indexOf("## Tasks"));

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

// 真 ONNX（装了模型才有）：同一批断言在真向量上再跑一遍；没装就跳过，不让环境把验收搞挂
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
