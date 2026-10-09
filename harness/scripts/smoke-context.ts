/**
 * 上下文装配自测（M2 验收）
 * 运行：cd harness && node --no-warnings scripts/smoke-context.ts
 * 覆盖：系统提示词装配 + provider 拆分 / mt 注入到最后一条 user / 记忆切片 / 压缩判据与退化 / parts→消息
 */
import { assembleSystemPrompt, cacheMetrics } from "../packages/core/src/context/assemble.ts";
import { renderTailContext, injectIntoLastUser } from "../packages/core/src/context/tail-context.ts";
import { renderMemoriesBlock } from "../packages/core/src/context/memories-block.ts";
import { DEFAULT_COMPACT_CONFIG, compact, shouldCompact } from "../packages/core/src/context/compact.ts";
import { convertMessages } from "../packages/core/src/context/convert.ts";
import { estimateTextTokens } from "../packages/core/src/context/tokens.ts";
import { SEGMENTS, assertSegmentDiscipline } from "../packages/core/src/context/segments.ts";
import type { Message, Thread } from "../packages/core/src/session/types.ts";
import type { ChatMessage } from "../packages/core/src/providers/types.ts";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const now = Date.UTC(2026, 9, 5, 6, 32); // 2026-10-05 14:32 Asia/Shanghai

const thread: Thread = {
  id: "th-1", kind: "project", projectId: "p-1", title: "Dove 落地页",
  model: "deepseek-chat", metadata: {}, createdAt: now, updatedAt: now,
};

// ── 1. 系统提示词装配 ────────────────────────────────────────
console.log("\n=== 1. assembleSystemPrompt ===");
assertSegmentDiscipline();
check("段落注册表通过纪律检查", SEGMENTS.length === 11, `共 ${SEGMENTS.length} 段`);
// 纪律检查的反例：动态段缺 reason 必须抛错（照抄 CCB 的 DAS_uncached 纪律）
let disciplineError = "";
const savedSegments = SEGMENTS.slice();
SEGMENTS.push({ id: "sXX-bad", kind: "dynamic", render: () => "x" });
try { assertSegmentDiscipline(); } catch (err) { disciplineError = (err as Error).message; }
SEGMENTS.length = 0;
SEGMENTS.push(...savedSegments);
check("动态段缺 reason 会抛错", disciplineError.includes("sXX-bad"), disciplineError || "没有抛错");

const assembleInput = {
  thread,
  projectContext: { workdir: "/tmp/demo-project", projectName: "Dove 落地页", skills: [{ name: "office-pptx", description: "做 PPT" }] },
  state: { now, timezone: "Asia/Shanghai", user: "用户叫白鸽，讨厌高饱和渐变，常用深色主题，做品牌设计十年。" },
};
const { block1, block2 } = await assembleSystemPrompt(assembleInput);
const again = await assembleSystemPrompt(assembleInput);
check("两次装配逐字节一致（快照稳定）", again.block1 === block1 && again.block2 === block2);

console.log(`  block1 ${block1.length} 字符 / block2 ${block2?.length ?? 0} 字符`);
console.log(`  block1 首行：${block1.split("\n")[0]}`);
console.log(`  block2 前 60 字：${(block2 ?? "").slice(0, 60).replace(/\n/g, " ⏎ ")}`);

check("block1 非空", block1.trim().length > 0);
check("block1 含 Dove 身份", block1.includes("You are Dove"));
check("block1 含真人设定", block1.includes("你是一个真人"));
check("block1 含语言铁律", block1.includes("LANGUAGE RULE (CRITICAL)"));
check("block1 含事实层不可妥协", block1.includes("事实层绝不妥协"));
check("block2 存在且以拆分标记开头", (block2 ?? "").trimStart().startsWith("SYSTEM INFO"));
check("block2 含日期锚", (block2 ?? "").includes("2026-10-05"));
check("日期没漏进 block1（前缀缓存纪律）", !block1.includes("2026-10-05"));
check("工作目录落在 block2", (block2 ?? "").includes("/tmp/demo-project"));
check("USER.md 正文已注入", (block2 ?? "").includes("白鸽"));
check("顺序固定：identity 在 personality 之前", block1.indexOf("You are Dove") < block1.indexOf("PERSONALITY"));

