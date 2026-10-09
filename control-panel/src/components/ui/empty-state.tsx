import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * EmptyState — the canonical "nothing here yet" block.
 * Keeps a single, calm visual rhythm across every pane.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
  compact = false,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center text-center",
        compact ? "gap-2 p-4" : "gap-3 p-8",
        className
      )}
    >
      {icon && (
        <div
          className={cn(
            "flex items-center justify-center rounded-sm border border-border-subtle bg-surface-inset text-text-tertiary",
            compact ? "size-9 [&_svg]:size-4" : "size-12 [&_svg]:size-5"
          )}
        >
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className={cn("font-medium text-text-primary", compact ? "text-xs" : "text-sm")}>{title}</p>
        {description && (
          <p className={cn("mx-auto max-w-[36ch] text-pretty text-text-tertiary", compact ? "text-2xs" : "text-xs")}>
            {description}
          </p>
        )}
      </div>
      {(action || secondaryAction) && (
        <div className="mt-1 flex items-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
