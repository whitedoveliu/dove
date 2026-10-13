/**
 * AutoCompact：保留「真实用户消息」（T2.6 补充）
 * 运行：node --no-warnings --test packages/core/test/compact-keep.test.ts
 *
 * 核心病灶：只按「最近 N 个回合」保留的话，N 个工具密集回合（几十个大 tool result）
 * 就能把用户最初那条需求挤出上下文 —— 压缩完模型不知道用户到底要什么。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { COMPACT_TARGET_WINDOW_FRACTION } from "../src/constants.ts";
import {
  compact,
  defaultIsKeptUserMessage,
  fallbackMessage,
  normalizeCompactConfig,
  summaryMessage,
} from "../src/context/compact.ts";
import { renderRecoveryFooter } from "../src/context/recovery-footer.ts";
import { estimateMessagesTokens, findSafeSplitPoint, keepRecentTurnsStart } from "../src/context/tokens.ts";
import type { ChatMessage } from "../src/providers/types.ts";

// ── 造数据的口径 ─────────────────────────────────────
// estimateTextTokens 对 ASCII 是 4 字符/token：造数据按这个换算，断言才不靠猜。
const pad = (tokens: number): string => "x".repeat(tokens * 4);
const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistantText = (text: string): ChatMessage => ({ role: "assistant", content: text });
const assistantCall = (id: string): ChatMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name: "Bash", arguments: `{"command":"cat ${id}"}` } }],
});
const toolResult = (id: string, text: string): ChatMessage => ({ role: "tool", tool_call_id: id, name: "Bash", content: text });
/** dove 的提醒 / 注入都是 role=user 的 system-reminder 包装 */
const reminder = (body: string): ChatMessage => ({ role: "user", content: `<system-reminder>\n${body}\n</system-reminder>` });

const summarize = async (): Promise<string> => "## 用户的目标与约束\n把 all.jsonl 转成 CSV。";

/** 内容里的文本（块状 content 的文本块也拼进来，断言才不挑形状） */
function texts(msgs: ChatMessage[]): string[] {
  return msgs
    .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b) => b.text ?? "").join("") : ""))
    .filter((t) => t.length > 0);
}
const has = (msgs: ChatMessage[], needle: string): boolean => texts(msgs).some((t) => t.includes(needle));
const hasExact = (msgs: ChatMessage[], text: string): boolean => msgs.some((m) => m.content === text);

interface TurnSpec {
  /** 这个回合的「用户消息」：真实用户文本 / 注入提醒，二选一 */
  user?: string;
  injection?: string;
  toolTokens?: number;
}

/** 开局几条 + n 个工具密集回合 + 收尾一个回合 */
function history(first: ChatMessage[], turns: number, turn: (i: number) => TurnSpec, lastUser: string): ChatMessage[] {
  const out = [...first];
  for (let i = 0; i < turns; i++) {
    const spec = turn(i);
    if (spec.injection) out.push(reminder(spec.injection));
    if (spec.user) out.push(user(spec.user));
    out.push(assistantCall(`c${i + 1}`), toolResult(`c${i + 1}`, pad(spec.toolTokens ?? 10_000)), assistantText(`第 ${i + 1} 步完成。`));
  }
  out.push(user(lastUser), assistantText("好的。"));
  return out;
}

/** assistant.tool_calls 与 role:"tool" 的配对检查：孤儿结果 / 没结果的调用都算错 */
function pairingProblems(msgs: ChatMessage[]): string[] {
  const problems: string[] = [];
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) calls.add(c.id);
    if (m.role === "tool" && m.tool_call_id) results.add(m.tool_call_id);
  }
  for (const m of msgs) {
    if (m.role === "tool" && (!m.tool_call_id || !calls.has(m.tool_call_id))) problems.push(`孤儿 tool 结果：${m.tool_call_id}`);
  }
  for (const id of calls) if (!results.has(id)) problems.push(`没有结果的 tool_call：${id}`);
  return problems;
}

const EARLIEST = "把 fixtures/all.jsonl 转成 CSV，字段名保持原样，输出到 outputs/all.csv。";
const LAST = "再补一列 ISO 时间；改完跑一遍全量测试。";

/** 开头一条真实需求 + 6 个工具密集回合（回合的「用户消息」是注入提醒）+ 收尾回合 */
const crowded = (): ChatMessage[] => history([user(EARLIEST)], 6, (i) => ({ injection: `第 ${i + 1} 次自动续跑提醒。` }), LAST);

