import * as React from "react";

import { cn } from "@/lib/utils";

/** Kbd — renders a keyboard shortcut key. */
export function Kbd({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd className={cn("kbd", className)} {...props}>
      {children}
    </kbd>
  );
}

const MAC_KEYS: Record<string, string> = {
  mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↵", esc: "esc", delete: "⌫",
};
const PC_KEYS: Record<string, string> = {
  mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", enter: "Enter", esc: "Esc", delete: "Del",
};

/** Renders shortcut tokens such as ["mod", "K"] with platform glyphs. */
export function Shortcut({ keys, className }: { keys: string[]; className?: string }) {
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const map = isMac ? MAC_KEYS : PC_KEYS;

  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((k) => (
        <Kbd key={k}>{map[k.toLowerCase()] ?? k}</Kbd>
      ))}
    </span>
  );
}
