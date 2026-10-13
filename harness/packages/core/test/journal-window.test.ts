/**
 * 压缩窗口标记（journal.markWindowStart / lastWindow）+ 恢复指针的两种文案
 *
 * 为什么这组测试值钱：Context Recovery 段里的行号是**模型唯一能照着 grep 的坐标**。
 * 从前它写的是「最近 200 行」，而文案却说「被摘要的是第 X–Y 行」——
 * 两者根本不对应：模型照着去 grep，多半落在**没被摘要**的那一段，白烧几步还找不回细节。
 * 这里钉三件事：
 * ① 标记占一行（行号即序号不破），lastWindow 给出的区间**真的**是被摘要的那一段；
 * ② 没有标记时必须退回「最近 n 行」并标 approximate（不许假装精确）；
 * ③ 渲染层如实区分：精确写「被摘要的是」，近似写「大致……（近似区间：最近 N 行）」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal, JOURNAL_WINDOW_TYPE } from "../src/session/journal.ts";
import { renderRecoveryFooter } from "../src/context/recovery-footer.ts";
import { makeCompactor } from "../src/agent/assemble-adapter.ts";
import type { ChatMessage, Provider } from "../src/providers/types.ts";

const DATE = "2026-01-02";
const tmp = (): string => mkdtempSync(join(tmpdir(), "dove-window-"));

test("窗口标记占一行：行号即序号不破，seq 继续往后走", () => {
  const cfg = tmp();
  const j = openJournal(cfg, "th_mark", DATE);
  j.append("turn_start", { userText: "第一轮" });
  j.append("tool_result", { tool: "Read" });
  const mark = j.markWindowStart("compact step=7 120→40");

  assert.equal(mark.seq, 4, "标记自己占一行（第 4 行），不是内存里的一个 offset");
  assert.equal(mark.type, JOURNAL_WINDOW_TYPE);
  assert.equal(j.readLines(4, 4)[0]!.type, "context.window", "行号能查到它");
  assert.equal(j.readAll().at(-1)!.data!.reason, "compact step=7 120→40", "reason 原样落在 data 里");
  j.append("turn_start", { userText: "压缩之后" });
  assert.equal(j.seq, 5, "标记之后 seq 接着走，不许跳号");
});

test("lastWindow：有标记 = 真的被摘要那一段（精确）；没有标记 = 最近 n 行（近似）", () => {
  const cfg = tmp();
  const j = openJournal(cfg, "th_win", DATE);

  // 压缩之前的内容：第 2–4 行（被摘要的就是它们）
  j.append("turn_start", { userText: "早" });
  j.append("tool_result", { tool: "Read", output: "细节甲" });
  j.append("assistant_text", { delta: "我说过的话" });

  // 还没压缩过 → 没有窗口标记：只能退回「最近 n 行」，且**必须**自报近似
  const before = j.lastWindow(3);
  assert.equal(before.logPath, j.path);
  assert.deepEqual([before.startLine, before.endLine], [2, 4]);
  assert.equal(before.approximate, true, "没有标记就是估计，不许当精确范围用");

  // 压缩发生：runtime 在压缩真的改小了消息序列那一刻落标记
  j.markWindowStart("compact");
  j.append("turn_start", { userText: "压缩之后的一轮" });
  j.append("tool_result", { tool: "Bash", output: "压缩后的细节" });

  const after = j.lastWindow(3);
  assert.deepEqual([after.startLine, after.endLine], [2, 4],
    "区间要正好停在标记之前：第 5 行是标记、第 6–7 行是压缩后新写的，一条都没进摘要");
  assert.equal(after.approximate, false, "有标记才算精确");
  assert.ok(after.endLine! < j.seq, "区间不许把压缩之后的行算进来");

  // 再压一次：标记往后挪，区间跟着长（旧标记之前的照样在摘要覆盖范围内）
  j.append("assistant_text", { delta: "第二轮说过的话" });
  j.markWindowStart("compact 2");
  const second = j.lastWindow(3);
  assert.deepEqual([second.startLine, second.endLine], [2, 8], "起点仍是文件第一行内容（摘要覆盖整个上下文）");
  assert.equal(second.approximate, false);

  // 只有 metadata：连行号都给不出来
  const blank = openJournal(cfg, "th_blank", DATE);
  const none = blank.lastWindow(200);
  assert.equal(none.approximate, true);
  assert.equal(none.startLine, undefined, "只有 metadata 时不给区间（拿不到行号就不写行号）");
  assert.equal(none.logPath, blank.path, "路径照给：摘要段还能落地");
});

test("渲染：精确区间写「被摘要的是」，近似区间如实写成「大致 + 最近 N 行」", () => {
  const cfg = tmp();
  const j = openJournal(cfg, "th_render", DATE);
  j.append("turn_start", { userText: "早" });
  j.append("tool_result", { tool: "Read", output: "细节甲" });
  j.markWindowStart("compact");
  j.append("turn_start", { userText: "压缩之后" });

  const exact = renderRecoveryFooter(j.lastWindow(200));   // lastWindow 自带 logPath
  assert.ok(exact.includes("被摘要的是第 2–3 行。"), "有标记就是精确说法");
  assert.ok(!exact.includes("近似"), "精确区间不许出现「近似」二字");
  assert.ok(exact.includes("先用 grep 拿到行号"), "读法照旧（这条指针的价值所在，一个字都不许动）");

  const approx = renderRecoveryFooter({ logPath: j.path, startLine: 2, endLine: 5, approximate: true });
  assert.ok(approx.includes("近似区间：最近 4 行"), "近似区间要把「最近 N 行」写出来");
  assert.ok(!approx.includes("被摘要的是"), "近似时不许再写「被摘要的是」——那是在假装精确");
  assert.ok(approx.includes("先用 grep 拿到行号"), "两种写法的读法部分一致");

  // 没有行号 → 「被摘要的是」那一段照旧不出现（行为不变）
  const noLines = renderRecoveryFooter({ logPath: j.path });
  assert.ok(!noLines.includes("被摘要"), "拿不到行号就不写被摘要那一段");
  assert.ok(noLines.includes(j.path));
});

test("接进压缩适配器：journalFor 拿的是 lastWindow 的区间与 approximate", async () => {
  const cfg = tmp();
  const j = openJournal(cfg, "th_adapter", DATE);
  const seen: string[] = [];
  let footer = "";
  const provider: Provider = {
    id: "stub",
    stream: async (opts) => {
      // 摘要器收到的是被摘要的对话文本
      seen.push(String(opts.messages.at(-1)?.content ?? ""));
      return {
        text: "这是摘要正文",
        reasoning: "", toolCalls: [], finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const compact = makeCompactor({
    provider, model: "deepseek-flash",
    config: { threshold: 60, keepRecentMessages: 2 },
    journalFor: () => j,
    spillDir: "/tmp/dove/.spill",
  });

  // 先攒一段历史 + 一个窗口标记（模拟「压缩过一次」）
  j.append("turn_start", { userText: "早" });
  j.append("assistant_text", { delta: "早前说过的话" });
  j.markWindowStart("compact 1");
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: "user", content: `用户第 ${i} 条需求` + "补".repeat(4000) });
    msgs.push({ role: "assistant", content: "答复" + "字".repeat(4000) });
  }
  const out = await compact(msgs, 10, { inputTokens: 900_000, outputTokens: 1_000, cacheReadTokens: 0 }, { threadId: "th_adapter" });
  assert.ok(out.length < msgs.length, "这么多 token 必须真的压下去");
  footer = String(out[0]!.content ?? "");
  assert.ok(footer.includes("### Context Recovery"), "摘要里要挂上恢复指针");
  assert.ok(footer.includes(j.path), "指针给出线程日志路径");
  assert.ok(footer.includes("被摘要的是第 2–3 行"), "指针的行号 == lastWindow 给的精确区间");
  assert.ok(!footer.includes("近似"), "有标记时不写近似");
  assert.ok(footer.includes("/tmp/dove/.spill"), "spill 目录照旧要提");
  assert.ok(seen.length > 0, "摘要器确实被调用过");
});
