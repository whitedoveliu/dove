"use client";

import * as React from "react";
import { CornerDownLeft, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import type { Project } from "@/lib/api";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  onSelect: (port: string) => void;
}

function taskName(project: Project): string {
  return (project.display_name || project.name_text || project.title || `会话 #${project.port}`)
    .toString()
    .trim();
}

/**
 * CommandPalette —— 居中的任务搜索面板（⌘K）。
 *
 * 对齐 Codex / DSH 的命令面板：只做一件事——**按任务名搜任务**，
 * 上下键选择、回车进入。侧栏只留一个搜索按钮，不再常驻输入框。
 */
export function CommandPalette({ open, onOpenChange, projects, onSelect }: CommandPaletteProps) {
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...projects].sort(
      (a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)
    );
    if (!q) return sorted;
    return sorted.filter((project) => taskName(project).toLowerCase().includes(q));
  }, [projects, query]);

  React.useEffect(() => {
    setIndex((prev) => Math.min(prev, Math.max(results.length - 1, 0)));
  }, [results.length]);

  const choose = (project?: Project) => {
    if (!project) return;
    onSelect(project.port);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="top-[18%] max-w-lg translate-y-0 gap-0 overflow-hidden p-0"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setIndex((prev) => Math.min(prev + 1, results.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setIndex((prev) => Math.max(prev - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(results[index]);
          }
        }}
      >
        <VisuallyHidden>
          <DialogTitle>搜索任务</DialogTitle>
          <DialogDescription>按任务名搜索并进入对话</DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <Search className="size-3.5 shrink-0 text-text-tertiary" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务名…"
            className="h-6 w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <span className="kbd shrink-0">esc</span>
        </div>

        <div ref={listRef} className="max-h-[45vh] overflow-y-auto p-1">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-2xs text-text-tertiary">
              没有匹配的任务
            </div>
          ) : (
            results.map((project, i) => (
              <button
                key={project.port}
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(project)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors duration-fast",
                  i === index ? "bg-surface-selected" : "hover:bg-surface-hover"
                )}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                  {taskName(project)}
                </span>
                {project.project ? (
                  <span className="shrink-0 font-mono text-2xs text-text-tertiary">
                    {project.project}
                  </span>
                ) : null}
                <span className="shrink-0 font-mono text-2xs text-text-tertiary">
                  #{project.port}
                </span>
                {i === index && (
                  <CornerDownLeft className="size-3 shrink-0 text-text-tertiary" />
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
