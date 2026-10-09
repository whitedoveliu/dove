/** 中间对话区：标题栏 + 消息流 + TODO 条 + 输入区 */
import type { ReactNode } from "react";
import { Badge, Button, Spinner } from "./ui/Primitives.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { StatusPills } from "./StatusPills.tsx";
import type { ChatState } from "../lib/chat.ts";
import type { Project, Thread } from "../types.ts";

function TodoBar({ todos }: { todos: ChatState["todos"] }) {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="shrink-0 border-t border-line bg-panel px-3 py-2">
      <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-fg-mute">
        <span>TODO</span>
        <span>
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-[1.5]">
            <span className="mt-px shrink-0 font-mono text-[11px]">
              {t.status === "completed" ? (
                <span className="text-success">✔</span>
              ) : t.status === "in_progress" ? (
                <span className="text-accent">▶</span>
              ) : (
                <span className="text-fg-mute">○</span>
              )}
            </span>
            <span className={t.status === "completed" ? "text-fg-mute line-through" : "text-fg-dim"}>{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ChatViewProps {
  thread: Thread | null;
  project: Project | null;
  state: ChatState;
  rightOpen: boolean;
  onToggleRight: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  emptyHint: ReactNode;
}

export function ChatView(props: ChatViewProps) {
  const { thread, project, state, rightOpen } = props;
  const model = thread?.model ?? "";

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-shell">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="truncate text-[13px] font-medium text-fg">{thread?.title ?? "Dove"}</span>
        {thread ? <Badge tone={thread.kind === "home" ? "accent" : "dim"}>{thread.kind}</Badge> : null}
        {project ? <Badge tone="info">{project.name}</Badge> : null}
        {model ? <span className="font-mono text-[10px] text-fg-mute">{model}</span> : null}
        {state.sessionId ? (
          <span className="font-mono text-[10px] text-fg-mute" title={state.sessionId}>
            sid {state.sessionId.slice(0, 12)}
          </span>
        ) : null}
        <StatusPills />
        <span className="flex-1" />
        {state.streaming ? (
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-accent">
            <Spinner /> STEP {state.step || 1}
          </span>
        ) : null}
        <Button size="xs" variant="subtle" onClick={props.onToggleRight} title="显示 / 隐藏右侧工作区">
          {rightOpen ? "隐藏工作区" : "显示工作区"}
        </Button>
      </header>

      {state.error ? (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-1.5 font-mono text-[11px] text-danger">
          {state.error}
        </div>
      ) : null}

      <MessageList messages={state.messages} loading={state.loading} emptyHint={props.emptyHint} />
      <TodoBar todos={state.todos} />
      <Composer
        disabled={!thread}
        streaming={state.streaming}
        placeholder={project ? "在 " + project.name + " 里做什么？" : "交给 Dove 做什么？"}
        onSend={props.onSend}
        onStop={props.onStop}
      />
    </section>
  );
}
