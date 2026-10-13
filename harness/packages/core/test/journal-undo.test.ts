/**
 * 线程日志（journal）+ 撤销 + 工具结果老化
 *
 * 这组测试钉的是三件「静默出错」的事：
 * ① **日志必须能当证据**：行号就是序号、正文不截断（大正文落 blob 而不是被切掉 2000 字符）、
 *    坏文件读时截断到完整行且 `.bak` 只写一次 —— 任何一条静默失效，「模型可见 ⟺ 已记录」就是空话；
 * ② **撤销不破配对**：撤销后的历史重建出来仍要满足铁律一（每个 tool_call 都有配对的 tool 消息），
 *    否则 provider 直接拒绝请求，而错误现场离撤销动作已经很远；
 * ③ **老化只换正文**：结构、顺序、配对、tool_calls 的 arguments 一个字节都不许动（铁律二）。
 *
 * 用真实 Db + 真实 Store + 真实 planAging，落盘全在临时目录里。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/session/db.ts";
import { Store, isRealUserMessage } from "../src/session/store.ts";
import { openJournal, openJournalFresh, journalFile, JOURNAL_BLOB_AFTER_CHARS } from "../src/session/journal.ts";
import { toWireHistory } from "../src/agent/wire-history.ts";
import { renderRecoveryFooter } from "../src/context/recovery-footer.ts";
import { planAging } from "../src/tools/result-aging.ts";
import { TOOL_RESULT_AGING_MIN_CHARS } from "../src/constants.ts";
import type { Message, Part, ToolPart } from "../src/session/types.ts";

const DATE = "2026-01-02";
const tmp = (): string => mkdtempSync(join(tmpdir(), "dove-journal-"));

/** 自增时钟：created_at 严格递增，否则「最后 N 轮」的顺序在测试里就不确定了 */
let clock = 1_000;
const tick = (): number => ++clock;

function userMsg(threadId: string, id: string, text: string, over: Partial<Message> = {}): Message {
  return { id, threadId, role: "user", parts: [{ type: "text", text }], createdAt: tick(), ...over };
}

function assistantMsg(threadId: string, id: string, parts: Part[]): Message {
  return { id, threadId, role: "assistant", parts, createdAt: tick() };
}

function toolPart(toolCallId: string, toolName: string, output: unknown): ToolPart {
  return { type: `tool-${toolName}`, toolCallId, toolName, state: "output-available", input: { command: "echo hi" }, output };
}

function seed(cfg: string, threadId: string): { db: Db; store: Store } {
  const db = new Db(":memory:");
  const store = new Store(db, { journalFor: (id) => openJournal(cfg, id, DATE), planAging });
  store.createThread({ id: threadId, kind: "project", title: "测试" });
  return { db, store };
}

// ── 日志：行号就是序号 ─────────────────────────────────

