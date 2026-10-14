"use client";

/**
 * 「用哪个 App 打开」的面板侧状态 —— 三个东西各有各的坑，所以单独一个文件：
 *
 *  1) **记住的选择**（localStorage）：键名 `dove.open-in-app.choice`（对齐 DSH 的
 *     `dsh.open-in-app.choice`）。存的是清单里的 `app.id`，不是 App 名 —— 名字会变，id 不会。
 *  2) **清单查询是全页一份**：每个打开控件各查一次的话，菜单一多就是一堆重复请求（DSH 的
 *     controller 也是「每页一次」）。失败的**不缓存**：下次挂载再试（否则一次网络抖动会把
 *     整个会话钉死在「退化菜单」上）。
 *  3) **图标**：内核用 sips 抽的 PNG，走 8008 的令牌闸门，所以只能 `fetch` 成 blob URL
 *     （`<img src>` 发不了自定义头）。按 id 缓存，页面生命周期内不释放 —— 一张 64px PNG 而已。
 *
 * 组件（分体按钮本身）见 components/open-in-app-button.tsx。
 */
import * as React from "react";

import { fetchOpenInAppIcon, listOpenInApps, type OpenInAppEntry } from "@/lib/api";

export const OPEN_IN_APP_CHOICE_KEY = "dove.open-in-app.choice";

/** 记住的 App id；读不到（首次 / 无痕模式 / 被策略挡）返回 null */
export function readRememberedAppId(): string | null {
  try {
    return window.localStorage.getItem(OPEN_IN_APP_CHOICE_KEY);
  } catch {
    return null;
  }
}

/** 记住这次选择 —— 只在**成功打开**之后调用（见组件里的说明） */
export function rememberAppId(id: string): void {
  try {
    window.localStorage.setItem(OPEN_IN_APP_CHOICE_KEY, id);
  } catch {
    // 存不了（无痕 / 配额）也不影响打开本身：这次的选择只是下次不记得了
  }
}

/**
 * 菜单里那一个「默认」：记住的 App 还在清单里就用它，否则退到**第一个可用**（DSH 的口径）。
 * 清单为空返回 null —— 调用方据此退回原来的「打开方式」菜单（不要变砖）。
 */
export function pickDefaultApp(apps: OpenInAppEntry[], remembered: string | null): OpenInAppEntry | null {
  if (apps.length === 0) return null;
  return apps.find((app) => app.id === remembered) ?? apps[0];
}

export type OpenInAppListState =
  | { status: "loading"; apps: OpenInAppEntry[] }
  | { status: "ready"; apps: OpenInAppEntry[] }
  | { status: "error"; apps: OpenInAppEntry[] };

/** 全页共用的那一次查询（失败清空，好让下一次挂载重试） */
let listPromise: Promise<OpenInAppEntry[]> | null = null;

function loadApps(): Promise<OpenInAppEntry[]> {
  if (!listPromise) {
    listPromise = listOpenInApps()
      .then((result) => result.apps)
      .catch((e: unknown) => {
        listPromise = null;
        throw e;
      });
  }
  return listPromise;
}

/** 已装 App 清单（`loading` = 还没问回来，界面上给骨架；`error` = 探测失败，退化成原菜单） */
export function useOpenInApps(): OpenInAppListState {
  const [state, setState] = React.useState<OpenInAppListState>({ status: "loading", apps: [] });
  React.useEffect(() => {
    let alive = true;
    loadApps().then(
      (apps) => { if (alive) setState({ status: "ready", apps }); },
      () => { if (alive) setState({ status: "error", apps: [] }); },
    );
    return () => { alive = false; };
  }, []);
  return state;
}

/** id → blob URL（null 也缓存：抽不到图标的 App 不该每次渲染都再问一次内核） */
const iconCache = new Map<string, Promise<string | null>>();

function loadIcon(id: string): Promise<string | null> {
  const hit = iconCache.get(id);
  if (hit) return hit;
  const pending = fetchOpenInAppIcon(id).then((blob) => (blob ? URL.createObjectURL(blob) : null));
  iconCache.set(id, pending);
  return pending;
}

/** App 图标 URL；取不到返回 null（调用方退回 lucide 通用图标，不留空白） */
export function useAppIconUrl(id: string | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!id) { setUrl(null); return; }
    let alive = true;
    void loadIcon(id).then((next) => { if (alive) setUrl(next); });
    return () => { alive = false; };
  }, [id]);
  return url;
}
