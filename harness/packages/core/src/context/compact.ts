/**
 * AutoCompact（T2.6 / T2.7）
 * 纪律：① 保留段的**下限**是「最近一个回合 + 用户真正说过的话」：工具密集的回合里
 *          几十个大 tool result 会把最初那条需求挤出去，压缩完模型就不知道用户要什么了。
 *          按回合数保留做不到这件事（Kimi 与 Codex 两份独立实现都改成了「按 20000 token
 *          预算保住真实用户消息、头 2000 专门留给最早那条」）；
 *       ② **压缩当场落检查点**（agent/runtime.ts 的 onBeforeStep）—— 于是同一轮里可能压第二次，
 *          第二次的输入已经是压缩结果（`messages` 被就地换掉、前缀整体前移）。由此两条纪律：
 *          ①「本轮在飞的段」只能按**对象身份**剥（agent/history-assembly.ts 的 persistCompactedHistory），
 *          任何按下标算的前缀边界到第二次就错位，剥不干净的段会在下一轮 wire 上出现两遍；
 *          ② 检查点的 at 必须早于回合末才落库的那些消息（同毫秒会让下一轮取不回它们，消息直接消失）。
 *       ③ 摘要失败退化为粗暴截断并显式标记，绝不假装成功。
 */
import {
  COMPACT_DEFAULT_THRESHOLD,
  COMPACT_KEEP_RECENT_RANGE,
  COMPACT_KEEP_RECENT_TURNS,
  COMPACT_KEEP_USER_HEAD_TOKENS,
  COMPACT_KEEP_USER_TOKENS,
  COMPACT_MAX_OUTPUT_FALLBACK,
  COMPACT_MIN_STEP_GAP,
  COMPACT_TARGET_MIN_FRACTION,
  COMPACT_TARGET_WINDOW_FRACTION,
  COMPACT_THRESHOLD_RANGE,
  COMPACT_WIRE_RATIO_MAX,
} from "../constants.ts";
import type { ChatMessage, ToolSchema } from "../providers/types.ts";
import type { Usage } from "../session/types.ts";
import { buildCompactPrompt, renderConversationForSummary } from "./compact-prompt.ts";
import { renderRecoveryFooter, type RecoveryInfo } from "./recovery-footer.ts";
import { estimateMessagesTokens, estimateTextTokens, estimateToolDefsTokens, findSafeSplitPoint, keepRecentTurnsStart } from "./tokens.ts";

export interface CompactConfig {
  enabled: boolean;
  /** 触发阈值：上下文窗口的百分比（夹 60–95，默认 80） */
  threshold: number;
  /**
   * 保留最近多少「对话回合」作为**连续段**（夹 2–20，默认 4）—— 单位是回合不是消息。
   * 注意它只是保留段的一部分：真实用户消息（见 isKeptUserMessage）在此之外另按
   * COMPACT_KEEP_USER_TOKENS 预算保，且最近一个回合无论如何都留全。
   */
  keepRecentMessages: number;
  /** 模型最大输出 token；判据里与 32000 取较小者做输出预留 */
  maxOutputTokens: number;
  /** 系统提示词 + 工具 schema 在 wire 上的放大幅度（夹 1–3） */
  wireRatio: number;
}

export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  enabled: true,
  threshold: COMPACT_DEFAULT_THRESHOLD,
  keepRecentMessages: COMPACT_KEEP_RECENT_TURNS,
  maxOutputTokens: COMPACT_MAX_OUTPUT_FALLBACK,
  wireRatio: 1,
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** 归一化配置：阈值夹 [60,95]，保留回合夹 [2,20]，wireRatio 夹 [1,3] */
export function normalizeCompactConfig(partial: Partial<CompactConfig> = {}): CompactConfig {
  const base = { ...DEFAULT_COMPACT_CONFIG, ...partial };
  return {
    enabled: base.enabled !== false,
    threshold: Math.round(clamp(base.threshold, COMPACT_THRESHOLD_RANGE[0], COMPACT_THRESHOLD_RANGE[1])),
    keepRecentMessages: Math.round(clamp(base.keepRecentMessages, COMPACT_KEEP_RECENT_RANGE[0], COMPACT_KEEP_RECENT_RANGE[1])),
    maxOutputTokens: Math.max(0, Math.round(Number.isFinite(base.maxOutputTokens) ? base.maxOutputTokens : COMPACT_MAX_OUTPUT_FALLBACK)),
    wireRatio: clamp(base.wireRatio, 1, COMPACT_WIRE_RATIO_MAX),
  };
}