test("日志：第 1 行是 metadata，seq 从 1 连续，重启后接着走不回退", () => {
  const cfg = tmp();
  const j = openJournal(cfg, "th_seq", DATE);
  assert.equal(j.path, journalFile(cfg, "th_seq", DATE));
  assert.equal(j.path, join(cfg, "logs", "threads", "th_seq", `${DATE}.jsonl`));

  const meta = j.readAll()[0]!;
  assert.equal(meta.type, "metadata");
  assert.equal(meta.protocol_version, 1);
  assert.ok(meta.created_at, "metadata 必须带 created_at");
  assert.equal(meta.seq, 1, "第 1 行 = seq 1");

  j.append("turn_start", { userText: "一" });
  j.append("tool_result", { tool: "Read" });
  assert.equal(j.seq, 3);
  assert.deepEqual(j.readAll().map((r) => r.seq), [1, 2, 3], "seq 必须连续");
  assert.deepEqual(j.readLines(2, 2).map((r) => r.type), ["turn_start"], "readLines 按行号取");
  assert.deepEqual(j.readRecent(2).map((r) => r.type), ["turn_start", "tool_result"]);

  const j2 = openJournalFresh(cfg, "th_seq", DATE);   // 重启 = 新进程 = 新句柄（进程内的 openJournal 是**缓存复用**的，见下一条断言）
  assert.equal(j2.seq, 3, "重启后 seq 不许回退");
  const stale = openJournalFresh(cfg, "th_seq", DATE); // 同时存在的第二个写入点
  j2.append("turn_end", {});
  assert.equal(j2.seq, 4);
  stale.append("turn_start", {});                     // 它打开时只看到 3 行
  assert.equal(stale.seq, 5, "第二个写入点接着行号走，不许重号");
  const seqs = readFileSync(j.path, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { seq: number }).seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5], "物理行号 == seq 字段");

  // 缓存复用：同参数再要一次必须拿到**同一个**句柄 —— 否则每轮都要整读一遍日志文件数行号
  // （构造函数 readFileSync + 逐行）；多写入点仍然安全，因为 append 前的 #sync 会按文件大小重数。
  assert.equal(openJournal(cfg, "th_seq", DATE), j, "openJournal 同参数必须返回同一个实例");

  const ptr = j2.recoveryInfo(2);
  assert.equal(ptr.logPath, j.path);
  assert.equal(ptr.endLine, 5);
  assert.equal(ptr.startLine, 4, "区间不许从 metadata 那行起（指针会把模型引到一行元数据上）");
  assert.equal(openJournal(cfg, "th_seq", DATE).recoveryInfo(200).startLine, 2);

  // recoveryInfo → renderRecoveryFooter（Kimi 那套 ### Context Recovery 段）
  // ⚠️ recoveryInfo 给的永远是「最近 n 行」= **估计**（省了标记就只能估），
  //    所以文案写成近似。要精确的区间用 lastWindow()（压缩时落窗口标记）——
  //    那条路径的精确文案见 journal-window.test.ts。
  const footer = renderRecoveryFooter(j2.recoveryInfo(2));
  assert.ok(footer.includes(j.path), "指针里必须有日志路径");
  assert.match(footer, /被摘要的大致是第 4–5 行（近似区间：最近 2 行/);
  assert.match(footer, /sed -n '812p'/, "读法要一起给（一行就是一条完整 JSON）");
});

test("日志：大正文落 blob（不是截断），blob 内容 == 原文", () => {
  const cfg = tmp();
  const j = openJournal(cfg, "th_blob", DATE);
  const big = "行".repeat(JOURNAL_BLOB_AFTER_CHARS) + "尾部哨兵";
  j.append("tool_result", { toolCallId: "c1", output: big, small: "原样" });
  j.append("tool_result", { nested: { list: [big] } });

  const rec = j.readLines(2, 2)[0]!;
  const ref = rec.data!.output as { blob: string; chars: number; sha1: string };
  assert.equal(typeof ref, "object", "超长字符串必须换成指针");
  assert.match(ref.blob, /^logs\/blobs\/[0-9a-f]{40}\.txt$/, "blob 路径必须相对 configDir");
  assert.equal(ref.chars, big.length);
  assert.ok(existsSync(join(cfg, ref.blob)), "blob 必须真的落盘");
  assert.equal(readFileSync(join(cfg, ref.blob), "utf8"), big, "blob 内容必须逐字节等于原文");
  assert.equal(rec.data!.small, "原样", "小字符串原样留在行里");
  const nested = (j.readLines(3, 3)[0]!.data!.nested as { list: { blob: string }[] }).list[0]!;
  assert.equal(readFileSync(join(cfg, nested.blob), "utf8"), big, "嵌套里的长字符串一样要走 blob");

  const raw = readFileSync(j.path, "utf8");
  assert.ok(!raw.includes("字符已省略") && !raw.includes("__truncated"), "旧日志那套 2000 字符截断不许出现在新日志里");
  assert.ok(!raw.includes("尾部哨兵"), "正文不该整段留在行里（那样一行就上万字符了）");
});