// ── 2. mt 尾部上下文 + 注入 ─────────────────────────────────
console.log("\n=== 2. renderTailContext + injectIntoLastUser ===");
const mt = renderTailContext({
  date: now,
  timezone: "Asia/Shanghai",
  tasks: [
    { id: "3", title: "做落地页首屏", status: "in_progress" },
    { title: "导出 PDF 给客户", status: "pending" },
  ],
  memoryFiles: [{ path: "memory/2026-10-04.md", label: "昨天" }, { path: "MEMORY.md" }],
  emotion: { label: "专注里带一点较真", intensity: 62, reason: "刚发现配色不统一" },
  fatigue: { level: 35, hint: "今晚别熬太晚。" },
});
console.log(`  mt 长度 ${mt.length} 字符，第一行：${mt.split("\n")[0].slice(0, 90)}…`);
check("mt 以权威时间锚开头", mt.startsWith("<reminder>Authoritative Local DateTime: 2026-10-05 14:32"));
check("mt 含时区", mt.includes("Asia/Shanghai"));
check("mt 含任务块", mt.includes("## Tasks") && mt.includes("做落地页首屏"));
check("mt 含记忆文件块", mt.includes("## Memory Files") && mt.includes("memory/2026-10-04.md"));
check("mt 含情绪块", mt.includes("## Emotion") && mt.includes("较真"));
check("mt 含疲劳块", mt.includes("## Fatigue") && mt.includes("35/100"));

const memories = renderMemoriesBlock([
  { content: "用户讨厌高饱和渐变", createdAt: Date.UTC(2026, 8, 20, 1, 0), tags: ["审美"], durability: "permanent" },
  { content: "客户周五要看初稿", createdAt: Date.UTC(2026, 9, 1, 3, 0), tags: ["排期"], durability: "temporary" },
]);
check("记忆块含标题", memories.startsWith("## Relevant Memories"));
check("记忆块含时间锚定规则", memories.includes("Preserve original message sent-at timestamps"));
check("记忆块含 saved-at 戳", memories.includes("[Memory saved-at: 2026-09-20T01:00:00.000Z;"));
check("saved-at 明确不是事件时间", memories.includes("saved-at is NOT event/due/completion time."));
check("temporary 被标记", memories.includes("(temporary)"));
check("标签被渲染", memories.includes("[审美]"));
check("切片 NOTE 不可省", memories.includes("NOTE: This is only the small subset of memories auto-retrieved"));

const baseMsgs: ChatMessage[] = [
  { role: "user", content: "帮我做个落地页" },
  { role: "assistant", content: "行，先给我三个关键词。" },
  { role: "assistant", content: "（我先看下你以前的偏好）" },
  { role: "user", content: "主色再压暗一档" },
];
const injected = injectIntoLastUser(baseMsgs, mt, memories);
const last = injected[injected.length - 1]!;
const lastText = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
console.log(`  末条 user 前 120 字：${lastText.slice(0, 120).replace(/\n/g, " ⏎ ")}…`);
check("mt 被 prepend 到最后一条 user 消息", lastText.startsWith("[Context: <reminder>Authoritative Local DateTime"));
check("记忆块也在同一条 user 消息里", lastText.includes("## Relevant Memories"));
check("原始用户文本仍在末尾", lastText.trimEnd().endsWith("主色再压暗一档"));
check("前面的消息没被动过", injected[0]!.content === "帮我做个落地页");
check("不改原数组（不可变）", baseMsgs[3]!.content === "主色再压暗一档");

const blockMsgs: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "看看这张图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }];
const injectedBlocks = injectIntoLastUser(blockMsgs, mt);
const blocks = injectedBlocks[0]!.content as { type: string; text?: string }[];
check("content block 形态也能注入", Array.isArray(blocks) && blocks[0]!.type === "text" && (blocks[0]!.text ?? "").startsWith("[Context: "));
check("图片块被保留", blocks.some((b) => b.type === "image_url"));

// ── 3. AutoCompact ─────────────────────────────────────────
console.log("\n=== 3. shouldCompact / compact ===");
const bigUsage = { inputTokens: 150_000, outputTokens: 5_000, cacheReadTokens: 40_000, cacheWriteTokens: 0 };
const smallUsage = { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };
console.log(`  伪造大 usage：${JSON.stringify(bigUsage)}，窗口 200000 → ${shouldCompact(bigUsage, block1, [], DEFAULT_COMPACT_CONFIG, 200_000)}`);
check("伪造大 usage 触发压缩", shouldCompact(bigUsage, block1, [], DEFAULT_COMPACT_CONFIG, 200_000) === true);
check("小 usage 不触发", shouldCompact(smallUsage, block1, [], DEFAULT_COMPACT_CONFIG, 200_000) === false);
check("enabled=false 恒不触发", shouldCompact(bigUsage, block1, [], { ...DEFAULT_COMPACT_CONFIG, enabled: false }, 200_000) === false);