// ── 核心：最初那条需求必须活下来 ──────────────────────
test("保留真实用户消息：6 个工具密集回合也挤不掉最初那条需求", async () => {
  const msgs = crowded();
  const cfg = normalizeCompactConfig();
  const window = 200_000;
  // 老规则（只保最近 N 回合）的切点：它落在最初那条需求之后，所以老规则必然丢掉它
  const turnStart = keepRecentTurnsStart(msgs, cfg.keepRecentMessages);
  assert.ok(turnStart > 0, "历史必须长到「最近 4 回合」装不下开头那条，否则这条测试是空转的");

  const r = await compact(msgs, { cfg, contextWindow: window, summarize });

  assert.equal(r.fallback, false);
  assert.ok(r.droppedMessages > 0, "必须真的压掉了东西");
  assert.ok(hasExact(r.messages, EARLIEST), "最初那条用户需求必须仍在上下文里（逐字原文）");
  assert.equal(r.keptUserMessages, 1);
  // 被压缩掉的注入提醒不许复活（它不是用户说的话）
  assert.ok(!has(r.messages, "第 1 次自动续跑提醒"));
});

// ── 判据：注入 vs 带尾块的真实用户消息 ────────────────
test("判据：只有 system-reminder 的注入不保留", () => {
  assert.equal(defaultIsKeptUserMessage(reminder("请继续完成用户的任务。")), false);
  assert.equal(
    defaultIsKeptUserMessage({ role: "user", content: "<system-reminder>甲</system-reminder>\n<system-reminder>乙</system-reminder>" }),
    false,
    "多个提醒块拼一条也是注入",
  );
  assert.equal(defaultIsKeptUserMessage(summaryMessage("## 摘要")), false, "压缩产物不能再被当成用户消息");
  assert.equal(defaultIsKeptUserMessage(fallbackMessage(7)), false, "退化消息同理");
  assert.equal(defaultIsKeptUserMessage(assistantText("好的。")), false);
  assert.equal(defaultIsKeptUserMessage(toolResult("c1", "输出")), false);
});

test("判据：带 [Context: 尾块的真实用户消息要保留", () => {
  // tail-context 的注入前缀是**贴在用户原话前面**的：前缀里还带着 `## Tasks` / `- [ ]` 这种方括号，
  // 想靠「解析 [Context: …] 到哪个 ] 为止」来还原用户原话是解不对的。
  const withTail: ChatMessage = {
    role: "user",
    content: "[Context: <reminder>Authoritative Local DateTime: 2026-10-13 09:00 (Monday), timezone Asia/Shanghai.</reminder>"
      + "\n\n## Tasks\n- [ ] 补时间列]\n\n把导出的 CSV 补一列 ISO 时间。",
  };
  assert.equal(defaultIsKeptUserMessage(withTail), true, "尾块贴在用户原话上，不能因为 [Context: 前缀就把用户原话丢掉");
  // 只是正文里提到这个标签的，当然也还是用户的话
  assert.equal(defaultIsKeptUserMessage(user("把 <system-reminder> 这个标签当文本引用一下。")), true);
  // 压缩产物的正文一字不改（日志、面板和别的层可能按这段文字对齐）
  assert.ok((summaryMessage("X").content as string).startsWith("[Context: 更早的对话已被压缩（原文已移出上下文以节省空间）。"));
  assert.ok((fallbackMessage(3).content as string).startsWith("[Context: 更早的 3 条消息已从上下文移除。Fallback: truncated"));
});

test("端到端：注入不保留，带尾块的真实用户消息被捞回来", async () => {
  const withTail = "[Context: <reminder>Authoritative Local DateTime: 2026-10-13 09:00 (Monday).</reminder>"
    + "\n\n## Tasks\n- [ ] 补时间列]\n\n把导出的 CSV 补一列 ISO 时间。";
  const msgs = history([reminder("本轮的注入提醒：不要复述上一条回答。"), user(withTail)], 6, (i) => ({ injection: `续跑 ${i + 1}` }), LAST);

  const r = await compact(msgs, { cfg: normalizeCompactConfig(), contextWindow: 200_000, summarize });

  assert.ok(!has(r.messages, "不要复述上一条回答"), "注入提醒不是用户消息，压缩后不该被原样保留");
  assert.ok(has(r.messages, "把导出的 CSV 补一列 ISO 时间。"), "带尾块的真实用户消息必须保留");
  assert.equal(r.keptUserMessages, 1);
});