test("日志：坏文件读时修复 —— 截到最后一个完整行，.bak 只写一次、永不覆盖", () => {
  const cfg = tmp();
  const j = openJournal(cfg, "th_bad", DATE);
  j.append("turn_start", { a: 1 });
  j.append("turn_end", { b: 2 });
  appendFileSync(j.path, '{"v":1,"seq":4,"type":"tool_res');   // 写到一半就崩了
  const damaged1 = readFileSync(j.path, "utf8");
  const bak = j.path + ".bak";

  // 修复发生在**打开**这一刻，而 openJournal 在同进程里返回缓存句柄 → 模拟重启要显式开新的
  const j2 = openJournalFresh(cfg, "th_bad", DATE);
  assert.deepEqual(j2.readAll().map((r) => r.type), ["metadata", "turn_start", "turn_end", "journal.repair"],
    "只返回完整行（坏行截掉，修复本身留一条收据）");
  assert.equal(j2.lastRepair?.bakWritten, true);
  assert.equal(readFileSync(bak, "utf8"), damaged1, ".bak 里是损坏现场的原始全文");
  assert.equal(j2.seq, 4, "修好后 seq == 行数，接着往下走");
  j2.append("turn_start", {});
  assert.equal(j2.seq, 5);
  assert.ok(!readFileSync(j.path, "utf8").includes("tool_res"), "坏行已从主文件里截掉");

  // 第二次损坏：.bak 已经在了 → 不许覆盖（内容与 mtime 都不许变），坏行原文改走记录
  const bakStat = statSync(bak);
  appendFileSync(j.path, "{oops\n");
  const j3 = openJournalFresh(cfg, "th_bad", DATE);
  assert.equal(j3.lastRepair?.bakWritten, false, "第二次损坏不许覆盖 .bak");
  assert.equal(readFileSync(bak, "utf8"), damaged1, ".bak 内容不变");
  assert.equal(statSync(bak).mtimeMs, bakStat.mtimeMs, ".bak 的 mtime 不变");
  const lastRepair = j3.readAll().filter((r) => r.type === "journal.repair").at(-1)!;
  assert.equal(lastRepair.data!.damaged, "{oops", "写不成 .bak 时坏行原文落成记录 —— 证据没有丢");
});

// ── 撤销：append-only ─────────────────────────────────

test("撤销：3 轮 → 只撤最后 1 轮；读历史里那轮消失，磁盘上的行还在（undone_at）", () => {
  const cfg = tmp();
  const { db, store } = seed(cfg, "th_undo");
  for (let i = 1; i <= 3; i++) {
    store.addMessage(userMsg("th_undo", `u${i}`, `第 ${i} 轮`));
    store.addMessage(assistantMsg("th_undo", `a${i}`, [{ type: "step-start" }, toolPart(`c${i}`, "Bash", { stdout: `输出 ${i}` })]));
  }
  assert.equal(store.undoableTurns("th_undo"), 3);

  const r = store.undoTurns("th_undo", 1);
  assert.deepEqual([r.undone, r.available, r.fromMessageId], [1, 3, "u3"]);
  assert.equal(r.messages, 2, "u3 与它之后的 a3 一起撤");
  assert.equal(store.undoableTurns("th_undo"), 2);
  assert.deepEqual(store.recentMessages("th_undo", 60).map((m) => m.id), ["u1", "a1", "u2", "a2"], "模型看的历史里那轮没了");

  const all = store.listMessages("th_undo", 60);
  assert.equal(all.length, 6, "一行都没删");
  assert.deepEqual(all.filter((m) => m.undoneAt !== undefined).map((m) => m.id), ["u3", "a3"], "标记落在 undone_at 上");
  assert.ok((all.find((m) => m.id === "a3")!.undoneAt ?? 0) > 0);

  // 撤销记录进了线程日志（日志里只多了一行，前后行一个字都没被改写）
  const j = openJournal(cfg, "th_undo", DATE);
  const undo = j.readAll().find((rec) => rec.type === "context.undo")!;
  assert.equal(undo.data!.turns, 1);
  assert.equal(undo.data!.fromMessageId, "u3");
  assert.equal(undo.data!.availableBefore, 3);
  assert.equal(undo.seq, 2, "日志里只有 metadata + 这一条撤销记录");
  assert.equal(readFileSync(j.path, "utf8").split("\n").filter(Boolean).length, 2);
  db.close();
});

test("撤销：超出可用轮数 → 说清差多少，且不动作", () => {
  const cfg = tmp();
  const { db, store } = seed(cfg, "th_over");
  for (let i = 1; i <= 3; i++) {
    store.addMessage(userMsg("th_over", `u${i}`, `第 ${i} 轮`));
    store.addMessage(assistantMsg("th_over", `a${i}`, [{ type: "step-start" }, toolPart(`c${i}`, "Read", { ok: i })]));
  }
  const before = store.listMessages("th_over", 60).map((m) => m.id);
  const r = store.undoTurns("th_over", 5);
  assert.equal(r.undone, 0);
  assert.equal(r.available, 3);
  assert.match(r.reason ?? "", /只有 3 轮可撤销/);
  assert.match(r.reason ?? "", /请求了 5 轮/);
  assert.match(r.reason ?? "", /差 2 轮/, "必须说清差多少，用户才知道该少撤几轮");
  assert.deepEqual(store.listMessages("th_over", 60).map((m) => m.id), before, "不动作：一条都没标");
  assert.equal(store.listMessages("th_over", 60).filter((m) => m.undoneAt).length, 0);
  assert.ok(!existsSync(journalFile(cfg, "th_over", DATE)), "没动作就不该顺手建日志");

  const empty = seed(cfg, "th_empty").store;
  empty.addMessage({ id: "inj", threadId: "th_empty", role: "user", origin: "injection", parts: [{ type: "text", text: "注入的提醒" }], createdAt: tick() });
  const r2 = empty.undoTurns("th_empty", 1);
  assert.equal(r2.available, 0);
  assert.match(r2.reason ?? "", /没有可撤销/);
  db.close();
});

