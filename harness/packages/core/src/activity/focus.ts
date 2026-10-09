/**
 * 前台焦点缓存 + 输入监听接线（T7.4）
 *
 * 分工：
 * - input-monitor.ts 只负责「跑起来 + 解析 NDJSON」，不懂 activity 语义；
 * - 本模块把事件翻译成 activity 层的触发（app_focus / click / typing_pause），
 *   并把「当前前台 app / 窗口标题」缓存在这里（新文件，避免撑爆 399 行的 index.ts）。
 *
 * 采集快照时 app_name / window_title 的来源：
 *   attachInputMonitor(recorder) → recorder.notify(kind, meta) → ActivityRecorder.#lastMeta → insertSnapshot
 * 所以这里必须**每条触发都带上当前 meta**，否则周期触发会把 meta 冲掉。
 */
import { type InputEvent, InputMonitor } from "./input-monitor.ts";
import type { TriggerKind, TriggerMeta } from "./types.ts";

/** 焦点信息超过这个时长没用过就视为过期（前台 app 早就换了） */
export const FOCUS_STALE_MS = 10 * 60 * 1000;

export interface FocusCacheEntry extends TriggerMeta {
  bundleId?: string;
  pid?: number;
  at: number;
}

let current: FocusCacheEntry | null = null;
let active: InputMonitor | null = null;

export function setFocus(meta: TriggerMeta, extra: { bundleId?: string; pid?: number; at?: number } = {}): FocusCacheEntry {
  current = {
    appName: meta.appName ?? current?.appName ?? "unknown",
    ...(meta.windowTitle ? { windowTitle: meta.windowTitle } : {}),
    ...(extra.bundleId ? { bundleId: extra.bundleId } : {}),
    ...(extra.pid !== undefined ? { pid: extra.pid } : {}),
    at: extra.at ?? Date.now(),
  };
  return current;
}

export function currentFocus(): FocusCacheEntry | null { return current; }

export function clearFocus(): void { current = null; }

/** 当前前台 app（过期返回 undefined）；给面板/服务端等其他消费者用 */
export function currentAppInfo(now = Date.now()): TriggerMeta | undefined {
  if (!current) return undefined;
  if (now - current.at > FOCUS_STALE_MS) return undefined;
  return {
    appName: current.appName,
    ...(current.windowTitle ? { windowTitle: current.windowTitle } : {}),
  };
}

/** 只需要「能转发触发」这一件事，用结构类型避免依赖 ActivityRecorder（防循环 import） */
export interface FocusSink {
  notify(kind: TriggerKind, meta?: TriggerMeta): void;
}

export interface AttachOptions {
  monitor?: InputMonitor;
  logger?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
  /** 额外的事件旁路（面板 / 调试用），不影响主流程 */
  onEvent?: (e: InputEvent) => void;
}

export interface AttachResult { ok: boolean; bin?: string; error?: string; note?: string }

/**
 * 启动全局输入监听并接到 ActivityRecorder：
 *   app 切换 → notify("app_focus", meta)（带 app 名与窗口标题）
 *   键盘     → notify("typing_pause")（停手 1.2s 后采一帧）
 *   鼠标点击 → notify("click")
 * 无辅助功能权限时仍可用：只有 app 切换事件，note 里说明。
 */
export async function attachInputMonitor(recorder: FocusSink, opts: AttachOptions = {}): Promise<AttachResult> {
  if (active?.running) return { ok: true, bin: undefined, note: "输入监听已在运行" };
  const monitor = opts.monitor ?? new InputMonitor({ ...(opts.logger ? { logger: opts.logger } : {}) });
  const res = await monitor.start((event) => {
    try { opts.onEvent?.(event); } catch { /* 旁路异常不影响主流程 */ }
    dispatch(recorder, event);
  });
  if (!res.ok) return { ok: false, error: res.error ?? "输入监听启动失败" };
  active = monitor;
  const granted = monitor.accessibilityGranted;
  return {
    ok: true,
    ...(granted === false
      ? { note: "已启动（仅 app 切换事件）：没有辅助功能权限，键盘/鼠标事件收不到。打开系统设置授权后重启监听。" }
      : {}),
  };
}

/** 事件 → activity 触发（每条都带当前 focus meta） */
export function dispatch(recorder: FocusSink, event: InputEvent): void {
  switch (event.kind) {
    case "app": {
      const meta = setFocus(
        { appName: event.app ?? "unknown", ...(event.windowTitle ? { windowTitle: event.windowTitle } : {}) },
        { ...(event.bundleId ? { bundleId: event.bundleId } : {}), ...(event.pid !== undefined ? { pid: event.pid } : {}) },
      );
      recorder.notify("app_focus", { appName: meta.appName, ...(meta.windowTitle ? { windowTitle: meta.windowTitle } : {}) });
      return;
    }
    case "key":
      recorder.notify("typing_pause", currentAppInfo() ?? undefined);
      return;
    case "leftMouseDown":
    case "rightMouseDown":
      recorder.notify("click", currentAppInfo() ?? undefined);
      return;
    default:
      return;   // permission / scroll：不产生采集触发
  }
}

export function activeMonitor(): InputMonitor | null { return active; }

/** 停止监听并释放进程（关服 / 关开关时调用） */
export function detachInputMonitor(): void {
  try { active?.stop(); } catch { /* ignore */ }
  active = null;
}
