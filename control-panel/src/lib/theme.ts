"use client";

import * as React from "react";

export type ThemeMode = "light" | "dark" | "system";

/** 默认主题：深色（Codex 风格以深色为主） */
export const DEFAULT_THEME: ThemeMode = "light";

const STORAGE_KEY = "dove-theme";

export function systemPrefersDark() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveDark(mode: ThemeMode) {
  return mode === "dark" || (mode === "system" && systemPrefersDark());
}

export function applyTheme(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const dark = resolveDark(mode);
  // 深色是 :root 默认，浅色通过 .light 覆盖
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
  root.dataset.theme = mode;
  root.style.colorScheme = dark ? "dark" : "light";
}

/* --------------------------------------------------------------- store */

/**
 * 主题是**全局一份**，不是「每个用到它的组件一份」。
 *
 * 为什么必须这样：侧栏底部那颗图标和设置弹窗的「外观」行可能同屏可见。
 * 各自 useState 的下场是——在设置里切成深色，侧栏图标还画着太阳，
 * 两个控件对同一个事实给出两个答案。
 * 所以这里用一个模块级的值 + useSyncExternalStore：谁改都广播给所有订阅者。
 */
let mode: ThemeMode = DEFAULT_THEME;
let dark = false;
let initialized = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of [...listeners]) listener();
}

function readStoredMode(): ThemeMode {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("theme");
    const raw = fromQuery ?? localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* localStorage can be unavailable in private modes */
  }
  return DEFAULT_THEME;
}

/**
 * 首次用到主题时读一次存着的模式并落盘到 DOM。
 * 放在渲染期而不是 effect 里：effect 要等一帧，那一帧里读到的 mode 会是默认值 ——
 * 设置弹窗刚打开时会先画错一次高亮，然后才跳到用户选的那个。
 */
function ensureInit() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  mode = readStoredMode();
  dark = resolveDark(mode);
  applyTheme(mode);
  // 「跟随系统」得听系统的变化，这段监听是全局的，只挂一次
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (mode !== "system") return;
    applyTheme("system");
    dark = resolveDark("system");
    notify();
  });
}

export function setTheme(next: ThemeMode) {
  mode = next;
  dark = resolveDark(next);
  applyTheme(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  notify();
}

/**
 * useTheme — three-state theme control (light / dark / follow system)
 * persisted to localStorage and kept in sync with the OS preference.
 */
export function useTheme() {
  ensureInit();
  const currentMode = React.useSyncExternalStore(subscribe, () => mode, () => DEFAULT_THEME);
  const isDark = React.useSyncExternalStore(subscribe, () => dark, () => false);
  return { mode: currentMode, isDark, setTheme };
}
