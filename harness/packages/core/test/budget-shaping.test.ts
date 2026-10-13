/**
 * 工具输出整形：行内截断 → 总预算收缩 → 头尾预览（budget.ts）
 * 以及工具结果老化（result-aging.ts 的 planAging）。
 *
 * 运行：node --no-warnings --test packages/core/test/budget-shaping.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyBudget, shapeLongLines } from "../src/tools/budget.ts";
import { planAging } from "../src/tools/result-aging.ts";
import type { AgingCandidate } from "../src/tools/result-aging.ts";
import type { Tool } from "../src/tools/types.ts";
import {
  OUTPUT_FIELD_LIMITS, OUTPUT_LINE_MAX_CHARS, OUTPUT_PREVIEW_HEAD_CHARS,
  OUTPUT_PREVIEW_TAIL_CHARS, TOOL_RESULT_AGING_AFTER_STEPS, TOOL_RESULT_AGING_MIN_CHARS,
} from "../src/constants.ts";

const fakeTool = (over: Partial<Tool> = {}): Tool => ({
  name: "Grep", description: "搜内容",
  parameters: { type: "object", properties: {} },
  outputTier: "compact", approval: "never", concurrencySafe: true,
  execute: async () => ({}), ...over,
});

const tmp = () => mkdtempSync(join(tmpdir(), "dove-shaping-"));

/** 统计「保住了几条不同的事实」——每行开头的行标签就是一条事实 */
const keptLineTags = (text: string): string[] =>
  [...new Set(text.split("\n").map((l) => /^L\d+:/.exec(l)?.[0]).filter((t): t is string => !!t))];

// ── 行内截断 ─────────────────────────────────────────

test("行内截断：超长行折短且**行数不变**，每行长度不超过单行上限", () => {
  const text = Array.from({ length: 12 }, (_, i) => `L${i}: ` + "x".repeat(6_000)).join("\n");
  const r = shapeLongLines({ content: text, path: "a".repeat(5_000) });
  const shaped = String((r.value as Record<string, unknown>).content);

  assert.equal(shaped.split("\n").length, text.split("\n").length, "行数必须一字不差（行号要对得上）");
  assert.ok(r.cut > 0, "确实砍掉了字符");
  assert.ok(shaped.length < text.length / 2, `总长度应显著下降：${shaped.length} vs ${text.length}`);
  assert.deepEqual(keptLineTags(shaped), keptLineTags(text), "12 条不同的事实一条都没丢");
  assert.match(shaped, /…\[\+\d+ 字符\]/, "长行要有自报被砍字符数的标记");
  for (const line of shaped.split("\n")) {
    assert.ok(line.length <= OUTPUT_LINE_MAX_CHARS, `整形后每行都在上限内：${line.length}`);
  }
  // 需原样返回的键（path 之类）不参与整形，与 shrinkOnce 同一条纪律
  assert.equal((r.value as Record<string, unknown>).path, "a".repeat(5_000));
});

test("行内截断：短行一根手指都不碰（含边界值）", () => {
  const text = "L0: " + "x".repeat(OUTPUT_LINE_MAX_CHARS - 5);
  const r = shapeLongLines({ content: text });
  assert.equal(r.cut, 0);
  assert.equal(String((r.value as Record<string, unknown>).content), text);
});

// ── 顺序：先整形，再收缩 ──────────────────────────────

