"use client";

/**
 * 「后台 Agent」这条线：聊天区 → 右侧面板。
 *
 * 为什么是模块级的 store 而不是 props：面板（PreviewPanel）和聊天区（ChatPanel）是
 * App 下的**兄弟**，而 App.tsx 不归这次改动 —— 把子代理状态提上去要动它。
 * 这与仓库里已有的做法一致（见 tool-activity.tsx 的模块级 Map、ui/toast 的 context）：
 * 只传「纯展示派生」的状态，不放进任何业务真相源。
 *
 * 谁写谁读：
 *   · ChatPanel 写 —— 它手里有 SSE 的实时 `subagents`（reduceSubagents 累积的时间线）；
 *   · PreviewPanel 读 —— 「后台 Agent」页的按钮计数、列表里的实时状态、详情页的实时过程；
 *   · 输入框上方的按钮写一次「打开请求」（openToken），面板据此切到那一页。
 *
 * **不在这里发任何请求**：面板要持久化的那份（刷新/重启后仍在）自己去调 API，
 * 这里只有内存里那份，用于「活」。
 */
import * as React from "react";
import type { SubagentStep } from "@/components/subagent-bar";

/** 面板看到的实时子代理（ChatPanel 的 SubagentInfo 的子集 —— 只留展示要用的） */
export interface LiveAgent {
  id: string;
  label: string;
  background: boolean;
  status: "running" | "done" | "error";
  /** 实时时间线（思考 / 工具 / 正文）—— 详情页把它接在落盘的过程后面 */
  steps: SubagentStep[];
  stepCount: number;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
}

export interface SubagentFeed {
  /** 当前项目（切任务时整份换掉，不能把上一个任务的子代理挂在新的上面） */
  projectKey: string | null;
  agents: LiveAgent[];
  /**
   * 只在「集合 / 状态」变化时自增（**流式 delta 不碰它**）。
   * 「后台 Agent」页据此重新拉一次持久化的列表 —— 起止各一次，不是每个 token 一次。
   */
  statusRevision: number;
  /** 输入框上方那个按钮的「打开列表」请求（每次点击自增，只用于订阅触发） */
  openToken: number;
  /**
   * 这条请求**还没被消费**。面板切到「后台 Agent」页之后由它消费（见 consume）。
   *
   * 为什么要有它而不是只看 openToken：面板折叠/展开时会**卸载重挂**。
   * 只看一个自增的 token，挂载时就会把它当成一次新请求 —— 用户点过一回之后，
   * 以后每次展开面板都会被拽到「后台 Agent」页。有了 pending：
   *   · 面板开着时点按钮 → 当场消费，之后重挂不再跳；
   *   · 面板收着时点按钮 → 没人消费，展开那一刻才跳一次（正是用户想要的）。
   * 这套「请求 + 消费」与 PreviewFilesPane 的 openPath / onOpenPathConsumed 是同一个道理。
   */
  openPending: boolean;
}

let state: SubagentFeed = { projectKey: null, agents: [], statusRevision: 0, openToken: 0, openPending: false };
/** 上次发布时的「集合 + 状态」指纹 —— 指纹相同就不算一次状态更新 */
let signature = "";

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 指纹：id 集合 + 各自状态（顺序也带上 —— 同一个 id 换了位置同样要刷新列表） */
function fingerprint(agents: LiveAgent[]): string {
  return agents.map((a) => a.id + ":" + a.status).join("|");
}

/**
 * ChatPanel 每次子代理状态变化时调一次。
 *
 * 相同的数组引用直接返回（reduceSubagents 没变化时会把原数组还回来）——
 * 否则每个 token 都会通知一次订阅者。
 */
export function publishSubagents(projectKey: string | null, agents: LiveAgent[]): void {
  if (projectKey === state.projectKey && (agents === state.agents || fingerprint(agents) === fingerprint(state.agents))) {
    // 时间线在长（steps 参考变了），但指纹一样 → 换掉 agents 引用（详情页要新的时间线），
    // **不动 statusRevision**（列表不必为每个 delta 重新拉一次）
    if (agents === state.agents) return;
    state = { ...state, agents };
    notify();
    return;
  }
  const fp = fingerprint(agents);
  const bump = state.projectKey !== projectKey || fp !== signature;
  signature = fp;
  state = { ...state, projectKey, agents, statusRevision: state.statusRevision + (bump ? 1 : 0) };
  notify();
}

/** 输入框上方的「后台 Agent」按钮：请求打开右侧面板的那一页 */
export function requestOpenSubagentList(): void {
  state = { ...state, openToken: state.openToken + 1, openPending: true };
  notify();
}

/** 面板已经把那页切出来了 → 消费掉这条请求（避免下次重挂又跳一次） */
export function consumeSubagentListOpen(): void {
  if (!state.openPending) return;
  state = { ...state, openPending: false };
  notify();
}

function getSnapshot(): SubagentFeed { return state; }

/** 订阅这份状态（useSyncExternalStore —— 与 lib/highlight.ts 同一个做法） */
export function useSubagentFeed(): SubagentFeed {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 正在跑的有几个（按钮上的角标 / 面板页签上的点） */
export function runningCountOf(agents: LiveAgent[]): number {
  return agents.filter((a) => a.status === "running").length;
}
