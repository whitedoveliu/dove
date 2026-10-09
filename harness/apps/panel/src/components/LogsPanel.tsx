/** 日志面板：轮询 /api/logs?threadId=&limit=，展示事件流 */
import { useEffect, useRef, useState } from "react";
import { Button, Empty, cn } from "./ui/Primitives.tsx";
import { useLogs } from "../hooks/useLogs.ts";
import { formatClock, stringifyValue } from "../lib/format.ts";
import type { LogEvent } from "../types.ts";

function typeTone(type: string): string {
  if (type.includes("error")) return "text-danger";
  if (type.includes("tool")) return "text-info";
  if (type.includes("approval")) return "text-warn";
  if (type.includes("text") || type.includes("message")) return "text-fg-dim";
  if (type.includes("turn") || type.includes("step")) return "text-think";
  return "text-fg-mute";
}

function payloadOf(event: LogEvent): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === "seq" || k === "type" || k === "ts" || k === "threadId") continue;
    rest[k] = v;
  }
  const text = stringifyValue(rest, 4000);
  return text === "{}" ? "" : text;
}

export function LogsPanel({ threadId, enabled }: { threadId: string | null; enabled: boolean }) {
  const { events, error, paused, setPaused, reload } = useLogs(threadId, enabled);
  const [selected, setSelected] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el && !paused) el.scrollTop = el.scrollHeight;
  }, [events, paused]);

  if (!threadId) return <Empty>选择一个会话后显示它的事件日志。</Empty>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg-mute">{events.length} 条</span>
        <span className="flex-1" />
        <Button size="xs" variant="subtle" onClick={reload} title="立即重新拉取">
          拉取
        </Button>
        <Button size="xs" variant="subtle" onClick={() => setPaused(!paused)}>
          {paused ? "继续轮询" : "暂停轮询"}
        </Button>
      </div>

      {error ? (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-2 py-1 font-mono text-[11px] text-danger">
          {error}
        </div>
      ) : null}

      <div ref={boxRef} className="min-h-0 flex-1 overflow-auto">
        {events.length === 0 ? <Empty>暂无事件</Empty> : null}
        {events.map((e, i) => {
          const type = String(e.type ?? "event");
          const payload = payloadOf(e);
          const open = selected === i;
          return (
            <div key={(e.seq ?? i) + "-" + i} className="border-b border-line/60">
              <button
                type="button"
                onClick={() => setSelected(open ? null : i)}
                className={cn("flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-white/5", open && "bg-white/5")}
              >
                <span className="w-14 shrink-0 font-mono text-[10px] text-fg-mute">{formatClock(e.ts)}</span>
                <span className="w-6 shrink-0 font-mono text-[10px] text-fg-mute">
                  {e.seq != null ? "#" + e.seq : ""}
                </span>
                <span className={cn("w-[76px] shrink-0 truncate font-mono text-[10px] uppercase tracking-wide", typeTone(type))}>
                  {type}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-dim">
                  {payload.replace(/\s+/g, " ").slice(0, 120)}
                </span>
              </button>
              {open ? (
                <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words border-t border-line bg-inset px-2 py-1.5 font-mono text-[11px] text-fg-dim">
                  {stringifyValue(e, 8000)}
                </pre>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
