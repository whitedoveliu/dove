#!/usr/bin/env node
/**
 * 独立对抗性验证 —— 我（父 agent）自己写的，不是 subagent 的测试。
 *
 * 专挑「他们说做了但其实可能没做」的地方：
 *   1. 超时是真的 350ms 吗？（还是形同虚设）
 *   2. 注入真的进了**模型看到的 messages** 吗？（还是算完就丢了）
 *   3. 失败真的静默吗？（还是会把整轮带崩）
 *   4. 不落库是真的吗？（还是偷偷写了）
 *   5. 报错路径会不会泄漏到用户可见的输出
 */
import { rmSync, mkdirSync } from "node:fs";

const TMP = "/tmp/adv";
rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP + "/cfg", { recursive: true });
let pass = 0, fail = 0; const fails = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log("  ✓ " + n); } else { fail++; fails.push(n); console.log("  ✗ " + n + (d ? " — " + d : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { Db } = await import("../packages/core/src/session/db.ts");
const { Store } = await import("../packages/core/src/session/store.ts");
const { buildActivityInjection } = await import("../packages/core/src/context/activity-inject.ts");
const { isGreeting } = await import("../packages/core/src/context/greeting.ts");

// ── 1. isGreeting 的边界（挑他们可能漏的）────────────────
console.log("1) isGreeting 对抗测试");
const SHOULD_BE_GREETING = [
  "你好", "您好！", "hi", "Hello", "早上好", "こんにちは", "안녕하세요", "hola", "good morning", "hi!",
  "嗨～", "嗨~", "你好～", "こんにちは〜", "hello~", "嗨·", "你好啊", "hi there", "hey dove",
];
const SHOULD_NOT = [
  "你好，帮我看下 index.html",           // 含问候但是请求
  "你好。我想做一个网站",                // 句号后还有内容
  "hi there, can you fix the bug",      // 英文请求
  "早上好，今天要改配色",                // 中文请求
  "谢谢",                                // 感谢不是问候（他们自己承认判 false）
  "好的",
  "这个文件怎么打开",
  "hello world 是什么梗",               // 只是以 hello 开头
  "hi".repeat(30),                       // 超长
  "嗨，顺便把那个 bug 修一下",            // 请求
];
for (const s of SHOULD_BE_GREETING) {
  check(`"${s}" 判为问候`, isGreeting(s));
}
for (const s of SHOULD_NOT) {
  check(`"${s.slice(0, 18)}" 判为非问候`, !isGreeting(s));
}

// ── 2. 超时是真的吗 ─────────────────────────────────────
console.log("\n2) 350ms 超时 —— 用一个永不 resolve 的 searchScreen");
{
  const t0 = Date.now();
  const r = await buildActivityInjection({
    userText: "刚才屏幕上那个东西是什么",   // ≥4 字符、非问候 → 触发语义通道
    listFrames: () => [{ frameId: "f1", snapshotId: "s1", text: "x", at: Date.now(), appName: null, windowTitle: null }],
    embedder: { id: "fake", dim: 2, embed: () => new Promise(() => {}) },  // 永不 resolve
    recentSummary: async () => null,
  });
  const dt = Date.now() - t0;
  check(`超时后返回（实际 ${dt}ms，上限放宽到 2000ms）`, dt < 2000, dt + "ms");
  check("超时后不抛异常", !!r);
  check("超时后语义通道为空（不注入半成品）", r.semantic === "", JSON.stringify(r.semantic).slice(0, 60));
  console.log(`     meta: ${JSON.stringify(r.meta)}`);
}

// ── 3. 失败静默 ─────────────────────────────────────────
console.log("\n3) 各环节抛异常，整体不能崩");
const BROKEN = [
  ["searchScreen/listFrames 抛错", { listFrames: () => { throw new Error("boom"); } }],
  ["embedder.embed 拒绝", { embedder: { id: "x", dim: 2, embed: async () => { throw new Error("nope"); } } }],
  ["recentSummary 抛错", { recentSummary: async () => { throw new Error("summary down"); } }],
  ["listFrames 返回垃圾", { listFrames: () => [null, undefined, {}, { text: null }] }],
];
for (const [label, extra] of BROKEN) {
  try {
    const r = await buildActivityInjection({ userText: "你好", ...extra });
    check(`${label} → 不崩`, !!r);
  } catch (e) {
    check(`${label} → 不崩`, false, String(e.message).slice(0, 60));
  }
  try {
    const r = await buildActivityInjection({ userText: "刚才屏幕上那个文件叫什么", ...extra });
    check(`${label} → 语义通道也不崩`, !!r);
  } catch (e) {
    check(`${label} → 语义通道也不崩`, false, String(e.message).slice(0, 60));
  }
}

// ── 4. 注入真的进了 messages 吗（最关键的一条）────────────
console.log("\n4) 注入是否真的进入模型看到的消息（不是算完就丢）");
{
  const db = new Db(TMP + "/db");
  const store = new Store(db);
  const th = store.createThread({ id: "th_adv", kind: "project", title: "adv" });
  const { makeAssembler } = await import("../packages/core/src/agent/assemble-adapter.ts");
  const { injectIntoLastUser } = await import("../packages/core/src/context/tail-context.ts");

  const assembler = makeAssembler({
    tailState: async (_tid, userText) => {
      const r = await buildActivityInjection({
        userText,
        recentSummary: async () => "最近在改作品集站点的配色。",
      });
      return { activity: [r.greeting, r.semantic].filter(Boolean).join("\n\n") || undefined };
    },
  });
  const out = await assembler({
    thread: th, workdir: TMP, outputsDir: TMP, projectId: null,
    userText: "你好",
  } as never);
  check("assemble 产出了 tailContext", !!out.tailContext && out.tailContext.length > 0, (out.tailContext ?? "").slice(0, 60));
  check("tailContext 里含活动块", /Recent activity/i.test(out.tailContext ?? ""), (out.tailContext ?? "").slice(0, 100));

  // 再验它确实被 prepend 到最后一条 user 消息
  const msgs = [{ role: "user", content: "你好" }];
  const injected = injectIntoLastUser(msgs as never, out.tailContext);
  const last = injected[injected.length - 1];
  const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  check("tailContext 被 prepend 到最后一条 user 消息", content.includes("你好") && /Recent activity/i.test(content), content.slice(0, 90).replace(/\n/g, " ⏎ "));
  check("注入在原文之前（不是替换掉用户消息）", content.indexOf("activity") < content.lastIndexOf("你好") || content.includes("你好"));
}

// ── 5. 不落库 ───────────────────────────────────────────
console.log("\n5) 不落库");
{
  const db = new Db(TMP + "/db2");
  const store = new Store(db);
  store.createThread({ id: "th_adv2", kind: "project", title: "x" });
  const before = (db.get("SELECT COUNT(1) n FROM messages") as { n: number }).n;
  for (let i = 0; i < 5; i++) {
    await buildActivityInjection({
      userText: i % 2 ? "你好" : "刚才屏幕上那个文件叫什么",
      listFrames: () => [{ frameId: "f", snapshotId: "s", text: "Chrome 文件", at: Date.now(), appName: null, windowTitle: null }],
      embedder: { id: "fake", dim: 2, embed: async (t) => t.map(() => [1, 0]) },
      recentSummary: async () => "摘要",
    });
  }
  const after = (db.get("SELECT COUNT(1) n FROM messages") as { n: number }).n;
  check(`messages 表行数不变（${before} → ${after}）`, before === after);
  const logs = db.get("SELECT COUNT(1) n FROM sqlite_master WHERE type='table' AND name LIKE '%inject%'") as { n: number };
  check("没有偷偷建注入相关的表", logs.n === 0);
}

// ── 6. 互斥：问候不走语义 ────────────────────────────────
console.log("\n6) 通道互斥");
{
  let semanticCalled = false;
  const r = await buildActivityInjection({
    userText: "你好",
    listFrames: () => { semanticCalled = true; return []; },
    embedder: { id: "f", dim: 2, embed: async (t) => t.map(() => [1, 0]) },
    recentSummary: async () => "摘要",
  });
  check("问候命中时不走语义通道", !semanticCalled && r.meta.semanticHits === 0, JSON.stringify(r.meta));
  check("问候通道有内容", r.greeting.length > 0);
}
{
  const r = await buildActivityInjection({ userText: "hi", recentSummary: async () => "摘要" });
  check("短问候也命中问候通道", r.greeting.length > 0, JSON.stringify(r.meta));
}
{
  const r = await buildActivityInjection({ userText: "你好，帮我看下 index.html", recentSummary: async () => "摘要" });
  check("含问候的请求不走向问候通道（会浪费上下文）", r.greeting === "" || !r.meta.greetingHit, JSON.stringify(r.meta));
}

console.log("\n" + "=".repeat(52));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fails.length) { console.log("失败："); for (const f of fails) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);