/** wire 开销：系统提示词 + 工具定义的估算值 × wireRatio */
export function estimateWireOverhead(systemPrompt: string, toolDefs: ToolSchema[], wireRatio: number): number {
  const ratio = clamp(wireRatio, 1, COMPACT_WIRE_RATIO_MAX);
  return Math.ceil((estimateTextTokens(systemPrompt) + estimateToolDefsTokens(toolDefs)) * ratio);
}

/**
 * 超限判定：used = max(真实 usage, 估算 wire 开销) 与 limit 比较，
 * limit 取「窗口 × threshold%」与「窗口 − min(maxOutput, 32000)」中的较小者 ——
 * 前者是可调触发线（默认 80%），后者是硬上限（给输出留空间，绝不越过）。
 */
export function shouldCompact(
  usage: Usage,
  systemPrompt: string,
  toolDefs: ToolSchema[] | undefined,
  cfg: CompactConfig,
  contextWindow: number,
): boolean {
  if (!cfg.enabled) return false;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  const c = normalizeCompactConfig(cfg);
  const reserve = Math.min(c.maxOutputTokens, COMPACT_MAX_OUTPUT_FALLBACK);
  const limit = Math.min(contextWindow - reserve, Math.floor((contextWindow * c.threshold) / 100));
  const real = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens) + Math.max(0, usage.cacheReadTokens);
  const used = Math.max(real, estimateWireOverhead(systemPrompt, toolDefs ?? [], c.wireRatio));
  return used > limit;
}

/** 去抖：距上次压缩 step 不足 COMPACT_MIN_STEP_GAP 就不许再压（防抖动） */
export function shouldSkipForDebounce(lastCompactStep: number | undefined, currentStep: number): boolean {
  if (lastCompactStep === undefined || lastCompactStep < 0) return false;
  return currentStep - lastCompactStep < COMPACT_MIN_STEP_GAP;
}

export interface CompactOptions {
  /** 摘要器：调用方用 COMPACT_SYSTEM_PROMPT + buildCompactPrompt(transcript) 调模型 */
  summarize: (text: string) => Promise<string>;
  cfg: CompactConfig;
  contextWindow: number;
  /**
   * 「这条算不算用户真正说过的话」的判据；缺省用 defaultIsKeptUserMessage。
   * 可覆盖是为了让宿主能按自己的注入通道（比如别的包装标签）判定。
   */
  isKeptUserMessage?: (m: ChatMessage) => boolean;
  /** 磁盘上的事件日志 / spill 目录信息，用于在摘要末尾追加 Context Recovery 指针 */
  recovery?: RecoveryInfo;
}

export interface CompactResult {
  messages: ChatMessage[];
  /** 摘要正文；退化为截断时为空串 */
  summary: string;
  /** true = 走了粗暴截断（日志里标记 Fallback: truncated） */
  fallback: boolean;
  /** 被移出上下文的消息条数 */
  droppedMessages: number;
  /** 被用户消息规则从 head 里**捞回来**的条数（含在 messages 里，不算它们就白压了一次） */
  keptUserMessages?: number;
  /** 实际追加到摘要末尾的 Context Recovery 段；退化路径没有它 */
  recoveryFooter?: string;
}

/**
 * 压缩产物的识别前缀。
 * ⚠️ 判这个坑：**不能只判 `[Context:`** —— tail-context 的注入前缀同样是 `[Context: `
 * （见 context/tail-context.ts 的 buildInjectionPrefix），但它是**贴在真实用户消息前面**的；
 * 只判短前缀会把用户的原话整条当成压缩产物丢掉，正好丢掉这次改动要保住的东西。
 * 所以压缩产物只认自己这个更长的前缀（summaryMessage / fallbackMessage 都由它拼出来，不会漂移）。
 */
export const COMPACT_PRODUCT_MARK = "[Context: 更早的";

/** 注入提醒的形状（模式注入 / 完成守卫 / 权限续跑 / 崩溃修复都是这一种） */
const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** 取消息文本：字符串直接给，块状取 text 块（图片块没有文字可留） */
function messageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("\n").trim();
  }
  return "";
}

/** 去掉所有 system-reminder 块之后什么都不剩 ⇒ 这条是注入，不是人说的 */
function isReminderOnly(text: string): boolean {
  if (!text.includes("<system-reminder>")) return false;
  return text.replace(REMINDER_BLOCK, "").trim().length === 0;
}

