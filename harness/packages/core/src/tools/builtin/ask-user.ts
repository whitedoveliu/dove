/**
 * AskUserQuestion —— 反问用户（元工具，永远在）
 * 机制：ctx.emit 发事件 → 等待 submitAnswers(toolCallId, answers)，超时 300s。
 * 纪律：超时 / 无窗口一律按「没拿到答案」返回（不抛错、不编造答案），把下一步判断交还模型。
 */
import { defineTool, S } from "../types.ts";
import { guarded } from "./util.ts";
import { APPROVAL_TIMEOUT_MS, approvalTimeoutMs, humanDuration } from "../../constants.ts";

/**
 * 等用户回答的默认上限（毫秒）。
 * 与审批共用同一个可配置项：DOVE_APPROVAL_TIMEOUT_MS（缺省 5 分钟）——
 * 「等用户回话」和「等用户点允许」是同一类等待，两个数只会让人调错一个。
 * 这里保留常量是为了给工具描述与兜底文案一个默认值；真正等待用 approvalTimeoutMs()。
 */
export const ASK_USER_TIMEOUT_MS = APPROVAL_TIMEOUT_MS;
/** 事件名：发问 / 已解答（UI 据此弹窗与收起） */
export const ASK_USER_EVENT = "tool:ask_user";
export const ASK_USER_RESOLVED_EVENT = "tool:ask_user_resolved";

export interface AskOption { label: string; description?: string }
export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options?: AskOption[];
  multi_select?: boolean;
}
export interface AskAnswer { id: string; selected: string[]; custom?: string }

const pending = new Map<string, (a: AskAnswer[] | null) => void>();
const early = new Map<string, AskAnswer[]>();

/**
 * 正在等回答的提问（toolCallId → 线程 + 问题原文）。
 *
 * 为什么需要：兼容层的 `/api/user-input` 只带线程 id、不带问题 id，它得先知道
 * "这个线程此刻在等哪个提问" 才能把答案投递进来。**没有这张表，答案永远投不进来，
 * AskUserQuestion 只能干等 5 分钟超时** —— 界面看起来就是卡住了。
 */
const meta = new Map<string, { threadId: string; questions: AskQuestion[] }>();

/** 由 server 调用：列出当前等待回答的提问 */
export function listPendingAsks(): { toolCallId: string; threadId: string; questions: AskQuestion[] }[] {
  return [...meta.entries()].map(([toolCallId, m]) => ({ toolCallId, threadId: m.threadId, questions: m.questions }));
}

/** 把一段纯文本（或 JSON 数组）回答拆成结构化答案 */
function textToAnswers(text: string, questions: AskQuestion[]): AskAnswer[] {
  let list: string[] | null = null;
  const t = text.trim();
  if (t.startsWith("[")) {
    try { const p = JSON.parse(t) as unknown; if (Array.isArray(p)) list = p.map((x) => String(x)); } catch { /* 当纯文本处理 */ }
  }
  const parts = list ?? [t];
  return questions.map((q, i) => {
    const v = parts[i] ?? parts[0] ?? "";
    const isLabel = q.options?.some((o) => o.label === v) ?? false;
    return isLabel ? { id: q.id, selected: [v] } : { id: q.id, selected: [], custom: v };
  });
}

/** 由 server 调用：用一段文本回答该提问（兼容层只有纯文本 / JSON 数组） */
export function answerWithText(toolCallId: string, text: string): boolean {
  const m = meta.get(toolCallId);
  if (!m) return false;
  return submitAnswers(toolCallId, textToAnswers(text, m.questions));
}

/** 由 server 调用：把用户答案投递给正在等待的工具调用 */
export function submitAnswers(toolCallId: string, answers: AskAnswer[]): boolean {
  const fn = pending.get(toolCallId);
  if (fn) { fn(answers); return true; }
  early.set(toolCallId, answers);
  return false;
}

/** 由 server 调用：用户关掉弹窗 / 线程中断时取消等待 */
export function cancelAsk(toolCallId: string): boolean {
  const fn = pending.get(toolCallId);
  if (fn) { fn(null); return true; }
  return false;
}

