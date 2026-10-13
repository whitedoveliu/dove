/**
 * 压缩检查点（AutoCompact 落库）回归
 *
 * 钉的是一件事：压缩压出来的那段历史**必须离得开当前这一轮的内存**。
 * 出问题的形态是 —— onBeforeStep 拿压缩结果替换了轮内消息，但没有任何地方把它写回 store；
 * 下一轮 run 又从库里全量重建（还受 60 条窗口约束），于是「压缩」只省了这一轮的钱，
 * 历史仍是原来那份，等于白做。
 *
 * 所以这里断言的是**库上的事实**，不是内存里的事实：写入 → **重启**（新 Db / 新 Store 指同一个文件）→
 * 还读得回来。库是临时**文件**不是 :memory: —— 跨连接重启是唯一能证明「真的落库了」的方式。
 *
 * 另一条钉住的性质是「没检查点时必须一个字都不变」：装配路径换成了 assembleWireHistory，
 * 而无检查点时它必须与老的 `toWireHistory(recentMessages(…))` **逐字节相同**（前缀缓存不许因此断开）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { toWireHistory, dropLastUser } from "../src/agent/wire-history.ts";
import { assembleWireHistory } from "../src/agent/history-assembly.ts";
import { planAging } from "../src/tools/result-aging.ts";
import { TOOL_RESULT_AGING_MIN_CHARS } from "../src/constants.ts";
import type { Message, Part, ToolPart } from "../src/session/types.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "dove-compact-persist-"));
const dbFile = (name = "dove.db"): string => join(tmp(), name);

/** 自增时钟：created_at 严格递增，否则「检查点之后」的边界在测试里就不确定了 */
let clock = 1_000_000;
const tick = (): number => ++clock;

function userMsg(threadId: string, id: string, text: string): Message {
  return { id, threadId, role: "user", parts: [{ type: "text", text }], createdAt: tick() };
}

/** 一条 assistant：一步（step-start 记号）+ 一次 Read + 一段文本 —— 装配时会走切步规则，不是平凡形状 */
function assistantMsg(threadId: string, id: string, i: number): Message {
  const part: ToolPart = {
    type: "tool-Read", toolCallId: `c${i}`, toolName: "Read", state: "output-available",
    input: { file_path: `/tmp/f${i}` }, inputRaw: `{"file_path":"/tmp/f${i}"}`, output: { content: `文件 ${i}` },
  };
  const parts: Part[] = [{ type: "step-start" }, part, { type: "text", text: `第 ${i} 轮答` }];
  return { id, threadId, role: "assistant", parts, createdAt: tick() };
}

/** 3 轮对话（u1/a1/u2/a2/u3/a3），时间戳严格递增 */
function seed(store: Store, threadId: string): void {
  store.createThread({ id: threadId, kind: "project", title: "压缩" });
  for (let i = 1; i <= 3; i++) {
    store.addMessage(userMsg(threadId, `u${i}`, `第 ${i} 轮`));
    store.addMessage(assistantMsg(threadId, `a${i}`, i));
  }
}

const ids = (msgs: Message[]): string[] => msgs.map((m) => m.id);
const bytes = (msgs: unknown[]): string => JSON.stringify(msgs);

function open(file: string): { db: Db; store: Store } {
  const db = new Db(file);
  return { db, store: new Store(db) };
}

// ── 回归保护：没有检查点时一个字都不许变 ─────────────────

test("无检查点：assembleWireHistory 与「直接 toWireHistory(recentMessages)」逐字节相同", () => {
  const { db, store } = open(dbFile());
  seed(store, "th_plain");
  assert.equal(store.compactedHistory("th_plain"), undefined, "没写过检查点");

  for (const limit of [2, 20, 60]) {
    const viaAssemble = assembleWireHistory({ store, threadId: "th_plain", limit, supportsImages: true });
    const legacy = toWireHistory(store.recentMessages("th_plain", limit), "th_plain", true);
    assert.ok(legacy.length > 0, `limit=${limit}：基准不能是空数组（否则这条断言什么也没验到）`);
    assert.equal(bytes(viaAssemble), bytes(legacy), `limit=${limit}：无检查点时装配结果必须逐字节相同`);
  }
  // 行视图也要等价：historyForWire 无检查点 == recentMessages（逐个字段，含 metadata 上的 tail/origin）
  const rows = store.recentMessages("th_plain", 20);
  assert.deepEqual(store.historyForWire("th_plain", 20), rows, "无检查点时两条历史读法必须完全一致");
  db.close();
});

// ── 有检查点：前缀 + 检查点之后的消息 ─────────────────────

