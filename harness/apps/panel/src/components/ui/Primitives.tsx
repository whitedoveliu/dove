/** 基础控件：按钮 / 徽章 / 面板 / 弹层（手写 Tailwind，无组件库） */
import { useEffect } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "ghost" | "danger" | "subtle";
type Size = "xs" | "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "border border-accent bg-accent text-shell hover:brightness-110",
  ghost: "border border-line-strong text-fg-dim hover:bg-white/5 hover:text-fg",
  danger: "border border-danger/50 text-danger hover:bg-danger/10",
  subtle: "border border-transparent text-fg-dim hover:bg-white/5 hover:text-fg",
};

const SIZE: Record<Size, string> = {
  xs: "h-5 px-1.5 text-[11px]",
  sm: "h-6 px-2 text-[12px]",
  md: "h-7 px-3 text-[12px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = "ghost", size = "sm", className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "inline-flex select-none items-center justify-center gap-1.5 rounded-sm font-mono uppercase tracking-wide transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
    />
  );
}

export function Badge({ children, className, tone = "dim" }: { children: ReactNode; className?: string; tone?: "dim" | "accent" | "success" | "danger" | "info" | "warn" | "think" }) {
  const tones: Record<string, string> = {
    dim: "border-line-strong text-fg-dim",
    accent: "border-accent/40 text-accent",
    success: "border-success/40 text-success",
    danger: "border-danger/40 text-danger",
    info: "border-info/40 text-info",
    warn: "border-warn/40 text-warn",
    think: "border-think/40 text-think",
  };
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-[10px] uppercase tracking-wide", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ className }: { className?: string }) {
  return <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block h-3 w-3 animate-spin rounded-full border border-line-soft border-t-accent", className)}
    />
  );
}

export function Pane({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex min-h-0 flex-col rounded-md border border-line bg-panel", className)}>{children}</div>;
}

export function PaneHeader({ title, right, className }: { title: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-2.5", className)}>
      {typeof title === "string" ? (
        <span className="truncate font-mono text-[11px] uppercase tracking-wide text-fg-dim">{title}</span>
      ) : (
        title
      )}
      {right}
    </div>
  );
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-3 py-6 text-center text-[12px] text-fg-mute", className)}>{children}</div>;
}

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  width?: string;
  tone?: string;
}

export function Modal({ open, title, children, footer, onClose, width = "max-w-[560px]", tone = "border-line-strong" }: ModalProps) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className={cn("w-full overflow-hidden rounded-md border bg-raised shadow-2xl shadow-black/60", tone, width)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-9 items-center justify-between border-b border-line px-3">
          <span className="font-mono text-[11px] uppercase tracking-wide text-fg-dim">{title}</span>
          {onClose ? (
            <button type="button" onClick={onClose} className="rounded-sm px-1 text-fg-mute hover:text-fg" aria-label="关闭">
              ✕
            </button>
          ) : null}
        </div>
        <div className="max-h-[70vh] overflow-auto p-3">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line bg-panel px-3 py-2">{footer}</div> : null}
      </div>
    </div>
  );
}

/** 中性提示条：用于「服务未接入 / 权限未给 / 已降级」这类非错误状态 */
export function Notice({
  children,
  tone = "dim",
  className,
}: {
  children: ReactNode;
  tone?: "dim" | "info" | "warn";
  className?: string;
}) {
  const tones: Record<string, string> = {
    dim: "border-line bg-inset text-fg-mute",
    info: "border-info/30 bg-info/10 text-info",
    warn: "border-warn/30 bg-warn/10 text-warn",
  };
  return (
    <div className={cn("rounded-sm border px-2 py-1.5 text-[11px] leading-relaxed", tones[tone], className)}>
      {children}
    </div>
  );
}

/** 键值行：用于元信息展示 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1">
      <span className="w-20 shrink-0 font-mono text-[11px] uppercase tracking-wide text-fg-mute">{label}</span>
      <span className="min-w-0 flex-1 break-words text-fg">{children}</span>
    </div>
  );
}
