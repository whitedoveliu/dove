"use client";

import * as React from "react";
import { Check, Copy, FileWarning, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatBytes, readProjectFile } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Hint } from "@/components/ui/tooltip";

export interface FilePeekProps {
  port: string;
  path: string;
  onClose: () => void;
  className?: string;
}

/**
 * FilePeek — an overlay reader for a single project file, layered above the
 * live preview so the user can inspect generated source without losing it.
 */
export function FilePeek({ port, path, onClose, className }: FilePeekProps) {
  const [state, setState] = React.useState<{
    status: "loading" | "ready" | "error";
    content?: string;
    size?: number;
    language?: string | null;
    message?: string;
  }>({ status: "loading" });
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await readProjectFile(port, path);
        if (!cancelled)
          setState({
            status: "ready",
            content: res.content,
            size: res.size,
            language: res.language,
          });
      } catch (e) {
        if (!cancelled)
          setState({ status: "error", message: e instanceof Error ? e.message : "读取失败" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, path]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    if (!state.content) return;
    await navigator.clipboard?.writeText(state.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={cn(
        "absolute inset-x-3 bottom-3 top-3 z-raised flex flex-col overflow-hidden rounded-md border border-border-subtle bg-surface-overlay shadow-lg animate-slide-up",
        className
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-medium text-text-primary">{path}</p>
          <p className="flex items-center gap-1.5 text-2xs text-text-tertiary">
            项目 <span className="font-mono">{port}</span>
            {state.size !== undefined && <span>· {formatBytes(state.size)}</span>}
            {state.language && <Badge variant="neutral">{state.language}</Badge>}
          </p>
        </div>
        <Hint label={copied ? "已复制" : "复制内容"}>
          <IconButton size="sm" aria-label="复制内容" onClick={copy} disabled={state.status !== "ready"}>
            {copied ? <Check className="text-success" /> : <Copy />}
          </IconButton>
        </Hint>
        <Hint label="关闭" shortcut="Esc">
          <IconButton size="sm" aria-label="关闭文件预览" onClick={onClose}>
            <X />
          </IconButton>
        </Hint>
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-surface-raised">
        {state.status === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-text-tertiary">
            <Loader2 className="size-3.5 animate-spin" />
            读取文件…
          </div>
        ) : state.status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-text-secondary">
            <FileWarning className="size-5 text-warning" />
            {state.message}
          </div>
        ) : (
          <pre className="whitespace-pre p-4 font-mono text-xs leading-relaxed text-text-primary">
            <code>{state.content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
