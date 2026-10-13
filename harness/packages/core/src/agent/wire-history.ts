/**
 * parts → provider 历史消息（从 runtime.ts 拆出来）
 *
 * 这是一块独立且容易出错的逻辑，单独放一个文件有两个好处：
 * ① runtime.ts 守住 400 行上限；② 配对规则可以单独测。
 *
 * 铁律一：**每个 tool_call 都必须有配对的 tool 消息**，否则 provider 直接拒绝请求。
 *         所以除 output-available 之外的状态一律补一条 error 结果。
 *
 * 铁律二：**重建出来的消息序列必须与实时上过 wire 的序列逐字节一致**（前缀缓存的全部来源）。
 *   缓存命中的长度 = 「当前请求与历史请求逐字节相同的那个前缀」的长度，差一个字节就整段作废。
 *   ⚠️ 这条铁律**不只是注释**：DOVE_WIRE_ASSERT=1 时会真的比对并在不一致处抛出
 *   （见文件尾的 createWireSnapshot / assertWireStable）。默认关 —— 断言不该把对话打挂。
 *   为此整条链上每一处都要照实时原文落库：
 *   ① 一步一条 assistant 消息：库里一轮只落一条，重建按**步记号**切回若干步；
 *   ② tool_calls 的 arguments 用 inputRaw（provider 原文），不许 JSON.stringify 重排版；
 *   ③ 尾上下文（`[Context: …]` + 记忆切片）贴到当轮最新 user 消息上时**当场落库**（attachTail），
 *      重建时原样重放 —— 以前它只活在那次请求里，下一轮这条消息还原成裸文本，
 *      从它往后（上一轮的 assistant / tool / 新一轮 user）全部按全价重付；
 *   ④ 中途注入的 user 消息（steering / 闸门提醒）落成 injection part，重建时在**同一位置**重放。
 *
 * 切步规则（①）：parts 里一步 = [若干 text part] + [若干 tool part]，步与步之间由 runtime 打的
 * `step-start` 记号分开。一步**并行多个 tool_call** 与「两步各一次调用」在 parts 里长得一样，
 * 只有记号分得开 —— 所以记号是必需的，不是锦上添花。老数据（记号之前落的库）没有记号，
 * 退回「每个 tool part 各自一步」的近似。
 *
 * ⚠️ 一轮里若真发生「两步之间夹着纯文本步」，靠的是每步一条 text part（text-collector.ts
 *    的 flush 会封口）—— 连续两条 text part 之间就是一步边界。
 * ⚠️ 已知残留（有意留在这里，不在本次范围内）：ReadImage 中途挂上的图片消息由 ImageRelay
 *    以**挂载时刻**的 createdAt 落库，而一轮的 assistant 行在回合末才落 —— 重建时它会排在
 *    整条 assistant 行之前（实时是插在某一步之后）。在此之前，带图回合的缓存前缀到那条图片消息为止。
 *    ⚠️ 要修的话**别把图片改走循环的注入通道**（loop/turn.ts 的 pushMsg / onUserInjection）：
 *    那些消息被记进「本轮在飞段」，压缩落检查点（agent/history-assembly.ts 的 persistCompactedHistory）
 *    会把它剥掉，而它挂载时刻的 createdAt 又早于检查点的 at（`created_at > at` 取不回来）——
 *    两边都取不到 = 模型此后每一轮都看不到那张图，而工具结果里还写着「图片已经挂进这次对话了」。
 *    正确修法要么让图片保留挂载时刻之外的第二身份（见 image-attach.ts 顶部），要么把落库时机整体前移。
 * ⚠️ 这里**不注入**崩溃修复交代（repair notice）：它是「当前这一轮」的提醒，走 tail-context
 *    贴到最新一条 user 消息上（见 session/repair.ts 的契约与 agent/runtime.ts 的 effectiveTail）。
 */
