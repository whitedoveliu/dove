import * as React from "react";

import { cn } from "@/lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

/**
 * Textarea — a bare, token-styled multiline field.
 * Layout (padding, min-height, resize) is owned by the caller.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex w-full rounded-lg border border-border-default bg-surface-inset px-2.5 py-2 text-sm text-text-primary",
        "transition-[border-color,box-shadow] duration-fast ease-standard",
        "placeholder:text-text-tertiary",
        "focus-visible:border-accent-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring/25",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export { Textarea };
