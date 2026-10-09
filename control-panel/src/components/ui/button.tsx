import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Button — the single interactive primitive.
 *
 * Recipes are expressed as tokens only: no literal colours, no magic numbers.
 * Sizes are tuned for a dense, professional tool (24 / 28 / 32 / 40px tall).
 */
const buttonVariants = cva(
  [
    "relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium",
    "transition-[background-color,border-color,color,box-shadow,opacity] duration-fast ease-standard",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring/55 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-accent text-accent-fg shadow-accent hover:bg-accent-hover active:bg-accent-active",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        outline:
          "border border-border-default bg-surface-raised text-text-primary shadow-xs hover:border-border-strong hover:bg-surface-hover",
        ghost:
          "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
        subtle:
          "bg-accent-subtle text-accent-subtle-fg hover:bg-accent-subtle-hover",
        destructive:
          "bg-danger text-white shadow-xs hover:bg-danger-hover focus-visible:ring-danger/40",
        link: "h-auto p-0 text-accent underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-6 gap-1 px-1.5 text-2xs [&_svg]:size-3",
        sm: "h-7 gap-1.5 px-2.5 text-sm [&_svg]:size-3.5",
        default: "h-8 px-3 text-sm [&_svg]:size-4",
        lg: "h-9 px-3.5 text-sm [&_svg]:size-4",
        icon: "size-8 [&_svg]:size-4",
        "icon-xs": "size-5 [&_svg]:size-3",
        "icon-sm": "size-6 [&_svg]:size-3",
        "icon-lg": "size-8 [&_svg]:size-4",
      },
      block: {
        true: "w-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as the child element (Radix Slot) instead of a button element. */
  asChild?: boolean;
  /** Swaps the leading icon for a spinner and blocks interaction. */
  loading?: boolean;
  /** Replaces the children while the loading flag is set. */
  loadingText?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, block, asChild = false, loading = false, loadingText, children, disabled, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";

    if (asChild) {
      return (
        <Comp
          className={cn(buttonVariants({ variant, size, block, className }))}
          ref={ref}
          {...props}
        >
          {children}
        </Comp>
      );
    }

    return (
      <button
        className={cn(buttonVariants({ variant, size, block, className }))}
        ref={ref}
        disabled={disabled || loading}
        data-loading={loading || undefined}
        {...props}
      >
        {loading && <Loader2 className="animate-spin" aria-hidden />}
        {loading && loadingText ? loadingText : children}
      </button>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
