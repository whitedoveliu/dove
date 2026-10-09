import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * IconButton — a square, tooltip-friendly action target.
 * Always pair it with an aria-label or a wrapping Tooltip.
 */
const iconButtonVariants = cva(
  [
    "inline-flex shrink-0 select-none items-center justify-center rounded-lg text-text-tertiary",
    "transition-[background-color,color,box-shadow] duration-fast ease-standard",
    "hover:bg-surface-hover hover:text-text-primary",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring/55",
    "disabled:pointer-events-none disabled:opacity-40",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      size: {
        xs: "size-6 [&_svg]:size-3",
        sm: "size-7 [&_svg]:size-3.5",
        default: "size-8 [&_svg]:size-4",
        lg: "size-9 [&_svg]:size-4",
      },
      tone: {
        neutral: "",
        accent: "text-accent hover:bg-accent-subtle hover:text-accent-subtle-fg",
        danger: "text-danger hover:bg-danger-subtle hover:text-danger-fg",
        success: "text-success hover:bg-success-subtle hover:text-success-fg",
      },
      active: {
        true: "bg-surface-active text-text-primary",
      },
    },
    defaultVariants: { size: "default", tone: "neutral" },
  }
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, size, tone, active, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(iconButtonVariants({ size, tone, active, className }))}
      {...props}
    />
  )
);
IconButton.displayName = "IconButton";

export { iconButtonVariants };