/**
 * 默认判据：这条消息是不是「用户真正说过的话」。
 * 排掉两种 role=user 但**不是用户说的话**的消息：
 *   ① 压缩产物（summaryMessage / fallbackMessage）—— 留住它会形成「摘要里套摘要」；
 *   ② 只由 `<system-reminder>…</system-reminder>` 组成的注入（模式 / 续跑 / 权限提醒）。
 * 而带 tail-context 前缀（`[Context: 时间锚 + 任务 + 记忆切片]\n\n用户原话`）的消息**要留**：
 * 前缀是贴在真实用户消息身上的，前缀之后就是用户的原文（见 messageText + COMPACT_PRODUCT_MARK 的注释）。
 */
export function defaultIsKeptUserMessage(m: ChatMessage): boolean {
  if (m.role !== "user") return false;
  const text = messageText(m.content).trim();
  if (!text) return false;
  if (text.startsWith(COMPACT_PRODUCT_MARK)) return false;
  if (isReminderOnly(text)) return false;
  return true;
}

/** 摘要消息：以 user 身份承载（不塞回 system，避免破坏前缀缓存） */
export function summaryMessage(summary: string): ChatMessage {
  return {
    role: "user",
    content: `${COMPACT_PRODUCT_MARK}对话已被压缩（原文已移出上下文以节省空间）。以下是继续工作所需的结构化摘要：]\n\n${summary}`,
  };
}

/** 退化消息：明确标记，不假装摘要成功 */
export function fallbackMessage(dropped: number): ChatMessage {
  return {
    role: "user",
    content: `${COMPACT_PRODUCT_MARK} ${dropped} 条消息已从上下文移除。Fallback: truncated —— 摘要步骤失败，这些内容的细节已不可用；需要时请让用户重述，或重新读相关文件确认。]`,
  };
}

interface UserKeepPick {
  /** 保留下来的用户消息下标（升序） */
  idx: number[];
  /** 这些消息一共占掉多少 token 预算 */
  tokens: number;
}

/**
 * 按 token 预算挑要**原样保留**的真实用户消息（压缩后模型唯一还能看到的原始事实）。
 *
 * 头预算专门留给**最早**那条：工具密集的回合动辄几十个大 tool result，如果只从最新往回塞，
 * 第一屏就被塞满，用户最初那句需求永远轮不到 —— 那正是「压缩完模型不知道用户要什么」的根因。
 * 头预算的语义是「挤不掉」，不是「不许超过」：最早那条比头预算还大时照样整条保留，
 * 超出的部分从总预算里扣（把最初诉求整条丢掉才是最大的失败模式）。
 * 从最新往回塞时遇到第一条塞不下的就**停**、不跳过继续往前找：保住「新」比保住「便宜」重要。
 */
export function pickKeptUserMessages(
  msgs: ChatMessage[],
  isKept: (m: ChatMessage) => boolean,
  budget: number,
  headBudget: number,
  limit = msgs.length,
): UserKeepPick {
  const stop = Math.max(0, Math.min(limit, msgs.length));
  const cand: { i: number; cost: number }[] = [];
  for (let i = 0; i < stop; i++) {
    const m = msgs[i]!;
    if (isKept(m)) cand.push({ i, cost: estimateMessagesTokens([m]) });
  }
  if (cand.length === 0 || budget <= 0) return { idx: [], tokens: 0 };

  const head = Math.min(headBudget, budget);
  const idx: number[] = [];
  let used = 0;
  const first = cand[0]!;
  if (first.cost <= budget) { idx.push(first.i); used = first.cost; }

  // 尾预算 = 总预算 − max(头预算, 最早那条实占)：头预算先划走，剩下的才轮到从最新往回塞
  const fillBudget = Math.max(0, budget - Math.max(head, used));
  let fill = 0;
  for (let k = cand.length - 1; k >= 1; k--) {
    const c = cand[k]!;
    if (fill + c.cost > fillBudget) break;
    fill += c.cost;
    idx.push(c.i);
  }
  idx.sort((a, b) => a - b);
  return { idx, tokens: used + fill };
}

/**
 * 压缩主流程：摘要早期对话，保留「最近一个回合 + 真实用户消息 + 最近若干回合」。
 * 保留段是三者的并集：最近一段连续尾巴（既有安全网：窗口 60% + findSafeSplitPoint 的安全边界
 * + 最近一个回合无论如何留全），以及按 20000 token 预算捞回来的真实用户消息。
 * 这条路径**不动** summaryMessage / fallbackMessage 的语义与去抖，也不改 shouldCompact 的判据。
 */
