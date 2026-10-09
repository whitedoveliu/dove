"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- constants */

const SIDEBAR_KEY = "aperture-sidebar-width";
const ASIDE_KEY = "aperture-preview-width";

export const SIDEBAR_MIN = 208;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 280;
/** Must match --sidebar-rail-width (3.25rem). */
export const SIDEBAR_RAIL = 52;

// 右侧是预览面板（iframe），以对话为主 → 预览固定宽度、对话自适应。
// 默认宽度按窗口比例给（大屏更宽、小屏不挤对话），再夹到区间内。
export const ASIDE_MIN = 360;
export const ASIDE_MAX = 1100;
export const ASIDE_RATIO = 0.35;
export const ASIDE_DEFAULT = 560;

function defaultAsideWidth(): number {
  if (typeof window === "undefined") return ASIDE_DEFAULT;
  return clamp(Math.round(window.innerWidth * ASIDE_RATIO), ASIDE_MIN, 700);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readStored(key: string, fallback: number, min: number, max: number) {
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = Number.parseInt(window.localStorage.getItem(key) ?? "", 10);
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* localStorage can be unavailable */
  }
}

/* --------------------------------------------------------------- resizer */

export interface PaneResizerProps {
  /** Current pane width in px. */
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  /** Double-click / Home key resets to this width. */
  onReset?: () => void;
  /** Which drag direction grows the pane. */
  grow?: "left" | "right";
  onDragStart?: () => void;
  onDragEnd?: () => void;
  label?: string;
  /** Hides the visual rule until hover (used next to the collapsed rail). */
  subtle?: boolean;
  className?: string;
}

/**
 * PaneResizer — an 8px hit area with a hairline rule.
 *
 * Drag is tracked with pointer capture plus an internal ref, so a burst of
 * pointermove events never reads a stale width from a previous render (the
 * classic jumpy-resizer bug). Keyboard: ←/→ grow or shrink by 16px,
 * Home resets, and the separator exposes proper ARIA value semantics.
 */
export function PaneResizer({
  value,
  min,
  max,
  onChange,
  onReset,
  grow = "right",
  onDragStart,
  onDragEnd,
  label = "调整面板宽度",
  subtle = false,
  className,
}: PaneResizerProps) {
  const [dragging, setDragging] = React.useState(false);
  const [hovering, setHovering] = React.useState(false);
  const valueRef = React.useRef(value);
  const lastX = React.useRef(0);
  const direction = grow === "right" ? 1 : -1;
  const active = dragging || hovering;

  // Keep the ref in sync with the outside world — but never mid-drag, or the
  // pane would fight the pointer.
  React.useEffect(() => {
    if (!dragging) valueRef.current = value;
  }, [value, dragging]);

  // Suppress text selection for the duration of the drag.
  React.useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = previous;
      document.body.style.cursor = "";
    };
  }, [dragging]);

  const apply = (next: number) => {
    const clamped = clamp(next, min, max);
    valueRef.current = clamped;
    onChange(clamped);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label}（双击复位）`}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      onDoubleClick={() => onReset?.()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        lastX.current = event.clientX;
        valueRef.current = value;
        setDragging(true);
        onDragStart?.();
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const delta = event.clientX - lastX.current;
        if (!delta) return;
        lastX.current = event.clientX;
        apply(valueRef.current + delta * direction);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        onDragEnd?.();
      }}
      onPointerCancel={() => {
        setDragging(false);
        onDragEnd?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          apply(valueRef.current - 16 * direction);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          apply(valueRef.current + 16 * direction);
        } else if (event.key === "Home") {
          event.preventDefault();
          onReset?.();
        }
      }}
      className={cn(
        "group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring/55",
        className
      )}
    >
      <span
        className={cn(
          "w-px transition-all duration-normal ease-standard",
          dragging
            ? "h-28 bg-accent"
            : active
              ? "h-20 bg-border-strong"
              : subtle
                ? "h-10 bg-transparent group-hover:bg-border-strong"
                : "h-16 bg-transparent"
        )}
      />
    </div>
  );
}

/* ------------------------------------------------------------- app shell */

export interface AppShellProps {
  sidebar: React.ReactNode;
  main: React.ReactNode;
  aside: React.ReactNode;
  /** Collapses the directory rail; dragging the divider expands it again. */
  sidebarCollapsed?: boolean;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  /** Collapses the preview pane so the conversation gets the full width. */
  asideCollapsed?: boolean;
  className?: string;
}

/**
 * AppShell — the three-pane frame: 目录 · 对话 · 预览.
 *
 * 对话是主区域（flex-1，随窗口伸缩），预览是右侧固定宽度的可拖拽面板。
 *
 * Both dividers are draggable, keyboard-resizable (←/→, Home to reset) and
 * the resulting widths are persisted per browser.
 */
export function AppShell({
  sidebar,
  main,
  aside,
  sidebarCollapsed = false,
  onSidebarCollapsedChange,
  asideCollapsed = false,
  className,
}: AppShellProps) {
  const [sidebarWidth, setSidebarWidth] = React.useState(SIDEBAR_DEFAULT);
  const [asideWidth, setAsideWidth] = React.useState(ASIDE_DEFAULT);

  React.useEffect(() => {
    setSidebarWidth(readStored(SIDEBAR_KEY, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX));
    setAsideWidth(readStored(ASIDE_KEY, defaultAsideWidth(), ASIDE_MIN, ASIDE_MAX));
  }, []);

  const applySidebarWidth = React.useCallback((next: number) => {
    const clamped = clamp(next, SIDEBAR_MIN, SIDEBAR_MAX);
    setSidebarWidth(clamped);
    persist(SIDEBAR_KEY, clamped);
  }, []);

  const applyAsideWidth = React.useCallback((next: number) => {
    const clamped = clamp(next, ASIDE_MIN, ASIDE_MAX);
    setAsideWidth(clamped);
    persist(ASIDE_KEY, clamped);
  }, []);

  return (
    <div className={cn("flex h-dvh w-screen overflow-hidden bg-surface-raised", className)}>
      {/* 目录面板：宽度可拖拽，折叠时收敛成图标栏 */}
      <div
        className="flex h-full shrink-0 flex-col"
        style={{ width: sidebarCollapsed ? SIDEBAR_RAIL : sidebarWidth }}
      >
        <div className="flex h-full shrink-0 flex-col bg-[rgb(var(--sidebar-fill))]">{sidebar}</div>
      </div>

      <PaneResizer
        label="调整目录面板宽度"
        value={sidebarWidth}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        grow="right"
        subtle={sidebarCollapsed}
        onChange={applySidebarWidth}
        onReset={() => applySidebarWidth(SIDEBAR_DEFAULT)}
        onDragStart={() => {
          // 从折叠态起拖即展开，并沿用上次的展开宽度
          if (sidebarCollapsed) onSidebarCollapsedChange?.(false);
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col">{main}</main>

      {!asideCollapsed && (
        <>
          <PaneResizer
            label="调整预览面板宽度"
            value={asideWidth}
            min={ASIDE_MIN}
            max={ASIDE_MAX}
            grow="left"
            onChange={applyAsideWidth}
            onReset={() => applyAsideWidth(defaultAsideWidth())}
          />
          <aside style={{ width: asideWidth }} className="flex min-w-0 shrink-0 flex-col animate-fade-in">
            {aside}
          </aside>
        </>
      )}
    </div>
  );
}