import type { ChatMessage, ToolCallPayload } from "../providers/types.ts";
import type { Message, ToolPart } from "../session/types.ts";
import { isToolPart } from "../session/types.ts";
import type { Store } from "../session/store.ts";
import { hydrateImages } from "../context/images.ts";
import { buildInjectionPrefix, prependText } from "../context/tail-context.ts";

/**
 * 把「本轮实时贴上的尾上下文前缀」落进它贴上的那条消息（metadata.tail）。
 *
 * 返回值就是交给 runTurn 的注入参数（值比较门跳过时为空 —— 不注入、不落库）。
 *
 * 值比较门（DSH 纪律）：渲染结果与**上一条带尾上下文的 user 消息**逐字节相同时，
 * 跳过不贴 —— 那份一模一样的原文还留在历史里（模型照常看得到），再贴一遍只是重复内容。
 * 时间锚按分钟渲染，同一分钟里的连续几轮就会走到这条路径上。
 */
export function attachTail(o: {
  store: Store;
  messageId: string;
  history: Message[];
  tailContext: string;
  memoriesBlock: string;
}): { tailContext?: string; memoriesBlock?: string } {
  const prefix = buildInjectionPrefix(o.tailContext, o.memoriesBlock);
  if (!prefix) return {};
  const prev = [...o.history].reverse().find((m) => m.role === "user" && m.tail)?.tail;
  if (prefix === prev) return {};
  o.store.setMessageTail(o.messageId, prefix);
  return { tailContext: o.tailContext, memoriesBlock: o.memoriesBlock };
}

/** tool part → wire 上的 tool_calls 元素；没有参数（连 raw 都没有）时返回 null */
function toWireCall(p: ToolPart): ToolCallPayload | null {
  const args = p.inputRaw ?? (p.input !== undefined ? JSON.stringify(p.input) : undefined);
  if (args === undefined) return null;
  return { id: p.toolCallId, type: "function", function: { name: p.toolName, arguments: args } };
}

/** tool part → 配对的 tool 消息；除 output-available 之外的状态一律补一条 error 结果（铁律一） */
function toolResult(p: ToolPart): ChatMessage {
  return {
    role: "tool", tool_call_id: p.toolCallId, name: p.toolName,
    content: p.state === "output-available"
      ? JSON.stringify(p.output ?? {})
      : JSON.stringify({ error: p.errorText ?? (p.state === "permission-denied" ? "用户拒绝了这次操作" : "该动作未完成，结果未知") }),
  };
}

export function toWireHistory(
  messages: Message[], threadId: string, supportsImages = true,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.threadId !== threadId) continue;
    if (m.role === "user") {
      const text = m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
      const imageRefs = m.parts.filter((p) => p.type === "image" || p.type === "file")
        .map((p) => String((p as { url?: string }).url ?? "")).filter(Boolean);
      let content: ChatMessage["content"];
      if (imageRefs.length > 0) {
        // 有图：组装成 content block（图片按需读成 data URL，引用本身留在库里）
        const h = hydrateImages(imageRefs, { supportsImages });
        const combined = [text, ...h.notes].filter(Boolean).join("\n");
        content = [{ type: "text", text: combined }, ...h.blocks];
      } else {
        content = text;
      }
      // 尾上下文重放：与实时 injectIntoLastUser 走**同一个** prependText，块状/字符串两种形态一致
      if (m.tail) content = prependText(content, m.tail);
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      // 切步：见文件头「切步规则」。记号在 = 精确重建；记号不在 = 老数据退回近似。
      const marked = m.parts.some((p) => p.type === "step-start");
      let text = "";
      let tools: ToolPart[] = [];
      const flushStep = (): void => {
        const calls = tools.map(toWireCall).filter((c): c is ToolCallPayload => c !== null);
        if (text || calls.length > 0) {
          out.push({ role: "assistant", content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
        }
        for (const p of tools) out.push(toolResult(p));
        text = ""; tools = [];
      };
      for (const p of m.parts) {
        if (p.type === "step-start") { flushStep(); continue; }
        // 中途注入的 user 消息：实时是「说完这一步 → 插一条 user → 下一步」，这里同位置重放
        if (p.type === "injection") { flushStep(); out.push({ role: "user", content: p.text }); continue; }
        if (p.type === "text") {
          // 一步一条 text part：连续两条之间就是纯文本步的边界（没记号的回合按老口径归属到下一步）
          if (!marked && text) flushStep();
          text = marked ? text + (p as { text: string }).text : (p as { text: string }).text;
          continue;
        }
        if (!isToolPart(p)) continue;   // reasoning / image 不上 wire
        tools.push(p);
        if (!marked) flushStep();       // 老口径：一步一次调用
      }
      flushStep();
    }
  }
  return out;
}

