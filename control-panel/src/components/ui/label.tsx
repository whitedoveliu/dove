"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const labelVariants = cva(
  "text-xs font-medium leading-none text-text-secondary peer-disabled:cursor-not-allowed peer-disabled:opacity-60"
);

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />
));
Label.displayName = LabelPrimitive.Root.displayName;

/** Section label used inside popovers and settings groups. */
export function FieldLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("section-label", className)} {...props} />;
}

export { Label };
