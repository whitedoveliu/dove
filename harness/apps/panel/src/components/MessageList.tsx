/** 消息列表：用户气泡 / AI 文本流（左侧竖线）/ 思考折叠 / 工具卡片 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Markdown } from "../lib/markdown.tsx";
import { formatClock, formatDuration, formatTokens } from "../lib/format.ts";
import { Button, cn } from "./ui/Primitives.tsx";
import { ToolCallCard } from "./ToolCallCard.tsx";
import type { UIReasoningPart, UIMessage } from "../types.ts";

function ReasoningBlock({ part }: { part: UIReasoningPart }) {
  const [open, setOpen] = useState(!part.done);
  const preview = part.text.replace(/\s+/g, " ").trim().slice(-80);
  return (
    <div className="rounded-md border border-think/25 bg-think/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-white/5"
      >
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-think">
          {part.done ? "THINKING" : "THINKING…"}
        </span>
        {!open && preview ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-mute">{preview}</span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="shrink-0 text-[10px] text-fg-mute">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="whitespace-pre-wrap break-words border-t border-think/20 px-2 py-1.5 text-[12px] leading-[1.55] text-fg-dim">
          {part.text}
          {!part.done ? <span className="dove-caret" /> : null}
        </div>
      ) : null}
    </div>
  );
}

function AssistantTurn({ message }: { message: UIMessage }) {
  const tokens = formatTokens(message.usage);
  const cost = formatDuration(message.durationMs);
  return (
    <div className="flex gap-3">
      <div className="w-16 shrink-0 pt-0.5 text-right font-mono text-[10px] uppercase tracking-wide text-fg-mute">
        AI AGENT
        {message.createdAt ? (
          <div className="text-[9px] normal-case text-fg-mute/70">{formatClock(message.createdAt)}</div>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 space-y-2 border-l-2 border-line-strong pl-3">
        {message.parts.map((p) => {
          if (p.kind === "reasoning") return <ReasoningBlock key={p.id} part={p} />;
          if (p.kind === "tool") return <ToolCallCard key={p.id} part={p} />;
          if (p.kind === "error") {
            return (
              <div key={p.id} className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-[12px] text-danger">
                {p.text}
              </div>
            );
          }
          return (
            <div key={p.id} className="text-[13px] leading-[1.6] text-fg">
              <Markdown text={p.text} />
              {!p.done ? <span className="dove-caret" /> : null}
            </div>
          );
        })}
        {message.parts.length === 0 ? (
          <div className="flex items-center gap-2 font-mono text-[11px] text-fg-mute">
            <span className="dove-caret" /> 等待模型输出…
          </div>
        ) : null}
        {tokens || cost ? (
          <div className="flex gap-3 pt-0.5 font-mono text-[10px] text-fg-mute">
            {tokens ? <span>{tokens}</span> : null}
            {cost ? <span>{cost}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: UIMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-md border border-accent/30 bg-accent/12 px-3 py-1.5">
        <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-fg">
          {message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}
        </div>
      </div>
    </div>
  );
}

export interface MessageListProps {
  messages: UIMessage[];
  loading: boolean;
  emptyHint?: ReactNode;
}

export function MessageList({ messages, loading, emptyHint }: MessageListProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = boxRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [messages, pinned]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={boxRef} onScroll={onScroll} className="h-full space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !loading ? emptyHint : null}
        {loading ? <div className="font-mono text-[11px] text-fg-mute">加载历史…</div> : null}
        {messages.map((m) =>
          m.role === "user" ? (
            <UserBubble key={m.id} message={m} />
          ) : m.role === "system" ? (
            <div key={m.id} className="text-[12px] italic text-fg-mute">
              {m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}
            </div>
          ) : (
            <AssistantTurn key={m.id} message={m} />
          ),
        )}
      </div>
      {!pinned ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            size="xs"
            className={cn("pointer-events-auto bg-raised")}
            onClick={() => {
              const el = boxRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setPinned(true);
            }}
          >
            ↓ 回到底部
          </Button>
        </div>
      ) : null}
    </div>
  );
}