/** 去掉最后一条 user（runTurn 会把本轮消息重新加回去；它只认 role，不看是不是注入） */
export function dropLastUser(msgs: ChatMessage[]): ChatMessage[] {
  const out = [...msgs];
  for (let i = out.length - 1; i >= 0; i--) if (out[i]!.role === "user") { out.splice(i, 1); break; }
  return out;
}

// ── 铁律二的可执行版本 ────────────────────────────────
// 上面那段铁律从前只是注释：违反了没有任何东西出声，只有账单（缓存前缀整段作废）
// 和「模型看到的历史与用户以为的不一样」两种静默后果。这里把它变成会抛的检查。

/**
 * 开关：**只有逐字节等于 "1"** 才算开（缺省**关**）。
 * 为什么默认关：这是一条会抛的断言。生产路径上任何一处重建的口径差（老数据、跨版本、
 * 有意为之的降级）都会把整轮对话打挂 —— 那个代价远大于「少发现一次缓存浪费」。
 * 所以：平时静默，想查缓存问题时 `DOVE_WIRE_ASSERT=1` 打开，让它当场炸出下标与字段名。
 */
function wireAssertOn(): boolean {
  return process.env.DOVE_WIRE_ASSERT === "1";
}

/**
 * 实时那一刻的 wire 快照（深拷贝）。
 * ⚠️ 必须深拷贝：provider 收到的是**同一个数组引用**，后续步骤还会往里 push / 改字段；
 *    不拷贝的话「快照」会跟着一起变，比对永远通过 —— 校验就成了摆设。
 * 用法：在 messages 真正上 wire 的地方存一份（不用改 runtime，存哪儿由调用方决定），
 *       下一轮重建出来之后交给 assertWireStable。
 */
export function createWireSnapshot(messages: ChatMessage[]): ChatMessage[] {
  return structuredClone(messages);
}

/** 上 wire 的字段全集：比对与诊断都按它走（以后加字段也不会漏比） */
const WIRE_FIELDS = ["role", "content", "tool_calls", "tool_call_id", "name"] as const;

/** 值比较：逐字节（JSON 序列化后再比）—— 前缀缓存吃的就是这个口径，不是「语义相等」 */
function sameBytes(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 这条消息里**第一个都不一样**的字段名（空数组 = 逐字节相同） */
function diffFields(a: ChatMessage, b: ChatMessage): string[] {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  return WIRE_FIELDS.filter((f) => !sameBytes(ra[f], rb[f]));
}

/** 诊断样本：截到 160 字符（贴全文会把错误信息本身变成一堵墙） */
function brief(v: unknown): string {
  let s: string;
  try { s = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v)); } catch { s = String(v); }
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}

/** 规范化：对象按键名排序后序列化（**只用于诊断**，判断两边的 tool_calls 是不是「内容等价、字节不同」） */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** 解析 arguments（解析不了就返回带标记的原串：不做「大概相等」这种模糊判定） */
function parsed(s: unknown): unknown {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return `__unparsable__:${s}`; }
}