export async function compact(msgs: ChatMessage[], opts: CompactOptions): Promise<CompactResult> {
  const cfg = normalizeCompactConfig(opts.cfg);
  const window = Number.isFinite(opts.contextWindow) && opts.contextWindow > 0 ? opts.contextWindow : 0;
  // 保留段还要受预算约束（窗口的 60%），否则压缩完仍然超限，会陷入「压缩 → 再压缩」
  const keepBudget = window > 0 ? Math.floor(window * COMPACT_TARGET_WINDOW_FRACTION) : Number.MAX_SAFE_INTEGER;

  const turnStart = keepRecentTurnsStart(msgs, cfg.keepRecentMessages);
  const lastTurnStart = keepRecentTurnsStart(msgs, 1);
  // 先按满预算量出「最近这段」的粗略起点：用户消息只从它**之前**挑，
  // 免得尾巴里那条用户消息被算两次预算，把本来能捞的老消息挤掉。
  const rough = findSafeSplitPoint(msgs, turnStart, keepBudget);

  const isKept = opts.isKeptUserMessage ?? defaultIsKeptUserMessage;
  const userBudget = Math.min(COMPACT_KEEP_USER_TOKENS, keepBudget);
  const pick = pickKeptUserMessages(msgs, isKept, userBudget, COMPACT_KEEP_USER_HEAD_TOKENS, rough);

  // 尾巴仍在安全边界上、仍受 60% 约束（这里要把用户消息已占的预算扣掉）；下限 = 最近一个回合
  const tailStart = Math.min(
    findSafeSplitPoint(msgs, turnStart, Math.max(0, keepBudget - pick.tokens)),
    lastTurnStart,
  );

  const keptIdx = new Set(pick.idx);
  const tail = msgs.slice(tailStart);

  // 补救：窗口预算把尾巴往前推之后，[rough, tailStart) 里的用户消息本来指望尾巴兜住，
  // 现在两边都不管 —— 用**没花掉的**预算从最新往回再捞一次（花掉的 = 用户预算剩的、窗口预算剩的，取小）。
  const spare = Math.min(userBudget - pick.tokens, keepBudget - pick.tokens - estimateMessagesTokens(tail));
  if (spare > 0) {
    let used = 0;
    for (let i = tailStart - 1; i >= rough; i--) {
      const m = msgs[i]!;
      if (!isKept(m)) continue;
      const cost = estimateMessagesTokens([m]);
      if (cost > spare - used) break;
      used += cost;
      keptIdx.add(i);
    }
  }

  const head = msgs.filter((_, i) => i < tailStart && !keptIdx.has(i));
  if (head.length === 0) {
    return { messages: msgs.slice(), summary: "", fallback: false, droppedMessages: 0, keptUserMessages: 0 };
  }

  // 捞回来的用户消息按原顺序插在摘要与尾巴之间（每条都是独立的 user 消息，不会带出孤儿 tool 结果）
  const extras = msgs.filter((_, i) => i < tailStart && keptIdx.has(i));
  // 摘要输入预算：窗口的 15%（下限 1000 token）；中文约 2 字符/token
  const inputTokens = window > 0 ? Math.max(1000, Math.floor(window * COMPACT_TARGET_MIN_FRACTION)) : 8000;
  const transcript = renderConversationForSummary(head, inputTokens * 2);

  const footer = renderRecoveryFooter(opts.recovery);

  try {
    const summary = (await opts.summarize(buildCompactPrompt(transcript))).trim();
    if (summary.length > 0) {
      return {
        messages: [summaryMessage(footer ? `${summary}\n\n${footer}` : summary), ...extras, ...tail],
        summary,
        fallback: false,
        droppedMessages: head.length,
        keptUserMessages: extras.length,
        recoveryFooter: footer || undefined,
      };
    }
  } catch {
    // 落到下面的粗暴截断
  }
  // 退化路径**不挂 footer**：这时根本没有摘要，指针说「这是摘要之前的原文位置」是假话；
  // 模型会因为「有可信摘要」而不再回头确认，反而比不给更糟。
  // （捞回来的用户消息照留 —— 摘要失败的时候，用户的原话是唯一还没丢的东西。）
  return {
    messages: [fallbackMessage(head.length), ...extras, ...tail],
    summary: "",
    fallback: true,
    droppedMessages: head.length,
    keptUserMessages: extras.length,
  };
}
