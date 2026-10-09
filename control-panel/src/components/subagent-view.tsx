import * as React from "react";
import { ChevronLeft, Loader2, Bot } from "lucide-react";
import MessageList from "@/components/MessageList";
import { readThreadMessages, type Message } from "@/lib/api";
import type { SubagentStep } from "@/components/subagent-bar";

/**
 * 子代理视图（A4）—— 「点进去看它在干什么」
 *
 * 两条数据来源合成一个界面：
 *   · 历史：GET /api/threads/{id}/messages（已落盘的 parts，回放成 events）
 *   · 实时：父对话那条 SSE 里的 subagent_* 事件（按 subagentId 过滤）
 * 两者形状一致（都是 MessageList 认的 events），所以只有一套渲染。
 *
 * 参考 DSH 的 Session hierarchy：点进去是**独立视图 + 面包屑**，不是弹窗。
 */
export interface SubagentViewProps {
  projectKey: string;
  subagentId: string;
  label: string;
  running: boolean;
  /** 实时累积的时间线（来自 SubagentBar 的 reduceSubagents） */
  liveSteps: SubagentStep[];
  onBack: () => void;
}

/** 把实时时间线转成 MessageList 认的 events —— 和落盘回放同一个形状 */
function stepsToEvents(steps: SubagentStep[]): Message["events"] {
  return steps.map((s) => {
    if (s.kind === "reasoning") return { type: "thinking" as const, content: s.text };
    if (s.kind === "tool") return { type: "tool_info" as const, tool: s.tool, info: s.info };
    return { type: "text" as const, content: s.text };
  });
}

export function SubagentView({
  projectKey, subagentId, label, running, liveSteps, onBack,
}: SubagentViewProps) {
  const [history, setHistory] = React.useState<Message[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState("");

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    readThreadMessages(subagentId)
      .then((d) => {
        if (!alive) return;
        setHistory(d.messages.map((m) => ({
          id: m.id,
          role: "assistant" as const,
          content: "",
          timestamp: new Date(m.createdAt),
          events: m.events as Message["events"],
        })));
      })
      .catch((e) => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [subagentId]);

  // 实时部分：子代理还在跑时，把累积的时间线接在历史后面
  const liveMsg: Message | null = running && liveSteps.length > 0
    ? {
        id: subagentId + "--live",
        role: "assistant",
        content: "",
        timestamp: new Date(),
        events: stepsToEvents(liveSteps),
      }
    : null;

  const messages = liveMsg ? [...history, liveMsg] : history;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-raised">
      {/* 面包屑 —— 对齐 DSH 的 Session hierarchy */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <ChevronLeft className="size-3.5" />
          主对话
        </button>
        <span className="text-text-tertiary">/</span>
        <span className="flex items-center gap-1.5 font-medium text-text-primary">
          <Bot className="size-3.5" />
          {label}
        </span>
        {running && (
          <span className="flex items-center gap-1 text-2xs text-accent">
            <Loader2 className="size-3 animate-spin" />
            运行中
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 px-6 py-4 text-xs text-text-tertiary">
            <Loader2 className="size-3.5 animate-spin" />
            读取过程记录…
          </div>
        )}
        {err && <div className="px-6 py-4 text-xs text-danger">读不到过程记录：{err}</div>}
        {!loading && !err && messages.length === 0 && (
          <div className="px-6 py-4 text-xs text-text-tertiary">（它还没有留下任何过程记录）</div>
        )}
        {!loading && messages.length > 0 && (
          <div className="mx-auto w-full max-w-[880px] px-6 py-3">
            <MessageList messages={messages} isLoading={running} />
          </div>
        )}
      </div>
    </div>
  );
}