// ── 预算：头保最早 + 剩余保最新 ───────────────────────
test("预算：头预算保最早那条，其余从最新往回塞，超出的丢", async () => {
  const mid = (i: number): string => `第 ${i} 次追问：补一列。${pad(8_000)}`;
  const msgs = history([user(EARLIEST)], 5, (i) => ({ user: mid(i + 1), toolTokens: 1_000 }), "最后一次：跑全量测试。");
  // 只保最近 2 个回合：中间那几条追问才有机会成为「候选人」
  const cfg = normalizeCompactConfig({ keepRecentMessages: 2 });

  const r = await compact(msgs, { cfg, contextWindow: 200_000, summarize });

  assert.ok(hasExact(r.messages, EARLIEST), "最早那条靠头预算（2000）留住");
  assert.ok(has(r.messages, "第 4 次追问"), "最新那条候选人要留住");
  assert.ok(has(r.messages, "第 3 次追问"), "预算还有就继续往回塞");
  assert.ok(!has(r.messages, "第 1 次追问") && !has(r.messages, "第 2 次追问"), "超出 20000 预算的老追问必须丢");
  assert.equal(r.keptUserMessages, 3, "最早 + 第 3、4 次追问（第 5 次追问在尾巴里，不重复计数）");
});

// ── 安全网：窗口 60% ─────────────────────────────────
test("安全网：窗口 60% 仍然管着保留段总量", async () => {
  const mid = (i: number): string => `第 ${i} 次追问：补一列。${pad(8_000)}`;
  const msgs = history([user(EARLIEST)], 5, (i) => ({ user: mid(i + 1), toolTokens: 1_000 }), "最后一次：跑全量测试。");
  const cfg = normalizeCompactConfig({ keepRecentMessages: 2 });
  const window = 30_000; // 窗口小：60% 只剩 18000，比用户消息预算还小
  const keepBudget = Math.floor(window * COMPACT_TARGET_WINDOW_FRACTION);

  const r = await compact(msgs, { cfg, contextWindow: window, summarize });

  // 摘要消息本身不算「保留段」（它的体积由摘要器控制，不属于历史）
  const keptTokens = estimateMessagesTokens(r.messages.slice(1));
  assert.ok(keptTokens <= keepBudget, `保留段 ${keptTokens} token 超了窗口 60%（${keepBudget}）`);
  assert.ok(hasExact(r.messages, EARLIEST), "窗口再紧，最初那条也得留着（它比头预算小得多）");
  assert.ok(r.messages.length < msgs.length, "压缩必须真的变短");
});

// ── 补救：被窗口预算推出尾巴的用户消息 ────────────────
test("补救：被窗口预算推出尾巴的真实用户消息，用剩余预算捞回来", async () => {
  const msgs: ChatMessage[] = [user(EARLIEST)];
  for (let i = 1; i <= 4; i++) {
    msgs.push(user(`第 ${i} 次追问：补一列。${pad(8_000)}`), assistantCall(`b${i}`), toolResult(`b${i}`, pad(200)), assistantText("好。"));
  }
  // 第 5 个回合：用户那句话很短、工具结果巨大 —— 尾巴整段装不下，但那条用户消息本身很便宜
  msgs.push(user("最后一次追问。"), assistantCall("b5"), toolResult("b5", pad(8_010)), assistantText("好。"));
  msgs.push(user("收尾：跑全量测试。"), assistantText("好的。"));

  const cfg = normalizeCompactConfig({ keepRecentMessages: 2 });
  const r = await compact(msgs, { cfg, contextWindow: 20_000, summarize });

  assert.ok(has(r.messages, "最后一次追问。"), "尾巴被窗口预算推走了，这条用户消息要靠剩余预算捞回来");
  assert.ok(!has(r.messages, pad(8_010)), "但它那个巨型工具结果仍然要丢（余量给不起）");
  assert.ok(hasExact(r.messages, "收尾：跑全量测试。"), "最近一个回合无论如何留全");
});

// ── 安全边界：不切断 assistant/tool 配对 ──────────────
test("保留段落在安全边界上，不切断 assistant/tool 配对", async () => {
  const msgs = crowded();
  const cfg = normalizeCompactConfig();
  const window = 200_000;
  assert.deepEqual(pairingProblems(msgs), [], "造出来的历史本身必须是配对的，否则这条测试是空转的");

  const r = await compact(msgs, { cfg, contextWindow: window, summarize });

  assert.deepEqual(pairingProblems(r.messages), [], "保留段不能留下孤儿 tool 结果 / 没结果的调用");
  // 尾巴必须是 msgs 的一段连续后缀，且起点落在回合边界（user 消息）上 —— 即 findSafeSplitPoint 的语义
  const turnStart = keepRecentTurnsStart(msgs, cfg.keepRecentMessages);
  assert.equal(findSafeSplitPoint(msgs, turnStart, Math.floor(window * COMPACT_TARGET_WINDOW_FRACTION)), turnStart,
    "这段历史里最近 4 个回合并没过预算，切点应当就是 turnStart");
  assert.equal(msgs[turnStart]!.role, "user");
  assert.deepEqual(r.messages.slice(r.messages.length - (msgs.length - turnStart)), msgs.slice(turnStart),
    "尾巴应当逐条等于 msgs.slice(turnStart)");
});

