import * as React from "react";

import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Visual size; "sm" is used in toolbars, "lg" in focused forms. */
  inputSize?: "sm" | "default" | "lg";
  /** Optional leading adornment (icon or glyph). */
  leading?: React.ReactNode;
  /** Optional trailing adornment (shortcut hint, unit, button). */
  trailing?: React.ReactNode;
}

const SIZES = {
  sm: "h-7 px-2 text-xs",
  default: "h-8 px-2.5 text-sm",
  lg: "h-10 px-3 text-sm",
} as const;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, inputSize = "default", leading, trailing, ...props }, ref) => {
    const field = (
      <input
        type={type}
        ref={ref}
        className={cn(
          "w-full min-w-0 bg-transparent font-mono text-text-primary outline-none",
          "placeholder:text-text-tertiary",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text-secondary",
          leading && "pl-7",
          trailing && "pr-12",
          leading || trailing ? "h-full px-0" : SIZES[inputSize],
          (leading || trailing) && "h-full",
          className
        )}
        {...props}
      />
    );

    if (!leading && !trailing) return field;

    return (
      <div
        className={cn(
          "group relative flex items-center rounded-lg border border-border-default bg-surface-inset",
          "transition-[border-color,box-shadow] duration-fast ease-standard",
          "focus-within:border-accent-ring focus-within:ring-2 focus-within:ring-accent-ring/25",
          "has-[:disabled]:opacity-50",
          SIZES[inputSize],
          leading && "pl-2",
          trailing && "pr-1.5"
        )}
      >
        {leading && (
          <span className="pointer-events-none absolute left-2 flex items-center text-text-tertiary [&_svg]:size-3.5">
            {leading}
          </span>
        )}
        {field}
        {trailing && <span className="ml-1 flex shrink-0 items-center">{trailing}</span>}
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