test("有检查点：wire = 前缀原样透传 + 检查点之后的消息；检查点之前的内容不再出现", () => {
  const { db, store } = open(dbFile());
  seed(store, "th_cp");
  const rows = store.recentMessages("th_cp", 60);

  // 模拟 AutoCompact：前 3 条（u1/a1/u2）被压成一段已拼好的 wire 前缀，检查点落在 u2 那一刻
  const prefix = toWireHistory(rows.slice(0, 3), "th_cp", true);
  const at = rows[2]!.createdAt;
  store.setCompactedHistory("th_cp", prefix, at);

  const tail = store.historyForWire("th_cp", 60);
  assert.deepEqual(ids(tail), ["a2", "u3", "a3"], "只剩检查点之后的消息");
  const wire = assembleWireHistory({ store, threadId: "th_cp", limit: 60, supportsImages: true });
  const wireTail = wire.slice(prefix.length);

  assert.deepEqual(wire.slice(0, prefix.length), prefix, "前缀必须原样透传（它已经是 wire 形状，不许再转一次）");
  assert.equal(bytes(wireTail), bytes(toWireHistory(tail, "th_cp", true)), "后面接的是转换后的尾巴");
  assert.equal(bytes(wire), bytes([...prefix, ...toWireHistory(tail, "th_cp", true)]));
  // 尾巴是从库里重建的那一段：被压进去的那几条一条都不许再冒出来（冒出来 = 压缩白做，还白花一段摘要的钱）
  assert.ok(!wireTail.some((m) => String(m.content).includes("第 1 轮")), "第 1 轮的正文不许出现在尾巴里");
  assert.ok(!wireTail.some((m) => m.tool_call_id === "c1"), "被压进去的 tool 结果不许出现在尾巴里");
  assert.ok(wireTail.some((m) => m.tool_call_id === "c2"), "检查点之后的 tool 结果照旧在");

  // runtime 拿到装配结果后的下一步：dropLastUser 剥掉的必须是**本轮那条** user 消息（runTurn 会把它重新加回去）。
  // 检查点在前、尾巴在后，最后一条 user 永远来自尾巴 —— 前缀里带着 user 消息也不会被剥错。
  const trimmed = dropLastUser(wire);
  assert.equal(trimmed.length, wire.length - 1);
  assert.equal(trimmed.at(-1)?.role, "tool", "剥掉 u3 之后，最后一条是 a3 的 tool 结果");
  assert.ok(!trimmed.some((m) => m.role === "user" && String(m.content) === "第 3 轮"), "u3 由 runTurn 重新加回去");
  db.close();
});

test("historyForWire：严格大于 at、排除已撤销、limit 口径与 recentMessages 一致", () => {
  const { db, store } = open(dbFile());
  seed(store, "th_wire");   // u1/a1/u2/a2/u3/a3
  const rows = store.recentMessages("th_wire", 60);
  store.setCompactedHistory("th_wire", [{ role: "user", content: "摘要" }], rows[3]!.createdAt);   // 落在 a2

  assert.deepEqual(ids(store.historyForWire("th_wire", 60)), ["u3", "a3"], "只返回 createdAt > at 的消息");
  assert.ok(!store.historyForWire("th_wire", 60).some((m) => m.id === "a2"), "边界是严格大于：at 那一刻那条不返回");
  // 「最近 limit 条」的口径与 recentMessages 一模一样：检查点之后那一段本就是全量的尾巴
  assert.deepEqual(store.historyForWire("th_wire", 2), store.recentMessages("th_wire", 2), "limit 口径必须一致");
  assert.deepEqual(ids(store.historyForWire("th_wire", 2)), ["u3", "a3"]);

  // 撤销标记（模拟更早一次撤销留下的行）在检查点路径上照样生效
  db.run("UPDATE messages SET undone_at = ? WHERE id = ?", Date.now(), "u3");
  assert.deepEqual(ids(store.historyForWire("th_wire", 60)), ["a3"], "已撤销的仍被排除");
  db.close();
});

