/**
 * /goal 命令解析 —— **纯函数，不依赖 React / DOM / fetch**，方便单独跑断言。
 *
 * 为什么要在发送路径上拦：斜杠菜单只认「第一行、以 / 开头、还没打空格」的查询词
 * （见 slash-menu.tsx 的 slashQuery），所以 `/goal 写点啥` 这种带参数的写法**进不了菜单**，
 * 只能由面板自己解析 —— 命令是给面板的，不是发给模型的一句话。
 *
 * 规则（越简单越不容易误伤正文）：
 *   /goal                               → status  （拉一次当前目标，toast 展示）
 *   /goal pause|resume|complete|clear   → action  （**整条就是动作词**才算）
 *   /goal blocked <原因>                → blocked （标阻塞必须写原因）
 *   /goal <其它任何文字>                 → create  （剩下的全文就是目标描述）
 *
 * 「整条就是动作词」是刻意的：`/goal complete the docs rewrite` 是在**设新目标**，
 * 不是把别人的目标标记完成 —— 少写一个词就误删/误停一个目标的代价太高。
 * 不认识的写法（`/goalkeeper`、正文里提到 /goal）一律返回 null，照常发给模型。
 */
import type { Goal, GoalPhase } from "@/lib/api";

export type GoalCommand =
  | { kind: "status" }
  | { kind: "create"; objective: string }
  | { kind: "blocked"; reason: string }
  | { kind: "action"; action: "pause" | "resume" | "complete" | "clear" };

/** 动作词（大小写不敏感） */
const ACTIONS = ["pause", "resume", "complete", "clear"] as const;
type GoalActionWord = (typeof ACTIONS)[number];

/**
 * 命令头：/goal 之后必须是空白或字符串结束。
 * 用 lookahead 是为了让 `/goalkeeper` 这种词不落到命令分支里。
 * \s 覆盖空格 / tab / 换行 / 全角空格（U+3000）。
 */
const HEAD = /^\/goal(?=\s|$)/i;

/** 解析一条输入；不是 /goal 命令就返回 null（调用方照常发给模型） */
export function parseGoalCommand(text: string): GoalCommand | null {
  const raw = String(text ?? "").trim();
  if (!HEAD.test(raw)) return null;

  const rest = raw.replace(HEAD, "").trim();
  if (!rest) return { kind: "status" };

  const word = rest.split(/\s+/)[0]!.toLowerCase();

  if ((ACTIONS as readonly string[]).includes(word) && rest.toLowerCase() === word) {
    return { kind: "action", action: word as GoalActionWord };
  }
  if (word === "blocked") {
    return { kind: "blocked", reason: rest.slice(word.length).trim() };
  }
  return { kind: "create", objective: rest };
}

/** phase → 中文标签（状态条和 toast 共用一份，别两处各写各的） */
export const GOAL_PHASE_LABEL: Record<GoalPhase, string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "已阻塞",
  complete: "已完成",
};

/** 认不出的 phase（老内核 / 脏数据）原样显示，不猜 */
export function goalPhaseLabel(phase: string): string {
  return GOAL_PHASE_LABEL[phase as GoalPhase] ?? String(phase ?? "");
}

/** phase → Badge 语气（颜色全走 token，见 ui/badge.tsx） */
export function goalPhaseVariant(phase: string): "default" | "warning" | "danger" | "success" {
  if (phase === "paused") return "warning";
  if (phase === "blocked") return "danger";
  if (phase === "complete") return "success";
  return "default";
}

/**
 * 截断一段可能要显示在窄处的文字（目标描述、斜杠菜单标题）。
 * 换行会被压成空格 —— 状态条和菜单都是一行，留着换行反而难看。
 */
export function truncateGoal(text: string, max = 40): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (max <= 0 || t.length <= max) return t;
  return t.slice(0, Math.max(1, max - 1)) + "…";
}

/** 一句话状态摘要（toast 用）：`进行中 · 第 3/20 轮`；阻塞时带上原因 */
export function goalSummary(goal: Goal): string {
  const head = goalPhaseLabel(goal.phase);
  const rounds = `第 ${goal.rounds_started ?? 0}/${goal.max_rounds ?? 0} 轮`;
  const reason = (goal.blocked_reason ?? "").trim();
  return reason ? `${head} · ${rounds} · 卡在：${reason}` : `${head} · ${rounds}`;
}
