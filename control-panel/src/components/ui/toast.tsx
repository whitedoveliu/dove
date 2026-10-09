"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

type Tone = "default" | "success" | "danger" | "warning" | "info";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: Tone;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: string;
}

const ToastContext = React.createContext<{ toast: (options: ToastOptions) => void }>({
  toast: () => {},
});

export function useToast() {
  return React.useContext(ToastContext);
}

const TONE_STYLES: Record<Tone, { icon: React.ReactNode; ring: string }> = {
  default: { icon: <Info className="text-text-tertiary" />, ring: "border-border-subtle" },
  success: { icon: <CheckCircle2 className="text-success" />, ring: "border-border-subtle" },
  danger: { icon: <XCircle className="text-danger" />, ring: "border-border-subtle" },
  warning: { icon: <AlertTriangle className="text-warning" />, ring: "border-border-subtle" },
  info: { icon: <Info className="text-info" />, ring: "border-border-subtle" },
};

/**
 * ToastProvider — lightweight, dependency-free notifications rendered in a
 * fixed stack. Kept intentionally small so it can be dropped anywhere.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions) => {
      const id = Math.random().toString(36).slice(2);
      setItems((prev) => [...prev.slice(-3), { ...options, id }]);
      const duration = options.duration ?? 3600;
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss]
  );

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {items.map((item) => {
          const tone = TONE_STYLES[item.tone ?? "default"];
          return (
            <div
              key={item.id}
              className={cn(
                "pointer-events-auto flex items-start gap-2.5 rounded-md border border-border-default bg-surface-overlay p-2.5 shadow-md",
                "animate-slide-up",
                tone.ring
              )}
            >
              <span className="mt-px [&_svg]:size-4">{tone.icon}</span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-xs font-medium text-text-primary">{item.title}</p>
                {item.description && (
                  <p className="break-words text-2xs leading-relaxed text-text-secondary">{item.description}</p>
                )}
                {item.action && (
                  <button
                    type="button"
                    onClick={() => {
                      item.action?.onClick();
                      dismiss(item.id);
                    }}
                    className="mt-1 text-2xs font-medium text-accent hover:underline"
                  >
                    {item.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => dismiss(item.id)}
                className="-mr-1 -mt-1 flex size-5 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