const longHistory: ChatMessage[] = [];
for (let i = 0; i < 10; i++) {
  longHistory.push({ role: "user", content: `第 ${i + 1} 轮：把第 ${i + 1} 个区块做出来，风格沿用上一版。` });
  longHistory.push({ role: "assistant", content: `第 ${i + 1} 个区块已完成，文件 outputs/block-${i + 1}.html。` });
}
const okCompact = await compact(longHistory, {
  summarize: async (text: string) => `## 用户的目标与约束\n做 10 个区块\n（转录 ${text.length} 字符）`,
  cfg: DEFAULT_COMPACT_CONFIG,
  contextWindow: 200_000,
});
check("压缩后有摘要消息", okCompact.messages[0]!.content!.toString().includes("更早的对话已被压缩"));
check("保留最近 4 个回合（8 条）", okCompact.messages.length === 9, `实际 ${okCompact.messages.length}`);
check("最末条消息未被改动", okCompact.messages[okCompact.messages.length - 1]!.content === longHistory[19]!.content);
check("fallback=false", okCompact.fallback === false);

const badCompact = await compact(longHistory, {
  summarize: async () => { throw new Error("summarizer down"); },
  cfg: DEFAULT_COMPACT_CONFIG,
  contextWindow: 200_000,
});
const fallbackText = String(badCompact.messages[0]!.content);
check("摘要失败退化为截断并标记", badCompact.fallback === true && fallbackText.includes("Fallback: truncated"));

// ── 4. parts → ChatMessage ─────────────────────────────────
console.log("\n=== 4. convertMessages ===");
const history: Message[] = [
  {
    id: "m1", threadId: thread.id, role: "user", createdAt: now,
    parts: [
      { type: "text", text: "看下这个目录", state: "output-available" },
      { type: "image", mediaType: "image/png", url: "/tmp/shot.png", state: "output-available" },
    ],
  },
  {
    id: "m2", threadId: thread.id, role: "assistant", createdAt: now + 1,
    parts: [
      { type: "text", text: "我看一下。", state: "streaming" },
      { type: "tool-glob", toolCallId: "c1", toolName: "Glob", input: { pattern: "*.html" }, output: { files: ["a.html"] }, state: "output-available" },
      { type: "tool-bash", toolCallId: "c2", toolName: "Bash", input: { command: "ls" }, state: "input-available" },
    ],
  },
];
const wire = convertMessages(history, { resolveImageUrl: () => "data:image/png;base64,AAA" });
console.log(wire.map((m) => `  ${m.role}${m.tool_calls ? `(calls=${m.tool_calls.length})` : ""}`).join("\n"));
check("streaming 的 part 被过滤", !JSON.stringify(wire).includes("我看一下"));
check("tool part → assistant.tool_calls + role:tool", wire[1]!.tool_calls?.[0]!.function.name === "Glob" && wire[2]!.role === "tool");
check("结果未知的调用有占位（不断配）", wire.filter((m) => m.role === "tool").length === 2 && String(wire[3]!.content).includes("结果未记录"));
check("图片被水化成 image_url", JSON.stringify(wire[0]!.content).includes("image_url"));

// ── 5. token 估算 ──────────────────────────────────────────
console.log("\n=== 5. token 估算 / 缓存度量 ===");
const metrics = cacheMetrics({ inputTokens: 800, outputTokens: 120, cacheReadTokens: 3_200, cacheWriteTokens: 0 });
console.log(`  estimateTextTokens("hello world")=${estimateTextTokens("hello world")}，中文 8 字=${estimateTextTokens("你好世界你好世界")}，命中率=${metrics.cacheHitRate}`);
check("英文按 ceil(len/4)", estimateTextTokens("hello world") === 3);
check("中文按 ceil(len/2)", estimateTextTokens("你好世界你好世界") === 4);
check("缓存命中率可度量", Math.abs(metrics.cacheHitRate - 0.8) < 1e-9);

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) process.exitCode = 1;