test("顺序与限额：整形先于字段限额，但字段限额仍是硬约束", async () => {
  const text = `L0: ${"x".repeat(4_990)}\nL1: ${"y".repeat(4_990)}`;
  const r = await applyBudget(fakeTool(), { content: text }, tmp(), "call-order");
  const out = String((r.result as Record<string, unknown>).content);
  const cap = OUTPUT_FIELD_LIMITS["content"] ?? 1_800;

  // ① 字段自己的限额是**硬约束**：不能因为「整形之后总长放得下」就放行。
  //    这条是 smoke-ptc 抓回来的真回归：RunScript 的 stdout 从 1500 涨到 2014 ——
  //    模型的「每个字段最多多少」这句承诺变成了看运气。
  //    （取舍说明：这意味着整形带来的「保住更多不同行」在**单字段**输出上会被字段限额吃掉，
  //     它真正的收益在多字段 / 无字段限额的场合 —— 见下面 ③ 的落盘契约与 fields 那个用例。）
  assert.ok(out.length <= cap, `content 必须 ≤ ${cap}，实际 ${out.length}`);
  // ② 整形仍然在限额之内发生：留在这段里的行都不超过单行上限
  for (const line of out.split("\n")) {
    assert.ok(line.length <= OUTPUT_LINE_MAX_CHARS + 16, "单行不得超过行上限（+标记余量），实际 " + line.length);
  }
  // ③ 截断必须报出来 + 落盘完整原文（不能让模型以为「读完了」）
  assert.equal(r.truncated, true);
  assert.match(String((r.result as Record<string, unknown>)._truncationNotice), /不完整的输出/);
  assert.ok(r.spillPath && existsSync(r.spillPath), "原文要落盘");
  // 存档是 rawResult 的 pretty-print JSON，所以要比内容而不是比串
  const spilled = JSON.parse(readFileSync(r.spillPath, "utf8")) as { content: string };
  assert.equal(spilled.content, text, "存档里必须是完整原文（两行都在），不是整形后的");
  assert.ok(readFileSync(r.spillPath, "utf8").length > String(out).length, "存档比模型看到的那份更全");
});

// ── 外置：元数据 + 头尾预览 ───────────────────────────

test("外置指针：头尾预览都在，元数据齐全，真实大小没退化", async () => {
  // 40 个字段 × 900 字符：迭代收缩到下限仍然超预算 → 走外置指针这条路
  const fields: Record<string, string> = {};
  for (let i = 0; i < 40; i++) fields[`k${i}`] = `HEADMARK-${i}: ` + "x".repeat(880) + ` TAILMARK-${i}`;
  const dir = tmp();
  const r = await applyBudget(fakeTool(), fields, dir, "call-preview");
  const res = r.result as Record<string, unknown>;

  assert.equal(res._truncated, true);
  // 出口头（命令与结论）与出口尾（错误摘要就在那儿）都要在，头多尾少
  assert.match(String(res.preview_head), /^\{/);
  assert.match(String(res.preview_head), /HEADMARK-0/);
  assert.equal(String(res.preview_head).length, OUTPUT_PREVIEW_HEAD_CHARS);
  assert.equal(String(res.preview_tail).length, OUTPUT_PREVIEW_TAIL_CHARS);
  assert.match(String(res.preview_tail), /TAILMARK-39/);
  assert.match(String(res.preview_tail), /\}$/);

  // 元数据
  assert.equal(res.tool_name, "Grep");
  assert.equal(res.tool_call_id, "call-preview");
  assert.equal(res.output_size_chars, r.originalSize);
  assert.equal(res.output_path, r.spillPath);
  assert.equal(res._spillPath, r.spillPath);
  assert.ok(String(res.next_step).includes(String(r.spillPath)), "next_step 要说清怎么读全文");

  // 「真实文件大小」这条不能退化：三要素里必须有确切 KB 数
  assert.match(String(res._truncationNotice), /存档到/);
  assert.match(String(res._truncationNotice), /KB/);
  assert.ok(r.spillPath && existsSync(r.spillPath));
  assert.ok(readFileSync(r.spillPath, "utf8").length > OUTPUT_PREVIEW_HEAD_CHARS + OUTPUT_PREVIEW_TAIL_CHARS);
  assert.ok(JSON.stringify(res).length < 8_000, `指针不该比预算还胖：${JSON.stringify(res).length}`);
});

// ── 老化 ─────────────────────────────────────────────

