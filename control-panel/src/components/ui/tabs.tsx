"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

/** Segmented tab bar — compact, for pane headers. */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-6 select-none items-center gap-0.5 rounded-sm border border-border-subtle bg-surface-inset p-0.5",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-sm px-2 text-2xs font-medium text-text-secondary",
      "transition-[background-color,color,box-shadow] duration-fast ease-standard",
      "hover:text-text-primary",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring/55",
      "data-[state=active]:bg-surface-raised data-[state=active]:text-text-primary data-[state=active]:shadow-xs",
      "disabled:pointer-events-none disabled:opacity-45",
      "[&_svg]:size-3.5",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("flex-1 outline-none data-[state=active]:animate-fade-in", className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