test("撤销：重建 wire 后 assistant.tool_calls 与 tool 消息一一配对（铁律一）", () => {
  const cfg = tmp();
  const { db, store } = seed(cfg, "th_pair");
  // 三轮：① 并行两次调用 ② 两步 + 中途注入 ③ 文本 + 一次调用
  store.addMessage(userMsg("th_pair", "u1", "并行两个"));
  store.addMessage(assistantMsg("th_pair", "a1", [{ type: "step-start" }, toolPart("p1", "Read", { a: 1 }), toolPart("p2", "Read", { b: 2 })]));
  store.addMessage(userMsg("th_pair", "u2", "分两步"));
  store.addMessage(assistantMsg("th_pair", "a2", [
    { type: "step-start" }, toolPart("q1", "Bash", { ok: 1 }),
    { type: "injection", text: "<system-reminder>提醒</system-reminder>" },
    { type: "step-start" }, { type: "text", text: "好" }, toolPart("q2", "Bash", { ok: 2 }),
  ]));
  store.addMessage(userMsg("th_pair", "u3", "再来一个"));
  store.addMessage(assistantMsg("th_pair", "a3", [{ type: "step-start" }, toolPart("r1", "Write", { ok: 1 })]));

  const check = (label: string, expectedCalls: number): void => {
    const wire = toWireHistory(store.recentMessages("th_pair", 60), "th_pair");
    const called = new Set<string>();
    let calls = 0;
    let tools = 0;
    for (const m of wire) {
      if (m.role === "assistant") for (const c of m.tool_calls ?? []) { called.add(c.id); calls++; }
      if (m.role === "tool") {
        tools++;
        assert.ok(called.has(m.tool_call_id ?? ""), `${label}：孤儿 tool 消息 ${m.tool_call_id}`);
      }
    }
    assert.equal(calls, tools, `${label}：每个 tool_call 必须有一条配对的 tool 消息`);
    assert.equal(calls, expectedCalls, `${label}：这一轮里真正被调用的次数`);
  };
  check("撤销前", 5);
  store.undoTurns("th_pair", 1);
  check("撤 1 轮后", 4);
  store.undoTurns("th_pair", 1);
  check("撤 2 轮后", 2);   // 第 2 轮是两步两次调用，一次撤掉
  store.undoTurns("th_pair", 1);
  check("撤 3 轮后", 0);
  assert.deepEqual(store.recentMessages("th_pair", 60).map((m) => m.id), [], "三轮全撤：历史为空");
  assert.equal(store.listMessages("th_pair", 60).length, 6, "撤销从不删行");
  db.close();
});

test("撤销：注入与压缩产物不算「真实用户消息」，边界落在人说的那条上", () => {
  const cfg = tmp();
  const { db, store } = seed(cfg, "th_real");
  store.addMessage({ id: "inj", threadId: "th_real", role: "user", origin: "injection", variant: "swarm-mode", parts: [{ type: "text", text: "<system-reminder>模式已切换</system-reminder>" }], createdAt: tick() });
  store.addMessage(userMsg("th_real", "u1", "真的问题"));
  store.addMessage(assistantMsg("th_real", "a1", [{ type: "step-start" }, toolPart("c1", "Read", { ok: 1 })]));
  store.addMessage({ id: "cp", threadId: "th_real", role: "user", parts: [{ type: "text", text: "[Context: 更早的对话已被压缩（原文已移出上下文）。]" }], createdAt: tick() });

  assert.equal(isRealUserMessage(userMsg("th_real", "x", "人话")), true);
  assert.equal(isRealUserMessage({ id: "y", threadId: "th_real", role: "user", parts: [{ type: "text", text: "<system-reminder>只有提醒</system-reminder>" }], createdAt: tick() }), false, "纯提醒是注入");
  assert.equal(isRealUserMessage({ id: "z", threadId: "th_real", role: "assistant", parts: [{ type: "text", text: "不是用户" }], createdAt: tick() }), false);

  assert.equal(store.undoableTurns("th_real"), 1, "注入与压缩产物都不算轮");
  const r = store.undoTurns("th_real", 1);
  assert.equal(r.fromMessageId, "u1", "边界落在真实用户消息上，而不是最后那条压缩产物");
  assert.deepEqual(store.recentMessages("th_real", 60).map((m) => m.id), ["inj"], "注入留着（它在边界之前）");
  assert.notEqual(store.listMessages("th_real", 60).find((m) => m.id === "cp")!.undoneAt, undefined, "边界之后的一切一起撤");
  db.close();
});

