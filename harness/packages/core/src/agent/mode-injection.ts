/**
 * 每轮模式（mode）：把「这一轮该怎么跑」当**请求状态**处理，指令以**独立消息**送给模型。
 *
 * 为什么要有这个文件（它存在的唯一理由）：
 * 面板原来只能把「本轮用 swarm」塞进用户消息的文本里，用户说的话就被污染了 ——
 * 回放、审计、记忆摘要都分不清哪句是用户说的、哪句是宿主加的。
 * 所以这里的纪律是：**用户消息逐字节保持原样**，模式指令另起一条 `role:"user"` 的消息，
 * 用 `<system-reminder>` 包起来（和崩溃修复交代 / 完成守卫同一个通道形状）。
 *
 * 落库纪律：注入记录带 `origin` / `variant` 两个字段。
 *   - 面板按 `origin === "injection"` 过滤 → 它永远不会渲染成用户的气泡；
 *   - 模型照常看到它 —— **包括这一线程之后的回放**（历史装配走的是同一条门）。
 * 两件事互不干扰，靠的就是这条记录自带来源标记，而不是靠某个开关。
 *
 * 注入**一轮一次**（runtime.run 开头落库），不是每个 step 一次。
 */
import { randomUUID } from "node:crypto";
import type { Message } from "../session/types.ts";
import type { Store } from "../session/store.ts";
import type { EventLog } from "../session/event-log.ts";
import { loadPrompt } from "../context/segments.ts";

/** 面板能表达的一轮模式 —— 与 legacy `/api/chat` 的 `body.mode` 同一份取值（单点定义） */
export const TURN_MODES = ["plan", "goal", "swarm"] as const;
export type TurnMode = (typeof TURN_MODES)[number];

/** 请求里带了 mode 就必须是这三个之一（路由据此回 400，别的层不要自己再判一遍） */
export function isTurnMode(v: unknown): v is TurnMode {
  return typeof v === "string" && (TURN_MODES as readonly string[]).includes(v);
}

/** 注入记录的来源标记：面板按 origin 过滤，variant 说明是哪一种注入 */
export const INJECTION_ORIGIN = "injection";
export const SWARM_MODE_VARIANT = "swarm-mode";

export interface ModeInjectDeps {
  store: Store;
  threadId: string;
  eventLog?: EventLog;
  runId?: string;
}

/**
 * swarm 轮的提醒正文 = 提示词资产 `packages/prompts/swarm-mode.md`
 * （sNN 编号槽位是**系统提示词**专用，模式提醒不能占，否则会被拼进前缀缓存）。
 * 读不到就**不注入**：模式提醒缺失不该把整轮对话弄挂。
 */
async function swarmReminder(): Promise<string | null> {
  try {
    const body = (await loadPrompt("swarm-mode")).trim();
    return body ? `<system-reminder>\n${body}\n</system-reminder>` : null;
  } catch {
    return null;
  }
}

/**
 * 把这一轮的模式指令落成**一条独立的消息**；不注入的模式返回 null。
 *
 * ⚠️ 调用方必须让它排在用户消息**之前**（见 runtime.run 的调用点）：wire 的顺序靠既有的
 *    历史装配排出来，模型因此先看到「这一轮是 swarm 轮」、再看到用户的原文。
 *    `createdAt` 故意早 1ms —— 两条消息常常落在同一毫秒，而 SQLite 对相同的 created_at
 *    没有稳定顺序，注入一旦排到用户消息后面，就变成"事后补一句"，语义完全变了。
 *
 * plan / goal 不注入：计划模式是**线程 metadata**（面板已经设好了），目标有自己的
 * store 与工具 —— 它们要的是"接受这个值"，不是"再叮嘱一遍"。
 */
export async function injectTurnMode(deps: ModeInjectDeps, mode: TurnMode): Promise<Message | null> {
  if (mode !== "swarm") return null;
  const text = await swarmReminder();
  if (!text) return null;

  const msg: Message = {
    id: `${deps.threadId}--i-${randomUUID()}`, threadId: deps.threadId, role: "user",
    parts: [{ type: "text", text }],
    createdAt: Date.now() - 1,
    origin: INJECTION_ORIGIN, variant: SWARM_MODE_VARIANT,
  };
  deps.store.addMessage(msg);
  deps.eventLog?.append("mode_injection", { mode, variant: SWARM_MODE_VARIANT, messageId: msg.id }, { run: deps.runId, turn: 1 });
  return msg;
}
