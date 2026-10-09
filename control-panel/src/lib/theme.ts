"use client";

import * as React from "react";

export type ThemeMode = "light" | "dark" | "system";

/** 默认主题：深色（Codex 风格以深色为主） */
export const DEFAULT_THEME: ThemeMode = "light";

const STORAGE_KEY = "aperture-theme";

function systemPrefersDark() {
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

/**
 * useTheme — three-state theme control (light / dark / follow system)
 * persisted to localStorage and kept in sync with the OS preference.
 */
export function useTheme() {
  const [mode, setMode] = React.useState<ThemeMode>(DEFAULT_THEME);
  const [isDark, setIsDark] = React.useState(false);

  React.useEffect(() => {
    let stored: ThemeMode = DEFAULT_THEME;
    try {
      const fromQuery = new URLSearchParams(window.location.search).get("theme");
      const raw = fromQuery ?? localStorage.getItem(STORAGE_KEY);
      if (raw === "light" || raw === "dark" || raw === "system") stored = raw;
    } catch {
      /* localStorage can be unavailable in private modes */
    }
    setMode(stored);
    setIsDark(resolveDark(stored));
    applyTheme(stored);
  }, []);

  React.useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme("system");
      setIsDark(mq.matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const setTheme = React.useCallback((next: ThemeMode) => {
    setMode(next);
    setIsDark(resolveDark(next));
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  return { mode, isDark, setTheme };
}