test("空 payload / 坏 JSON 的检查点视同没有检查点（不许把历史清空成只剩新消息）", () => {
  const { db, store } = open(dbFile());
  seed(store, "th_empty");
  const legacy = toWireHistory(store.recentMessages("th_empty", 60), "th_empty", true);
  const full = ids(store.recentMessages("th_empty", 60));

  store.setCompactedHistory("th_empty", [], tick());
  assert.equal(store.compactedHistory("th_empty"), undefined, "空 payload 读出来就是「没有检查点」");
  assert.deepEqual(ids(store.historyForWire("th_empty", 60)), full, "退回全量历史，而不是只剩检查点之后几条");
  assert.equal(bytes(assembleWireHistory({ store, threadId: "th_empty", limit: 60, supportsImages: true })), bytes(legacy),
    "装配结果与老路径逐字节相同 —— 记忆不许被一个空检查点清空");

  db.run("UPDATE compactions SET payload = ? WHERE thread_id = ?", "{ 坏掉的 JSON", "th_empty");
  assert.equal(store.compactedHistory("th_empty"), undefined, "读不出来的检查点也只能当没有");
  db.close();
});

// ── 真的落库了：跨连接重启 ───────────────────────────────

test("重启：检查点写进库文件，新 Db / 新 Store 读得回来（只留最新一条）", () => {
  const file = dbFile("restart.db");
  const first = open(file);
  seed(first.store, "th_restart");
  const rows = first.store.recentMessages("th_restart", 60);
  const prefix = toWireHistory(rows.slice(0, 3), "th_restart", true);
  const olderAt = rows[1]!.createdAt;   // 先写一版旧的
  const at = rows[2]!.createdAt;        // 再写最新一版（at 更大，检查点落在 u2 那一刻）
  first.store.setCompactedHistory("th_restart", prefix, olderAt);
  // 线程级只留最新一条：旧的检查点被 at 与 payload 一起取代，不许留下「该用哪一条」的歧义
  const newer = [...prefix, { role: "user", content: "第二版摘要" }];
  first.store.setCompactedHistory("th_restart", newer, at);
  first.db.close();

  const second = open(file);   // ← 重启：换连接、换实例，只有库文件是同一份
  const cp = second.store.compactedHistory("th_restart");
  assert.ok(cp, "重启后检查点必须还在（这是「真的落库了」的唯一证明）");
  assert.equal(cp.at, at);
  assert.deepEqual(cp.payload, newer, "存的是最新的那一条");
  const wire = assembleWireHistory({ store: second.store, threadId: "th_restart", limit: 60, supportsImages: true });
  const wireTail = wire.slice(newer.length);
  assert.deepEqual(wire.slice(0, newer.length), newer, "重启后装配出来的前缀还是它");
  assert.deepEqual(ids(second.store.historyForWire("th_restart", 60)), ["a2", "u3", "a3"], "后面接着检查点之后的消息");
  assert.ok(!wireTail.some((m) => String(m.content).includes("第 1 轮")), "被压进去的历史没有从库里再冒出来");
  second.db.close();
});

// ── 撤销：清检查点 ─────────────────────────────────────

test("撤销：清掉该线程的检查点（checkpointCleared: true），历史能回到更早的消息", () => {
  const { db, store } = open(dbFile());
  seed(store, "th_undo");
  const rows = store.recentMessages("th_undo", 60);
  const prefix = toWireHistory(rows.slice(0, 2), "th_undo", true);
  store.setCompactedHistory("th_undo", prefix, rows[1]!.createdAt);   // 检查点落在 a1 → 只剩 u2/a2/u3/a3
  assert.deepEqual(ids(store.historyForWire("th_undo", 60)), ["u2", "a2", "u3", "a3"]);

  const r = store.undoTurns("th_undo", 1);
  assert.equal(r.undone, 1);
  assert.equal(r.checkpointCleared, true, "撤销必须把检查点一起清掉（留着等于撤销到一半）");
  assert.equal(store.compactedHistory("th_undo"), undefined);
  // 撤销的语义是「回到更早的完整历史」：检查点没了，被它压住的那两条又回来了
  assert.deepEqual(ids(store.historyForWire("th_undo", 60)), ["u1", "a1", "u2", "a2"]);

  // 本来就没有检查点时：false（不是「清了个不存在的东西」）
  assert.equal(store.undoTurns("th_undo", 1).checkpointCleared, false);
  // 撤销**没做成**时不许顺手清（失败什么都不该动）
  store.setCompactedHistory("th_undo", prefix, rows[1]!.createdAt);
  const failed = store.undoTurns("th_undo", 99);
  assert.equal(failed.undone, 0);
  assert.equal(failed.checkpointCleared, undefined, "没撤成就不许动检查点");
  assert.ok(store.compactedHistory("th_undo"), "检查点原样还在");
  db.close();
});

// ── 老库兼容 ───────────────────────────────────────────

