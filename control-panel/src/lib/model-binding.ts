"use client";

import * as React from "react";

/**
 * 「当前模型 + 换模型」这一对值。
 *
 * 权威持有者是 composer（ChatPanel）：它一次写两处（localStorage 里的 chat_settings
 * = 每轮发出去的 model 字段；内核 = 权威存储），顺便更新那颗 chip。
 * 设置弹窗的「模型」分区必须用**同一份**，不能自己再读一份内核值 ——
 * 两份状态的下场是：在设置里换了模型，chip 还显示旧的、下一轮发出去的也是旧的，
 * 用户看到的就是「我明明改了却没生效」。
 *
 * 面板里没有别处能拿到这份状态（设置弹窗的入口在侧栏，状态在 ChatPanel），
 * 所以由 composer 那侧的 ModelSettingsDialog 把它**发布**到这里，设置弹窗订阅。
 */
export interface ModelBinding {
  model: string;
  onChange: (id: string) => void;
}

let current: ModelBinding | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of [...listeners]) listener();
}

/**
 * 发布一份绑定，返回它的**对象本身**当凭据。
 *
 * 为什么返回 token 而不是「谁发布谁清理」：ChatPanel 有起始页 / 项目页两棵返回树，
 * 各渲染一份 ModelSettingsDialog，切换时新的一份先挂、旧的一份后清 ——
 * 不看凭据地清会把**刚发布的那一份**抹掉，设置里的模型分区就退回兜底路径了。
 */
export function publishModelBinding(next: ModelBinding): ModelBinding {
  if (current && current.model === next.model && current.onChange === next.onChange) return current;
  current = next;
  notify();
  return current;
}

/** 只清理自己发布的那一份（凭据对不上说明已经被替换了，别动） */
export function releaseModelBinding(token: ModelBinding): void {
  if (current !== token) return;
  current = null;
  notify();
}

/** 订阅「composer 现在用的是哪个模型、该怎么换」；composer 还没挂时是 null */
export function useModelBinding(): ModelBinding | null {
  return React.useSyncExternalStore(subscribe, () => current, () => null);
}

/**
 * composer 侧用：把自己那份状态发布出去（模型变了就重发一次）。
 *
 * ⚠️ 换模型的回调本身**不能进依赖**：ChatPanel 里 `applyModel` 是每次渲染新建的普通函数，
 * 而 ChatPanel 在流式输出时**每个 token 都重渲染** —— 直接依赖它会让「发布」跟着抖，
 * 订阅方（设置里那一栏）就被无谓地重渲染一轮。用一个转发 ref 的稳定壳子接住它：
 * 发布只在 model 真的变了时才发生，回调永远是**最新**的那个。
 */
export function usePublishModelBinding(model: string, onChange: (id: string) => void): void {
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => { onChangeRef.current = onChange; });
  const stableOnChange = React.useCallback((id: string) => onChangeRef.current(id), []);
  React.useEffect(() => {
    const token = publishModelBinding({ model, onChange: stableOnChange });
    return () => releaseModelBinding(token);
  }, [model, stableOnChange]);
}