// ── Context Recovery 指针 ────────────────────────────
test("Context Recovery：有行号 / 无行号 / 无 info", () => {
  const full = renderRecoveryFooter({
    logPath: "/Users/x/proj/.logs/sessions/2026-10-13.jsonl",
    startLine: 120,
    endLine: 840,
    spillDir: "/Users/x/proj/.spill",
  });
  assert.match(full, /^### Context Recovery/);
  assert.ok(full.includes("/Users/x/proj/.logs/sessions/2026-10-13.jsonl"), "必须给出日志路径");
  assert.ok(full.includes("只追加、不改写"), "必须说明日志只追加");
  assert.ok(full.includes("第 120–840 行"), "必须标出被摘要的行段");
  assert.ok(full.includes("每行是一条完整 JSON"));
  assert.ok(full.includes("grep") && full.includes("不要整文件读"), "必须写清读法：先 grep 再只读那一行");
  assert.ok(full.includes("/Users/x/proj/.spill"), "有 spill 目录就要提");
  // 行号反了要自己换回来，不能照着写成「第 840–120 行」
  assert.ok(renderRecoveryFooter({ logPath: "/tmp/a.jsonl", startLine: 840, endLine: 120 }).includes("第 120–840 行"));

  const noLines = renderRecoveryFooter({ logPath: "/tmp/a.jsonl" });
  assert.match(noLines, /^### Context Recovery/);
  assert.ok(!noLines.includes("被摘要的是"), "拿不到行号就不写行号");
  assert.ok(!noLines.includes(".spill"), "没给 spill 目录就不提");
  assert.ok(renderRecoveryFooter({ logPath: "/tmp/a.jsonl", startLine: 7 }).includes("从第 7 行起"));

  assert.equal(renderRecoveryFooter(), "", "没有 info → 空串，不许输出半截段落");
  assert.equal(renderRecoveryFooter({ logPath: "   " }), "", "路径是空白 → 同样当没有");
});

test("footer 接进压缩：摘要成功才挂，退化路径不挂", async () => {
  const recovery = { logPath: "/tmp/dove/.logs/sessions/2026-10-13.jsonl", startLine: 12, endLine: 96, spillDir: "/tmp/dove/.spill" };
  const msgs = crowded();
  const cfg = normalizeCompactConfig();

  const ok = await compact(msgs, { cfg, contextWindow: 200_000, summarize, recovery });
  const head = ok.messages[0]!.content as string;
  assert.equal(ok.fallback, false);
  assert.equal(ok.recoveryFooter, renderRecoveryFooter(recovery));
  assert.ok(head.includes(ok.summary), "摘要正文要在最前面");
  assert.ok(head.includes("### Context Recovery"), "指针要追加在摘要正文里");
  assert.ok(head.indexOf(ok.summary) < head.indexOf("### Context Recovery"), "指针在摘要之后");
  assert.ok(head.includes(recovery.logPath));

  const noRecovery = await compact(msgs, { cfg, contextWindow: 200_000, summarize });
  assert.equal(noRecovery.recoveryFooter, undefined);
  assert.ok(!(noRecovery.messages[0]!.content as string).includes("Context Recovery"), "没给 recovery 就不许凭空造指针");

  const boom = await compact(msgs, {
    cfg,
    contextWindow: 200_000,
    recovery,
    summarize: async () => { throw new Error("摘要器炸了"); },
  });
  assert.equal(boom.fallback, true, "摘要抛错仍然退化为显式截断");
  assert.equal(boom.recoveryFooter, undefined);
  assert.match(boom.messages[0]!.content as string, /Fallback: truncated/);
  assert.ok(!(boom.messages[0]!.content as string).includes("Context Recovery"), "没有摘要就没有可信的指针，不许挂");
  assert.ok(hasExact(boom.messages, EARLIEST), "退化时用户的原话更要留着");
});

// ── 退化输入 ─────────────────────────────────────────
test("退化输入：空历史 / 没有用户消息 / 装得下不动刀", async () => {
  const cfg = normalizeCompactConfig();
  const empty = await compact([], { cfg, contextWindow: 200_000, summarize });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.droppedMessages, 0);

  const one = [user("一句话。")];
  const r1 = await compact(one, { cfg, contextWindow: 200_000, summarize });
  assert.deepEqual(r1.messages, one, "装得下就一条都不许动");
  assert.equal(r1.droppedMessages, 0);
  assert.equal(r1.keptUserMessages, 0);

  // 一条 user 消息都没有（历史里全是注入 + 工具）：判据全 false，也不能炸
  const noUser = [reminder("续跑"), assistantCall("x"), toolResult("x", pad(10)), assistantText("好。")];
  const r2 = await compact(noUser, { cfg, contextWindow: 200_000, summarize });
  assert.ok(Array.isArray(r2.messages));
  assert.equal(r2.keptUserMessages, 0);
});
