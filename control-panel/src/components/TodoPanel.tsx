"use client";

import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodoItem } from "@/lib/api";

interface TodoPanelProps {
  todos: TodoItem[];
}

export default function TodoPanel({ todos }: TodoPanelProps) {
  if (todos.length === 0) return null;

  const completedCount = todos.filter(t => t.status === 'completed').length;
  const progress = todos.length > 0 ? (completedCount / todos.length) * 100 : 0;

  const getStatusIcon = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />;
      case 'in_progress':
        return <Loader2 className="w-3.5 h-3.5 text-info animate-spin shrink-0" />;
      case 'cancelled':
        return <XCircle className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />;
      default:
        return <Circle className="w-3.5 h-3.5 text-muted-foreground/30 shrink-0" />;
    }
  };

  return (
    <div className="rounded-lg border bg-muted/30 overflow-hidden">
      {/* 标题栏 + 进度 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">任务计划</span>
          <span className="text-xs text-muted-foreground/60">
            {completedCount}/{todos.length}
          </span>
        </div>
        {/* 进度指示 */}
        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-success transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* 任务列表 */}
      <div className="p-2 space-y-1">
        {todos.map((todo) => (
          <div
            key={todo.id}
            className={cn(
              "flex items-start gap-2 px-2 py-1.5 rounded text-xs",
              todo.status === 'completed' && "opacity-60",
              todo.status === 'cancelled' && "opacity-40 line-through",
              todo.status === 'in_progress' && "bg-info-subtle"
            )}
          >
            {getStatusIcon(todo.status)}
            <span className="flex-1 leading-relaxed">{todo.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
