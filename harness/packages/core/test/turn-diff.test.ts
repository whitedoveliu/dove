/**
 * 回合净 diff 单测：净合并 / 计数 / 截断 / 大文件 / 线程隔离 / 两个写工具的端到端
 * 运行：node --no-warnings --test packages/core/test/turn-diff.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  beginTurnDiff, resetTurnDiff, recordFileMutation, takeTurnDiff,
  TURN_DIFF_MAX_BYTES, TURN_DIFF_MAX_TEXT_CHARS, TURN_DIFF_WORK_BUDGET_CHARS,
} from "../src/tools/turn-diff.ts";
import { TURN_DIFF_MAX_FILES } from "../src/constants.ts";
import { WriteTool } from "../src/tools/builtin/write.ts";
import { EditTool } from "../src/tools/builtin/edit.ts";
import type { ToolContext } from "../src/tools/types.ts";

function ctxFor(threadId: string, workdir: string): ToolContext {
  return {
    toolCallId: "c1", threadId, workdir, outputsDir: join(workdir, "outputs"),
    emit: () => {}, requestApproval: async () => ({ approved: true }), services: {},
  };
}

function tmpWs(tag: string): string {
  return mkdtempSync(join(tmpdir(), "dove-turn-diff-" + tag + "-"));
}

// ── 净：一轮里同一文件写多次 ──────────────────────────
test("净：同一文件写两次只留 1 条，before 是第一次、after 是最后一次", () => {
  const th = "th-net";
  beginTurnDiff(th);
  recordFileMutation(th, { path: "a.txt", before: "L1\n老内容\nL3\n", after: "L1\n中间态\nL3\n" });
  recordFileMutation(th, { path: "a.txt", before: "L1\n中间态\nL3\n", after: "L1\n最终\nL3\n" });

  const d = takeTurnDiff(th);
  assert.equal(d.files.length, 1, "两次写同一个文件必须合成一条");
  assert.equal(d.files[0]!.path, "a.txt");
  assert.equal(d.files[0]!.added, 1);
  assert.equal(d.files[0]!.removed, 1);
  assert.match(d.diffText, /^-老内容$/m, "before 应取第一次那份");
  assert.match(d.diffText, /^\+最终$/m, "after 应取最后一次那份");
  assert.ok(!/^[+-]中间态$/m.test(d.diffText), "中间态不该出现在净 diff 里");
});

test("净：写了又改回原样 = 0/0，条目保留但没有正文", () => {
  const th = "th-noop";
  beginTurnDiff(th);
  recordFileMutation(th, { path: "b.txt", before: "X\n", after: "Y\n" });
  recordFileMutation(th, { path: "b.txt", before: "Y\n", after: "X\n" });
  const d = takeTurnDiff(th);
  assert.equal(d.files.length, 1);
  assert.deepEqual(
    { added: d.files[0]!.added, removed: d.files[0]!.removed },
    { added: 0, removed: 0 },
  );
  assert.equal(d.diffText, "", "没有净改动就不该有正文");
});

// ── 新建 / 删除 ───────────────────────────────────────
test("新建：before=null → created，全部行算新增", () => {
  const th = "th-new";
  beginTurnDiff(th);
  recordFileMutation(th, { path: "new.ts", before: null, after: "a\nb\n" });
  const d = takeTurnDiff(th);
  assert.equal(d.files[0]!.created, true);
  assert.equal(d.files[0]!.deleted, false);
  assert.deepEqual({ added: d.files[0]!.added, removed: d.files[0]!.removed }, { added: 2, removed: 0 });
  assert.match(d.diffText, /^--- \/dev\/null$/m);
  assert.match(d.diffText, /^\+\+\+ b\/new\.ts$/m);
});

test("删除：after=null → deleted，全部行算删除", () => {
  const th = "th-del";
  beginTurnDiff(th);
  recordFileMutation(th, { path: "old.ts", before: "a\nb\nc\n", after: null });
  const d = takeTurnDiff(th);
  assert.equal(d.files[0]!.deleted, true);
  assert.equal(d.files[0]!.created, false);
  assert.deepEqual({ added: d.files[0]!.added, removed: d.files[0]!.removed }, { added: 0, removed: 3 });
  assert.match(d.diffText, /^--- a\/old\.ts$/m);
  assert.match(d.diffText, /^\+\+\+ \/dev\/null$/m);
});

// ── 计数（近似：公共前后缀裁剪） ──────────────────────
test("计数：只改中间一行 → 1 added / 1 removed（前缀后缀都被裁掉）", () => {
  const th = "th-mid";
  beginTurnDiff(th);
  recordFileMutation(th, { path: "m.txt", before: "头\nK1\nK2\n改我\nK4\n尾\n", after: "头\nK1\nK2\n改完了\nK4\n尾\n" });
  const d = takeTurnDiff(th);
  assert.deepEqual({ added: d.files[0]!.added, removed: d.files[0]!.removed }, { added: 1, removed: 1 });
});

test("计数：整段替换 → 全部行都算改动", () => {
  const th = "th-whole";
  beginTurnDiff(th);
  recordFileMutation(th, { path: "w.txt", before: "a\nb\nc\n", after: "x\ny\nz\n" });
  const d = takeTurnDiff(th);
  assert.deepEqual({ added: d.files[0]!.added, removed: d.files[0]!.removed }, { added: 3, removed: 3 });
});

test("正文：只列改动行，前后缀相同的行不出现（也不补上下文行）", () => {
  const th = "th-text";
  beginTurnDiff(th);
  recordFileMutation(th, { path: "t.txt", before: "P\nQ\nR\nS\n", after: "P\nQ2\nR\nS\n" });
  const d = takeTurnDiff(th);
  assert.match(d.diffText, /^-Q$/m);
  assert.match(d.diffText, /^\+Q2$/m);
  for (const same of ["P", "R", "S"]) {
    assert.ok(!new RegExp("^[-+]" + same + "$", "m").test(d.diffText), same + " 与两侧相同，不该被列出来");
  }
  assert.ok(!/^ /m.test(d.diffText), "近似 diff 不补上下文行");
  assert.match(d.diffText, /^@@ -2,1 \+2,1 @@$/m);
});

// ── 取数即清 / 线程隔离 ───────────────────────────────
test("取数：takeTurnDiff 取完即清，beginTurnDiff 也会清", () => {
  const th = "th-take";
  beginTurnDiff(th);
  recordFileMutation(th, { path: "x.txt", before: null, after: "1\n" });
  assert.equal(takeTurnDiff(th).files.length, 1);
  const again = takeTurnDiff(th);
  assert.equal(again.files.length, 0, "第二次取必须是空的 —— 否则下一轮会重复报上一轮");
  assert.equal(again.diffText, "");

  recordFileMutation(th, { path: "y.txt", before: null, after: "2\n" });
  beginTurnDiff(th);
  assert.equal(takeTurnDiff(th).files.length, 0, "回合开始必须清掉累计");
});

test("取数：没记录过的线程返回空，(reset 也是空的)", () => {
  const d = takeTurnDiff("th-never-seen");
  assert.deepEqual(d, { files: [], truncated: false, diffText: "" });
  const th = "th-reset";
  beginTurnDiff(th);
  recordFileMutation(th, { path: "z.txt", before: null, after: "z\n" });
  resetTurnDiff(th);
  assert.equal(takeTurnDiff(th).files.length, 0);
});

test("线程隔离：th_a 的记录绝不出现在 th_b 的结果里", () => {
  beginTurnDiff("th_a");
  beginTurnDiff("th_b");
  recordFileMutation("th_a", { path: "a-only.txt", before: null, after: "a\n" });
  recordFileMutation("th_b", { path: "b-only.txt", before: null, after: "b\n" });

  const a = takeTurnDiff("th_a");
  assert.deepEqual(a.files.map((f) => f.path), ["a-only.txt"]);
  assert.ok(!a.diffText.includes("b-only.txt"));
  const b = takeTurnDiff("th_b");
  assert.deepEqual(b.files.map((f) => f.path), ["b-only.txt"]);
});

// ── 上限 ─────────────────────────────────────────────
test("上限：文件数超 TURN_DIFF_MAX_FILES → truncated 且只留前 N 个", () => {
  const th = "th-many";
  beginTurnDiff(th);
  for (let i = 0; i < TURN_DIFF_MAX_FILES + 5; i++) {
    recordFileMutation(th, { path: `f${i}.txt`, before: null, after: "x\n" });
  }
  const d = takeTurnDiff(th);
  assert.equal(d.truncated, true);
  assert.equal(d.files.length, TURN_DIFF_MAX_FILES);
  assert.equal(d.files[0]!.path, "f0.txt", "保留的顺序 = 第一次被写的顺序");
  assert.match(d.diffText, /超过上限/);
});

test("上限：单文件超 200KB → 只有粗计数，不逐行列正文", () => {
  const th = "th-big";
  beginTurnDiff(th);
  const big = "L\n".repeat(120_000); // 240KB
  recordFileMutation(th, { path: "big.txt", before: big, after: "first\n" + big });

  const d = takeTurnDiff(th);
  assert.equal(d.files.length, 1);
  assert.equal(d.truncated, false, "只给粗计数不算「结果被截断」，计数仍在");
  assert.ok(d.files[0]!.added > 100_000 && d.files[0]!.removed > 100_000, "粗计数应是两侧总行数");
  assert.match(d.diffText, /粗计数/);
  assert.match(d.diffText, /200KB/);
  assert.ok(!/^[+-]L$/m.test(d.diffText), "大文件不该有逐行正文");
  assert.ok(d.diffText.length < 1_000, "粗计数模式下正文必须很小，实际 " + d.diffText.length);
});

test("上限：软预算用尽 → 后面的文件降级为粗计数（不用真计时器，结果可复现）", () => {
  const th = "th-budget";
  beginTurnDiff(th);
  const body = (tag: string) => Array.from({ length: 3_000 }, (_, i) => tag + i + "-".repeat(20)).join("\n");
  const a1 = body("a"), a2 = a1.replace("a1500-", "a1500-CHANGED-");
  const b1 = body("b"), b2 = b1.replace("b1500-", "b1500-CHANGED-");
  assert.ok((a1.length + a2.length) > TURN_DIFF_WORK_BUDGET_CHARS, "第一个文件就要吃掉整轮预算");
  assert.ok(a1.length < TURN_DIFF_MAX_BYTES, "但单个文件本身没超 200KB，走的应是预算这条路");

  recordFileMutation(th, { path: "first.txt", before: a1, after: a2 });
  recordFileMutation(th, { path: "second.txt", before: b1, after: b2 });

  const d = takeTurnDiff(th);
  assert.deepEqual(
    { added: d.files[0]!.added, removed: d.files[0]!.removed },
    { added: 1, removed: 1 },
    "预算用尽前的文件仍给行级结果",
  );
  assert.ok(d.files[1]!.added > 1_000, "预算用尽后只能给粗计数（总行数）");
  assert.match(d.diffText, /软预算/);
  assert.ok(d.diffText.length < TURN_DIFF_MAX_TEXT_CHARS + 2_000);
});

// ── 端到端：真的过工具 ────────────────────────────────
test("端到端 Write：同一文件写两次 → 净 diff 只有 1 条", async () => {
  const ws = tmpWs("write");
  writeFileSync(join(ws, "a.txt"), "L1\nL2\nL3\n", "utf8");
  const th = "th-write";
  beginTurnDiff(th);
  const ctx = ctxFor(th, ws);

  const r1 = await WriteTool.execute({ file_path: "a.txt", content: "L1\nA\nL3\n" }, ctx);
  const r2 = await WriteTool.execute({ file_path: "a.txt", content: "L1\nB\nL3\n" }, ctx);
  assert.equal(r1.error, undefined);
  assert.equal(r2.error, undefined);
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "L1\nB\nL3\n");

  const d = takeTurnDiff(th);
  assert.equal(d.files.length, 1, "两次 Write 同一个文件必须合成一条");
  assert.equal(d.files[0]!.path, "a.txt");
  assert.equal(d.files[0]!.created, false);
  assert.deepEqual({ added: d.files[0]!.added, removed: d.files[0]!.removed }, { added: 1, removed: 1 });
  assert.match(d.diffText, /^-L2$/m, "before 应是磁盘上那份旧内容");
  assert.match(d.diffText, /^\+B$/m, "after 应是最后一次写入");
  assert.ok(!/^[+-]A$/m.test(d.diffText), "中间那次写入不该出现");
});

test("端到端 Write：新建文件 → created（before=null 来自 stat）", async () => {
  const ws = tmpWs("create");
  const th = "th-create";
  beginTurnDiff(th);
  const r = await WriteTool.execute({ file_path: "sub/new.txt", content: "N1\nN2\n" }, ctxFor(th, ws));
  assert.equal(r.error, undefined);
  const d = takeTurnDiff(th);
  assert.equal(d.files.length, 1);
  assert.equal(d.files[0]!.created, true);
  assert.equal(d.files[0]!.added, 2);
  assert.match(d.diffText, /^--- \/dev\/null$/m);
});

test("端到端 Edit：before 取自编辑前读进来的那份；失败的 Edit 不留记录", async () => {
  const ws = tmpWs("edit");
  writeFileSync(join(ws, "e.txt"), "one\ntwo\nthree\n", "utf8");
  const th = "th-edit";
  beginTurnDiff(th);
  const ctx = ctxFor(th, ws);

  const ok = await EditTool.execute({ file_path: "e.txt", old_string: "two", new_string: "TWO" }, ctx);
  assert.equal(ok.replacements, 1);
  const bad = await EditTool.execute({ file_path: "e.txt", old_string: "找不到的串", new_string: "x" }, ctx);
  assert.ok(bad.error, "替换失败应返回 error 且不改文件");

  const d = takeTurnDiff(th);
  assert.equal(d.files.length, 1, "失败的 Edit 不该留下记录");
  assert.equal(d.files[0]!.created, false);
  assert.deepEqual({ added: d.files[0]!.added, removed: d.files[0]!.removed }, { added: 1, removed: 1 });
  assert.match(d.diffText, /^-two$/m);
  assert.match(d.diffText, /^\+TWO$/m);
});
