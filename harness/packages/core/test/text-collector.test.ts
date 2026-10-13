/**
 * TextCollector：助手正文的**去向**（日志出口的形状 + 日志里存的是什么）
 *
 * 钉两件容易静默失效的事：
 * ① 日志出口只要求 `append(type, data?, ctx?)` —— runtime 现在传的是双写门面 RunLog
 *    （按天全局日志 + 每线程 journal 一起写）。类型一旦收回 `EventLog`，门面就传不进来，
 *    表现是「线程 journal 里永远没有模型说过的话」：压缩后的恢复指针把人指到 journal，
 *    模型找得到工具结果与回合边界，**找不回自己说过什么**。
 * ② 落日志的是**增量片段**（还可能被截到 400 字符），完整正文只在 messages.parts 里。
 *    哪天有人拿日志当全文回读，这两条断言就会炸 —— 那正是它们存在的意义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TextCollector } from "../src/agent/text-collector.ts";
import { makeRunLog } from "../src/agent/run-log.ts";
import { EventLog } from "../src/session/event-log.ts";
import { openJournal } from "../src/session/journal.ts";
import type { Part } from "../src/session/types.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (): string => mkdtempSync(join(tmpdir(), "dove-texts-"));

/** 最小日志出口：只实现 append —— 连 EventLog 的 file/seq 都没有（这正是要钉的形状） */
class Recorder {
  records: { type: string; data: Record<string, unknown>; ctx: { run?: string; step?: number } }[] = [];
  append(type: string, data: Record<string, unknown> = {}, ctx: { run?: string; step?: number } = {}): void {
    this.records.push({ type, data, ctx });
  }
  deltas(): string[] {
    return this.records.filter((r) => r.type === "assistant_text").map((r) => String(r.data.delta));
  }
}

function collector(log: Recorder, parts: Part[], step = () => 1): TextCollector {
  return new TextCollector({ parts, eventLog: log, sink: () => { /* 忽略界面推流 */ }, runId: "r1", step });
}

test("日志出口只要 append：三段式增量都落到日志（脱敏窗口放行的那部分）", () => {
  const log = new Recorder();
  const parts: Part[] = [];
  const c = collector(log, parts);

  // 脱敏器有 256 字符回看窗口：短文本会被整段扣住，flush 才放行
  c.push("先扣住的一句话");
  assert.deepEqual(log.deltas(), [], "没到窗口长度就不放行（安全优先，不是丢内容）");
  c.flush();
  assert.deepEqual(log.deltas(), ["先扣住的一句话"], "flush 放掉的尾巴一样要落日志");
  assert.deepEqual(parts.map((p) => p.type), ["text"]);
  assert.equal((parts[0] as { text: string }).text, "先扣住的一句话", "parts 里是完整正文");

  // 超过窗口的增量：push 当场放行
  c.push("x".repeat(300));
  assert.equal(log.deltas().length, 2, "超过 256 字符回看窗口的部分立刻落日志");
  assert.equal(log.deltas()[1], "x".repeat(44), "放行的是「总长 − 回看窗口」那一段");
  c.flush();
  assert.equal(log.records[0]!.ctx.run, "r1", "上下文要带上 run");
  assert.equal(log.records[0]!.ctx.step, 1, "上下文要带上 step（日志按步归档）");
});

test("日志里的是增量片段（截到 400），完整正文在 parts —— 别拿日志当全文", () => {
  const log = new Recorder();
  const parts: Part[] = [];
  const c = collector(log, parts);

  const long = "甲".repeat(1000);
  c.push(long);
  const first = log.deltas()[0]!;
  assert.equal(first.length, 400, "落日志的增量必须截到 400（防日志爆炸）");
  assert.equal(first, long.slice(0, 400));

  c.flush();
  const total = parts.filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text).join("");
  assert.equal(total, long, "完整正文在 parts 里，一个字符都不许少（wire 重建只吃 parts）");
  assert.ok(log.deltas().join("").length < long.length, "日志里的是片段，不是全文");
});

test("一步一条 text part：flush 封口，下一个 step 的文本另起一条", () => {
  const log = new Recorder();
  const parts: Part[] = [];
  let step = 1;
  const c = collector(log, parts, () => step);

  c.push("x".repeat(300));
  c.flush();
  step = 2;
  c.push("y".repeat(300));
  c.flush();

  assert.deepEqual(parts.filter((p) => p.type === "text").length, 2, "两个 step 的文本不许并进同一条 part");
  assert.deepEqual(log.records.map((r) => r.ctx.step), [1, 1, 2, 2], "日志按步归档（step 是惰性取的）");
});

test("annotate：空回合说明直接写进唯一 text part（用赋值不是追加）", () => {
  const log = new Recorder();
  const parts: Part[] = [];
  const c = collector(log, parts);
  c.annotate("（这一轮没有产出）");
  assert.equal((parts[0] as { text: string }).text, "（这一轮没有产出）");
  c.flush();
  assert.equal(parts.length, 1, "annotate 之后 flush 不许再开一条空 part");
});

test("接真双写门面：assistant_text 同时进按天日志与线程 journal（这就是换 RunLog 的理由）", () => {
  const cfg = tmp();
  const eventLog = new EventLog({ dir: join(tmp(), "logs") });
  const journal = openJournal(cfg, "th_texts", "2026-01-02");
  const logs = makeRunLog({ eventLog, journal });

  const parts: Part[] = [];
  const c = new TextCollector({ parts, eventLog: logs, sink: () => { /* 忽略 */ }, runId: "r1", step: () => 1 });
  c.push("x".repeat(300));
  c.flush();

  const inJournal = journal.readAll().filter((r) => r.type === "assistant_text");
  assert.ok(inJournal.length > 0, "线程 journal 里必须能查到模型说过的话（恢复指针指的就是它）");
  assert.equal(inJournal[0]!.data!.delta, "x".repeat(44));
  assert.ok(readFileSync(eventLog.file, "utf8").includes("assistant_text"), "按天日志照旧要写（面板契约不变）");
  assert.deepEqual(parts.map((p) => p.type), ["text"], "门面不影响 parts（重建仍然只吃 parts）");
});
