import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex select-none items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-4 transition-colors duration-fast [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent-subtle text-accent-subtle-fg",
        neutral: "border-border-subtle bg-surface-inset text-text-secondary",
        outline: "border-border-default bg-transparent text-text-secondary",
        success: "border-transparent bg-success-subtle text-success-fg",
        warning: "border-transparent bg-warning-subtle text-warning-fg",
        danger: "border-transparent bg-danger-subtle text-danger-fg",
        info: "border-transparent bg-info-subtle text-info-fg",
        solid: "border-transparent bg-accent text-accent-fg",
        /* legacy aliases */
        secondary: "border-transparent bg-surface-inset text-text-secondary",
        destructive: "border-transparent bg-danger-subtle text-danger-fg",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Tiny status dot with an accessible label. */
export function StatusDot({
  tone = "neutral",
  className,
  label,
}: {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  className?: string;
  label?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-text-tertiary",
    accent: "bg-accent",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
  };
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", tones[tone], className)}
    />
  );
}

export { badgeVariants };
