"use client";

import * as React from "react";
import {
  oneLight,
  vscDarkPlus,
} from "react-syntax-highlighter/dist/cjs/styles/prism";

/**
 * 代码高亮的**配色**与**语言名归一**。
 *
 * 为什么要单独一个文件、还要跟随主题：
 * 改之前正文的代码块写死了 `vscDarkPlus`（深色主题），而面板默认配色是浅色
 * （`lib/theme.ts` 的 DEFAULT_THEME = "light"）—— 浅色正文里嵌一块深色代码，
 * 观感是"贴上去的"。这里跟着 `<html class="dark">` 走。
 *
 * 为什么不能像别处一样用 Tailwind 的 `dark:` 变体切：
 * react-syntax-highlighter 的 `style` 是一张「CSS 选择器 → 内联样式」的对象，
 * 颜色最终以**内联样式**打在 `<pre>` 和每个 token 上，`dark:` 变体管不到内联样式。
 * 所以只能两张表二选一。
 */

/** 一张 Prism 配色表：键是 CSS 选择器，值是内联样式 */
export type PrismTheme = { [key: string]: React.CSSProperties };

/** 浅色：GitHub 风，和 `--surface-inset`（#f5f6f7）搭得住 */
const LIGHT_THEME: PrismTheme = oneLight;
/** 深色：保持原来的 vscDarkPlus，深色模式下的观感不变 */
const DARK_THEME: PrismTheme = vscDarkPlus;

/**
 * 语言名归一。
 *
 * refractor 自己认别名（`ts` / `py` / `yml` 都能用），但下面这几个常见的写法
 * 它没注册（实测 `refractor.registered()` 为 false）。归一后仍不认识的
 * 交给 react-syntax-highlighter —— 它内部 try/catch 掉了「未知语言」，
 * 结果是**不高亮但仍然原样显示**，不会炸、不会吞代码。
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  rs: "rust",
  zsh: "bash",
  sh: "bash",
  shellscript: "bash",
  "shell-script": "bash",
  node: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  "c++": "cpp",
  "c#": "csharp",
  golang: "go",
  ps1: "powershell",
  dockerfile: "docker",
  "vue": "markup",
  "html": "markup",
  "htm": "markup",
  "svg": "markup",
  "xml": "markup",
  "text": "text",
  "plain": "text",
  "plaintext": "text",
  "txt": "text",
};

/** 空 / 归一后的语言名。归一不出东西时返回 null（调用方按纯文本渲染） */
export function normalizeLanguage(raw?: string | null): string | null {
  const first = (raw ?? "").trim().split(/[\s:]/)[0]?.toLowerCase();
  if (!first) return null;
  const mapped = LANGUAGE_ALIASES[first] ?? first;
  if (mapped === "text") return null;
  return mapped;
}

function readIsDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

/**
 * 订阅主题开关。
 *
 * 主题状态落在 `<html>` 的 class 上（`applyTheme` 里 toggle），不经过 React 树，
 * 所以只能观察这个 class。用 `useSyncExternalStore` 而不是 MutationObserver +
 * useState：订阅函数是模块级常量，多个代码块之间不用各自建 observer 的引用相等判断。
 */
function subscribeToTheme(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

export function useIsDark(): boolean {
  // 服务端快照恒为 false —— 面板只跑在浏览器 / WKWebView 里，用不到 SSR
  return React.useSyncExternalStore(subscribeToTheme, readIsDark, () => false);
}

/** 当前主题下该用的高亮配色表 */
export function usePrismTheme(): PrismTheme {
  return useIsDark() ? DARK_THEME : LIGHT_THEME;
}
