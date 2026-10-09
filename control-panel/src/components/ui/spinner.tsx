import * as React from "react";

import { cn } from "@/lib/utils";

/** Spinner — a token-coloured indeterminate progress ring. */
export function Spinner({
  className,
  size = 16,
  label = "加载中",
}: {
  className?: string;
  size?: number;
  label?: string;
}) {
  return (
    <span role="status" aria-label={label} className={cn("inline-flex", className)}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="animate-spin">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** Skeleton — shimmering placeholder block. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div aria-hidden className={cn("animate-pulse-soft rounded-md bg-surface-inset", className)} {...props} />
  );
}

/** Indeterminate progress bar used for build / generation states. */
export function ProgressBar({
  className,
  tone = "accent",
}: {
  className?: string;
  tone?: "accent" | "success" | "warning" | "danger";
}) {
  const tones = {
    accent: "bg-accent",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
  } as const;
  return (
    <div className={cn("h-0.5 w-full overflow-hidden bg-surface-inset", className)}>
      <div className={cn("h-full w-1/3 animate-indeterminate", tones[tone])} />
    </div>
  );
}