export function takeEarlyAnswers(toolCallId: string): AskAnswer[] | undefined {
  const a = early.get(toolCallId);
  if (a) early.delete(toolCallId);
  return a;
}

function waitForAnswers(id: string, timeoutMs: number, signal?: AbortSignal): Promise<AskAnswer[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (a: AskAnswer[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(a);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onAbort = () => finish(null);
    pending.set(id, finish);
    if (signal) {
      if (signal.aborted) finish(null);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function normalizeQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("questions 必须是非空数组");
  if (raw.length > 4) throw new Error("一次最多问 4 个问题（当前 " + raw.length + "）");
  return raw.map((q, i) => {
    const o = (q ?? {}) as Record<string, unknown>;
    const question = String(o.question ?? "").trim();
    if (!question) throw new Error("第 " + (i + 1) + " 个问题缺少 question");
    const options = Array.isArray(o.options)
      ? o.options.map((op) => {
          const oo = (op ?? {}) as Record<string, unknown>;
          return { label: String(oo.label ?? "").trim(), description: oo.description === undefined ? undefined : String(oo.description) };
        }).filter((op) => op.label)
      : undefined;
    return {
      id: String(o.id ?? ("q" + (i + 1))),
      question,
      header: o.header === undefined ? undefined : String(o.header),
      options,
      multi_select: o.multi_select === undefined ? undefined : Boolean(o.multi_select),
    };
  });
}

export const AskUserQuestionTool = defineTool({
  name: "AskUserQuestion",
  description:
    "向用户提问并等待回答（最多 4 问，可给选项）。用于需要用户拍板、缺少关键信息、或有多种做法要选的时候；" +
    "能用合理默认值推进的就别问。超时（" + Math.round(ASK_USER_TIMEOUT_MS / 1000) + " 秒）或用户没回答时会明确告诉你「没拿到答案」，不要编造用户的回答。",
  parameters: S.obj({
    questions: S.arr(
      S.obj({
        id: S.str("问题 id（用于对答案，如 q1）"),
        question: S.str("要问的问题（具体、可回答）"),
        header: S.str("短标题（如「确认」「选风格」）"),
        options: S.arr(S.obj({ label: S.str("选项文案"), description: S.str("一句话说明影响") }, ["label"]), "可选项；不给则自由回答"),
        multi_select: S.bool("是否允许多选（默认 false）"),
      }, ["id", "question"]),
      "要问的问题列表",
    ),
  }, ["questions"]),
  outputTier: "passthrough",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const questions = normalizeQuestions(input.questions);

    const pre = takeEarlyAnswers(ctx.toolCallId);
    if (pre) {
      return { answers: pre, timed_out: false, note: "用户已就本次提问给出回答。" };
    }

    // 等待上限可配置（DOVE_APPROVAL_TIMEOUT_MS），与审批同源 —— 见文件头
    const timeoutMs = approvalTimeoutMs();
    // 先登记等待，再发事件 —— 避免「答案比等待先到」的竞态
    const wait = waitForAnswers(ctx.toolCallId, timeoutMs, ctx.signal);
    meta.set(ctx.toolCallId, { threadId: ctx.threadId, questions });
    ctx.emit(ASK_USER_EVENT, { toolCallId: ctx.toolCallId, threadId: ctx.threadId, questions });

    const answers = await wait;
    meta.delete(ctx.toolCallId);
    ctx.emit(ASK_USER_RESOLVED_EVENT, { toolCallId: ctx.toolCallId, answered: Boolean(answers) });

    if (!answers) {
      return {
        answers: [],
        timed_out: true,
        questions,
        note: "没有拿到用户回答（等了 " + humanDuration(timeoutMs) + " 被自动收尾，或窗口不可用）。" +
          "不要假设用户选了什么：可以先做不受影响的部分，或稍后再问。" +
          "（等待时长可用环境变量 DOVE_APPROVAL_TIMEOUT_MS 调整。）",
      };
    }
    return { answers, timed_out: false, note: "收到的回答见 answers（selected 是被选中的 label，custom 是自由输入）。" };
  }),
});