test("撤销：created_at 撞在同一毫秒时按 rowid 兜底（不许切错轮）", () => {
  const cfg = tmp();
  const { db, store } = seed(cfg, "th_tie");
  // 真实里一轮的多条消息可以落在同一毫秒（子步骤密集时），这时 order by created_at 不足以排序
  for (let i = 1; i <= 3; i++) {
    store.addMessage({ id: `u${i}`, threadId: "th_tie", role: "user", parts: [{ type: "text", text: `第 ${i} 轮` }], createdAt: 500 });
    store.addMessage({ id: `a${i}`, threadId: "th_tie", role: "assistant", parts: [{ type: "step-start" }, toolPart(`c${i}`, "Bash", { ok: i })], createdAt: 500 });
  }
  const r = store.undoTurns("th_tie", 1);
  assert.equal(r.fromMessageId, "u3");
  assert.deepEqual(store.listMessages("th_tie", 60).filter((m) => m.undoneAt).map((m) => m.id), ["u3", "a3"]);
  assert.equal(store.undoableTurns("th_tie"), 2);
  db.close();
});

test("迁移：没有 undone_at 列的老库能直接打开（自动补列，不要求删库）", () => {
  const file = join(tmp(), "legacy.db");
  const db = new Db(file);
  const store = new Store(db);
  store.createThread({ id: "th_legacy", kind: "project", title: "老库" });
  store.addMessage(userMsg("th_legacy", "u1", "老消息"));
  store.addMessage(assistantMsg("th_legacy", "a1", [{ type: "step-start" }, toolPart("c1", "Read", { ok: 1 })]));
  db.run("ALTER TABLE messages DROP COLUMN undone_at");      // 退回升级前的形状
  db.close();

  const db2 = new Db(file);
  const has = (): boolean => db2.all("PRAGMA table_info(messages)").some((c) => String(c.name) === "undone_at");
  assert.equal(has(), false, "先确认这确实是个老库");
  const store2 = new Store(db2);                              // ← 迁移发生在这里
  assert.equal(has(), true, "打开时自动补列");
  assert.deepEqual(store2.recentMessages("th_legacy", 60).map((m) => m.id), ["u1", "a1"], "老数据照常读得到");
  assert.equal(store2.undoTurns("th_legacy", 1).undone, 1);
  assert.deepEqual(store2.recentMessages("th_legacy", 60), [], "撤销在老库上一样生效");
  assert.equal(store2.listMessages("th_legacy", 60).filter((m) => m.undoneAt).length, 2);
  db2.close();
});

// ── 工具结果老化 ───────────────────────────────────────

/** 造一条「大结果 + 后面又走了 8 步」的历史：那条结果已经够老（> TOOL_RESULT_AGING_AFTER_STEPS 步） */
function bigOldThread(store: Store, threadId: string, big: string): void {
  store.addMessage(userMsg(threadId, "u1", "读个大文件"));
  store.addMessage(assistantMsg(threadId, "a1", [{ type: "step-start" }, toolPart("old", "Read", { content: big })]));
  for (let i = 0; i < 8; i++) {
    store.addMessage(userMsg(threadId, `u${i + 2}`, `第 ${i + 2} 轮`));
    store.addMessage(assistantMsg(threadId, `a${i + 2}`, [{ type: "step-start" }, toolPart(`s${i}`, "Bash", { stdout: "ok" })]));
  }
}