test("老化：老的 + 大的才选；边界（等于阈值）与小的不选", () => {
  const dir = tmp();
  const big = "x".repeat(TOOL_RESULT_AGING_MIN_CHARS);
  const step = 50;
  const cands: AgingCandidate[] = [
    { key: "k-too-new", text: big, step: step - TOOL_RESULT_AGING_AFTER_STEPS, toolCallId: "c1" },
    { key: "k-fresh", text: big, step: step, toolCallId: "c2" },
    { key: "k-small", text: "y".repeat(TOOL_RESULT_AGING_MIN_CHARS - 1), step: 1, toolCallId: "c3" },
    { key: "k-old-big", text: big, step: step - TOOL_RESULT_AGING_AFTER_STEPS - 1, toolCallId: "c4" },
  ];
  const plans = planAging(cands, step, dir);

  assert.deepEqual(plans.map((p) => p.key), ["k-old-big"], "刚过阈值的那条选中，等于阈值的不算");
  const p = plans[0]!;
  assert.equal(p.spillPath, join(dir, ".spill", "c4.txt"));
  assert.equal(readFileSync(p.spillPath, "utf8"), big, "落盘内容 == 原文");
  assert.equal(p.body, big);
  assert.ok(p.pointerText.includes(p.spillPath), "指针里必须有落盘路径");
  assert.match(p.pointerText, /Read /, "指针里必须说清怎么读回来");
  assert.equal(p.savedChars, big.length - p.pointerText.length);
  assert.ok(p.savedChars > 0);
});

test("老化：只换正文 —— key 与顺序原样透传（不排序、不合并）", () => {
  const dir = tmp();
  const big = "z".repeat(2_000);
  const cands: AgingCandidate[] = [
    { key: "c", text: big, step: 1, toolCallId: "cc" },
    { key: "a", text: big, step: 3, toolCallId: "ca" },
    { key: "b", text: big, step: 2, toolCallId: "cb" },
  ];
  const plans = planAging(cands, 40, dir);
  assert.deepEqual(plans.map((p) => p.key), ["c", "a", "b"], "输出顺序 == 输入顺序（重排就是换消息顺序）");
  assert.deepEqual(plans.map((p) => p.spillPath), ["cc", "ca", "cb"].map((n) => join(dir, ".spill", `${n}.txt`)));
});

test("老化：没有 toolCallId 时用 key 兜底命名（洗字符 + 补哈希，不串台）", () => {
  const dir = tmp();
  const plans = planAging([{ key: "msg/../../../etc/passwd", text: "q".repeat(2_000), step: 1 }], 40, dir);
  assert.equal(plans.length, 1);
  const p = plans[0]!;
  assert.ok(p.spillPath.startsWith(join(dir, ".spill") + "/"), `必须留在 .spill 里：${p.spillPath}`);
  assert.ok(!p.spillPath.includes(".."), "key 里的穿越片段要被洗掉");
  assert.equal(readFileSync(p.spillPath, "utf8"), "q".repeat(2_000));
});

test("老化：落盘失败 → 整条放弃（绝不产生指向空文件的半截 plan）", () => {
  // 把 workdir 指到一个**文件**上：mkdir .spill 必然失败
  const notADir = join(tmp(), "plain-file");
  writeFileSync(notADir, "x");
  const plans = planAging([{ key: "k", text: "z".repeat(3_000), step: 1, toolCallId: "c1" }], 40, notADir);
  assert.deepEqual(plans, []);
});

test("老化：目标文件已存在（budget 落的全文）→ 不覆盖，复用路径", () => {
  const dir = tmp();
  const full = join(dir, ".spill", "c9.txt");
  mkdirSync(join(dir, ".spill"), { recursive: true });
  writeFileSync(full, "ORIGINAL-FULL-TEXT");
  const plans = planAging([{ key: "k", text: "z".repeat(2_000), step: 1, toolCallId: "c9" }], 40, dir);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.spillPath, full);
  assert.equal(readFileSync(full, "utf8"), "ORIGINAL-FULL-TEXT", "已有的全文不能被更短的那份盖掉");
  assert.ok(plans[0]!.pointerText.includes(full));
});