/**
 * tool_calls 是否「内容等价、只是字节不同」—— 专认**重新排版**这一种。
 * arguments 是 provider 给的 JSON 字符串，重建时若走 JSON.stringify(parse(...))，
 * 键序 / 空格就变了：缓存从这一条起整段作废，而模型与界面都看不出差别，
 * 只有账单看得见 —— 所以诊断里要专门点出来（见 fieldMessage 的 hint）。
 */
function sameCallsIgnoringFormat(a: ChatMessage, b: ChatMessage): boolean {
  const norm = (calls?: ToolCallPayload[]): string => canonical((calls ?? []).map((t) => ({
    id: t.id, name: t.function?.name, args: parsed(t.function?.arguments),
  })));
  return norm(a.tool_calls) === norm(b.tool_calls);
}

/** 字段级差异的诊断：下标 + 该条角色 + 不同字段名（+ 已知成因的提示） */
function fieldMessage(i: number, a: ChatMessage, b: ChatMessage, fields: string[]): string {
  // 两种最常见成因给定向提示：只说「字段不同」，读的人还得自己把这条链重读一遍
  const reorder = fields.includes("tool_calls") && sameCallsIgnoringFormat(a, b)
    ? "（内容等价但字节不同：arguments 必须照抄 provider 原文 inputRaw，不许 JSON.stringify 重排版）"
    : "";
  const swapped = fields.includes("role")
    ? "（两边这一位的消息类型都不同：多半是少 / 多了一条配对的 tool 结果（铁律一），或顺序被调换）"
    : "";
  return "wire 重建与实时不一致（铁律二：重建必须逐字节等于实时上过 wire 的序列）："
    + `从第 ${i} 条（role=${a.role}）的字段 ${fields.join(" / ")} 开始不同${reorder}${swapped}。`
    + `重建=${brief((a as unknown as Record<string, unknown>)[fields[0]!] ?? a.content)} `
    + `实时=${brief((b as unknown as Record<string, unknown>)[fields[0]!] ?? b.content)}`;
}

/** 条数对不上的诊断：下标 + 这一位上两边各是什么角色 */
function lengthMessage(i: number, rebuilt: ChatMessage[], live: ChatMessage[]): string {
  const a = rebuilt[i];
  const b = live[i];
  const where = a ? `重建这一位是 role=${a.role}` : `实时这一位是 role=${b?.role}`;
  return "wire 重建与实时不一致（铁律二：重建必须逐字节等于实时上过 wire 的序列）："
    + `从第 ${i} 条开始条数对不上 —— 重建 ${rebuilt.length} 条 / 实时 ${live.length} 条（${where}）。`
    + "常见成因：少了一条配对的 tool 结果（铁律一），或一步里的多个 tool_call 被拆开 / 并到一起。";
}

/**
 * 开 DOVE_WIRE_ASSERT=1 时启用：重建结果与实时快照逐字节比对，不一致就抛
 * （消息里说清「从第几条、哪个字段开始不同」）。
 *
 * 诊断刻意做到「一眼知道去改哪」：下标、该条 role、不同的字段名，
 * 外加两种最常见成因的定向提示（arguments 被重排版 / 少了一条 tool 结果）。
 * 只说「不相等」的错误信息等于让人从头把这条链再读一遍 —— 那正是它最不划算的地方。
 *
 * 两条的**长度也要一样**：比的是同一时刻的两份序列。下一轮的请求天然比上一轮多一条 user，
 * 那种「前缀相等」的场景由调用方自己截到相同长度再比（`rebuilt.slice(0, live.length)`）。
 */
export function assertWireStable(rebuilt: ChatMessage[], live: ChatMessage[]): void {
  if (!wireAssertOn()) return;
  const max = Math.max(rebuilt.length, live.length);
  for (let i = 0; i < max; i++) {
    const a = rebuilt[i];
    const b = live[i];
    if (!a || !b) throw new Error(lengthMessage(i, rebuilt, live));
    const fields = diffFields(a, b);
    if (fields.length > 0) throw new Error(fieldMessage(i, a, b, fields));
  }
}