test("老化：够老又够大的 tool 正文换成指针；落盘、顺序、配对、重建口径全不变", async () => {
  const cfg = tmp();
  const ws = tmp();
  const { db, store } = seed(cfg, "th_age");
  const big = "B".repeat(TOOL_RESULT_AGING_MIN_CHARS + 500);
  bigOldThread(store, "th_age", big);

  const before = toWireHistory(store.recentMessages("th_age", 60), "th_age");
  const shape = (w: typeof before): string => JSON.stringify(w.map((m) => [
    m.role, m.tool_call_id ?? "",
    m.tool_calls?.map((c) => `${c.id}:${c.function.name}:${c.function.arguments}`) ?? "",
  ]));

  assert.deepEqual(await store.ageToolParts("th_age", ws), { aged: 1 }, "只有那条够老又够大");

  const parts = store.listMessages("th_age", 60).find((m) => m.id === "a1")!.parts;
  const part = parts.find((p) => p.type.startsWith("tool-")) as ToolPart;
  const body = part.output as { _aged: boolean; spill_path: string; note: string };
  assert.equal(body._aged, true, "正文换成了指针");
  assert.match(body.note, /已老化/);
  assert.equal(part.spillPath, body.spill_path);
  assert.ok(existsSync(body.spill_path), "归档文件必须真的在");
  assert.equal(readFileSync(body.spill_path, "utf8"), JSON.stringify({ content: big }), "落盘的是模型当时看到的那段正文");

  const after = toWireHistory(store.recentMessages("th_age", 60), "th_age");
  assert.equal(shape(after), shape(before), "结构、顺序、配对、arguments 一个字节都不许动");
  // [0]=user [1]=assistant(带 tool_calls) [2]=tool 结果：重建出来的就是库里那条（铁律二）
  assert.equal(String(after[2]!.content), JSON.stringify(part.output), "重建出来的就是库里那条（铁律二）");
  assert.notEqual(String(after[2]!.content), String(before[2]!.content), "正文确实换了（否则这条测试什么也没验到）");

  assert.deepEqual(await store.ageToolParts("th_age", ws), { aged: 0 }, "老化幂等：再跑一次不动");
  db.close();
});

test("老化：已撤销的消息不再动（撤销掉的内容没人看得到）", async () => {
  const cfg = tmp();
  const ws = tmp();
  const { db, store } = seed(cfg, "th_age_undo");
  const big = "C".repeat(TOOL_RESULT_AGING_MIN_CHARS + 500);
  bigOldThread(store, "th_age_undo", big);
  db.run("UPDATE messages SET undone_at = ? WHERE id = 'a1'", Date.now());   // 模拟上一轮撤销留下的标记

  assert.deepEqual(await store.ageToolParts("th_age_undo", ws), { aged: 0 });
  const part = store.listMessages("th_age_undo", 60).find((m) => m.id === "a1")!.parts.find((p) => p.type.startsWith("tool-")) as ToolPart;
  assert.equal((part.output as { content?: string }).content, big, "正文原样没动");
  assert.ok(!existsSync(join(ws, ".spill", "old.txt")), "连落盘都不该发生");
  db.close();
});

// ── 消息表：同 id 重写 ─────────────────────────────────

test("同 id 重写：metadata 合并（tail / turnDiff 不许被静默清掉）", () => {
  const cfg = tmp();
  const { db, store } = seed(cfg, "th_upsert");
  const id = "u_upsert";
  const base: Message = { id, threadId: "th_upsert", role: "user", parts: [{ type: "text", text: "原始" }], createdAt: tick() };
  store.addMessage(base);
  store.setMessageTail(id, "[Context: 时间锚]\n\n原始");            // 同一落点的另一条写路径（read-modify-write）
  store.addMessage({ ...base, parts: [{ type: "text", text: "改写后" }], turnDiff: { files: ["a.ts"], truncated: false } });

  const read = (): Message => store.listMessages("th_upsert", 60).find((m) => m.id === id)!;
  assert.equal((read().parts[0] as { text: string }).text, "改写后", "parts 是整体替换（这是 INSERT OR REPLACE 的本意）");
  assert.equal(read().tail, "[Context: 时间锚]\n\n原始", "tail 不许被清掉（丢它 = 下一轮重建少了那段前缀，缓存从那里断开）");
  assert.deepEqual(read().turnDiff?.files, ["a.ts"], "本次显式给的 turnDiff 要写进去");

  // 再重写一次：这次不带 turnDiff，它也得留着（只覆盖显式给的字段）
  store.addMessage({ ...base, parts: [{ type: "text", text: "再改写" }] });
  assert.deepEqual(read().turnDiff?.files, ["a.ts"], "没传的字段保留旧值");
  assert.equal(read().tail, "[Context: 时间锚]\n\n原始");
  db.close();
});
