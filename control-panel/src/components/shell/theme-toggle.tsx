"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type ThemeMode } from "@/lib/theme";

const OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "浅色", icon: <Sun /> },
  { value: "dark", label: "深色", icon: <Moon /> },
  { value: "system", label: "跟随系统", icon: <Monitor /> },
];

/** ThemeToggle — three-state theme switcher (light / dark / system). */
export function ThemeToggle({ collapsed = false }: { collapsed?: boolean }) {
  const { mode, isDark, setTheme } = useTheme();

  const Icon = mode === "system" ? Monitor : isDark ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          size={collapsed ? "default" : "sm"}
          aria-label="切换主题"
          className={cn(!collapsed && "text-text-tertiary")}
        >
          <Icon />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={collapsed ? "center" : "end"} side={collapsed ? "right" : "top"} className="w-40">
        <DropdownMenuLabel>外观</DropdownMenuLabel>
        {OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => setTheme(option.value)}
            className={cn(mode === option.value && "bg-surface-hover text-text-primary")}
          >
            {option.icon}
            {option.label}
            {mode === option.value && <span className="ml-auto size-1.5 rounded-full bg-accent" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