test("老库兼容：没有 compactions 表（连 undone_at 列都没有）的库打开不报错，写入后读得回来", () => {
  const file = dbFile("legacy.db");
  const raw = new DatabaseSync(file);
  // 手搓一个升级前的库：只有老版本就有的表与列（schema_version 也已经是 5，走不到迁移分支）
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'project', project_id TEXT,
      title TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT 'deepseek-flash',
      metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
      parts TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', parent_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, usage TEXT);
    INSERT INTO meta(key, value) VALUES ('schema_version', '5');
    INSERT INTO threads(id, kind, title, created_at, updated_at) VALUES ('th_legacy', 'project', '老库', 1, 1);
    INSERT INTO messages(id, thread_id, role, parts, created_at) VALUES
      ('u1', 'th_legacy', 'user', '[{"type":"text","text":"老消息"}]', 1);
  `);
  raw.close();

  const probe = new DatabaseSync(file);
  assert.equal(probe.prepare("SELECT name FROM sqlite_master WHERE name = 'compactions'").get(), undefined,
    "先确认这确实是个没有 compactions 表的老库（否则这条测试什么也没验到）");
  probe.close();

  const { db, store } = open(file);   // ← 迁移发生在这里
  assert.ok(db.all("PRAGMA table_info(compactions)").length > 0, "打开时自动建表");
  assert.deepEqual(ids(store.recentMessages("th_legacy", 60)), ["u1"], "老数据照常读得到");
  assert.equal(store.compactedHistory("th_legacy"), undefined, "老库没有检查点 → 退回全量历史");

  store.setCompactedHistory("th_legacy", [{ role: "user", content: "摘要" }], tick());
  store.addMessage(userMsg("th_legacy", "u2", "新消息"));
  assert.deepEqual(store.compactedHistory("th_legacy")!.payload, [{ role: "user", content: "摘要" }]);
  assert.deepEqual(ids(store.historyForWire("th_legacy", 60)), ["u2"], "检查点之后的消息照常读得到");
  db.close();
});

// ── 老化 × 检查点：边界（有意）──────────────────────────

/** 一条 assistant：一步记号 + 一次 Read，结果正文是给定的那段（够大就够老化条件） */
function bigAssistant(threadId: string, id: string, toolCallId: string, big: string): Message {
  const part: ToolPart = {
    type: "tool-Read", toolCallId, toolName: "Read", state: "output-available",
    input: { file_path: "/tmp/big" }, inputRaw: `{"file_path":"/tmp/big"}`, output: { content: big },
  };
  return { id, threadId, role: "assistant", parts: [{ type: "step-start" }, part], createdAt: tick() };
}

test("老化边界（有意）：检查点里的正文不再老化 —— 库里换成指针，wire 上仍是全文", async () => {
  const ws = tmp();
  const { db, store } = open(dbFile());
  store.createThread({ id: "th_agecp", kind: "project", title: "老化边界" });
  const big = "B".repeat(TOOL_RESULT_AGING_MIN_CHARS + 500);
  store.addMessage(userMsg("th_agecp", "u1", "读个大文件"));
  store.addMessage(bigAssistant("th_agecp", "a1", "c_big", big));
  for (let i = 0; i < 8; i++) {
    store.addMessage(userMsg("th_agecp", `u${i + 2}`, `第 ${i + 2} 轮`));
    store.addMessage(assistantMsg("th_agecp", `a${i + 2}`, i + 2));
  }

  // 检查点 payload 就是「那一刻已上过 wire 的字节」：里面带着那条结果的全文
  const payload = toWireHistory(store.recentMessages("th_agecp", 60), "th_agecp", true);
  store.setCompactedHistory("th_agecp", payload, tick());
  assert.ok(bytes(payload).includes(big), "前提：payload 里确实有那条全文（否则这条测试什么也没验到）");

  assert.deepEqual(await store.ageToolParts("th_agecp", ws, planAging), { aged: 1 }, "库里的那一行照样被老化");

  const part = store.listMessages("th_agecp", 60).find((m) => m.id === "a1")!.parts.find((p) => p.type.startsWith("tool-")) as ToolPart;
  assert.equal((part.output as { _aged?: boolean })._aged, true, "库里的正文换成了指针（落盘文件也写了）");
  // ⚠️ 但 wire 上那一份**来自检查点 payload**（原样透传）→ 模型此后看到的仍是全文。
  //    这是有意的取舍：payload 是已稳定、已缓存的前缀，改写它等于从那里整段重付（见 store.ts 的 ageToolParts）。
  const wire = assembleWireHistory({ store, threadId: "th_agecp", limit: 60, supportsImages: true });
  assert.ok(bytes(wire).includes(big), "检查点里的正文不再老化 —— 要改这条断言，先改那条取舍的文档");
  db.close();
});
