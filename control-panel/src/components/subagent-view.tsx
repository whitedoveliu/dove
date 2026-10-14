"use client";

import * as React from "react";
import { ChevronLeft, Loader2, Bot } from "lucide-react";
import MessageList from "@/components/MessageList";
import { readSubagent, type Message, type SubagentDetail, type SubagentEntry } from "@/lib/api";
import { formatDuration, type SubagentStep } from "@/components/subagent-bar";
import { cn } from "@/lib/utils";

/**
 * 子代理视图 —— 「点进去看它在干什么」。
 *
 * 两条数据来源合成一个界面：
 *   · 过程（落盘的）：GET /api/projects/{port}/subagents/{id} → entries
 *     （思考 / 正文 / 工具调用 + 结果，顺序 = 发生顺序；**刷新、重启之后还在**）
 *   · 实时（还在跑的那段）：父对话 SSE 里的 subagent 事件（由 reduceSubagents 累积，
 *     面板经 lib/subagent-feed 拿进来）
 * 两者都转成 MessageList 认的 events，所以只有一套渲染。
 *
 * 为什么以「落盘的」为准：它是权威（含工具结果），实时的只负责把**还没落盘的半截**接上。
 * 它一跑完（running: true → false）就重新拉一次 —— 结论与工具结果都是那一刻才写进库的。
 *
 * 两处用法：
 *   · 右侧面板「后台 Agent」页里的一个 tab（`onBack` 不传 —— 靠 tab 条回列表）；
 *   · 聊天区「进入查看」的全屏视图（`onBack` 传了才有上面那条面包屑）。
 */
export interface SubagentViewProps {
  projectKey: string;
  subagentId: string;
  label: string;
  running: boolean;
  /** 实时累积的时间线（来自 SubagentBar 的 reduceSubagents） */
  liveSteps: SubagentStep[];
  /** 传了才画「← 主对话」那条面包屑 */
  onBack?: () => void;
}

/** 落盘的过程条目 → MessageList 认的 events（工具那一行按老契约的三件套铺开） */
function entriesToEvents(entries: SubagentEntry[]): NonNullable<Message["events"]> {
  const out: NonNullable<Message["events"]> = [];
  for (const e of entries) {
    if (e.kind === "reasoning") { if (e.text) out.push({ type: "thinking", content: e.text }); continue; }
    if (e.kind === "text") { if (e.text) out.push({ type: "text", content: e.text }); continue; }
    if (!e.tool) continue;
    // tool_start{tool} → tool_info{info} → tool_params{params} → tool_result{result}
    // 这个顺序是 MessageList 折叠工具轨道的判据（见它里面的 pickFollow），不能乱
    out.push({ type: "tool_start", tool: e.tool });
    if (e.info) out.push({ type: "tool_info", tool: e.tool, info: e.info });
    out.push({ type: "tool_params", tool: e.tool, params: e.args ?? {} });
    if (e.ok === false) out.push({ type: "tool_result", tool: e.tool, result: "失败：" + (e.result ?? "没有留下说明") });
    else if (e.result !== undefined) out.push({ type: "tool_result", tool: e.tool, result: e.result });
  }
  return out;
}

/** 实时时间线 → events（和落盘回放同一个形状） */
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
  const [detail, setDetail] = React.useState<SubagentDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState("");

  /**
   * 拉一次落盘的过程。依赖里带 `running`：它一结束就再拉一次 ——
   * 过程 parts、结论、工具结果都是**结束那一刻**才写进库的（见内核 subagent-store.ts:finish）。
   */
  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    readSubagent(projectKey, subagentId)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectKey, subagentId, running]);

  const meta = detail?.subagent;
  const title = meta?.label ?? label;

  const history: Message[] = React.useMemo(() => {
    const events = entriesToEvents(detail?.entries ?? []);
    if (events.length === 0) return [];
    return [{
      id: subagentId + "--process",
      role: "assistant" as const,
      content: "",
      timestamp: new Date(meta?.startedAt ?? Date.now()),
      events,
    }];
  }, [detail, subagentId, meta?.startedAt]);

  // 实时那段：还在跑时接在落盘的过程后面（跑完就不接了 —— 权威的那份已经包含它）
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-raised">
      {/* 面包屑（全屏视图才有）—— 对齐 DSH 的 Session hierarchy */}
      {(onBack || meta) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-2xs">
          {onBack && (
            <>
              <button
                type="button"
                onClick={onBack}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                <ChevronLeft className="size-3.5" />
                主对话
              </button>
              <span className="text-text-tertiary">/</span>
            </>
          )}
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-text-primary">
            <Bot className="size-3.5 shrink-0" />
            <span className="truncate">{title}</span>
          </span>
          {/* 状态 + 模型 + 用时 + 用量：卡片上那几样，点进来还得看得到 */}
          <span className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5 font-medium",
            running
              ? "bg-accent-subtle text-accent-subtle-fg"
              : meta?.status === "error" || meta?.status === "canceled"
                ? "bg-danger-subtle text-danger-fg"
                : "bg-success-subtle text-success-fg",
          )}>
            {running ? "运行中" : meta?.status === "error" ? "失败" : meta?.status === "canceled" ? "已取消" : "已完成"}
          </span>
          {meta?.model && <span className="shrink-0 truncate font-mono text-text-tertiary">{meta.model}</span>}
          {meta?.durationMs != null && <span className="shrink-0 text-text-tertiary">{formatDuration(meta.durationMs)}</span>}
          {meta?.usage && (
            <span className="shrink-0 text-text-tertiary" title="这次运行的 token 用量">
              {(meta.usage.inputTokens ?? 0) + (meta.usage.outputTokens ?? 0)} tok
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 px-6 py-4 text-xs text-text-tertiary">
            <Loader2 className="size-3.5 animate-spin" />
            读取过程记录…
          </div>
        )}
        {err && <div className="px-4 py-4 text-xs text-danger">读不到过程记录：{err}</div>}
        {!loading && !err && messages.length === 0 && (
          <div className="px-4 py-4 text-xs text-text-tertiary">
            {running ? "它还在跑，过程会随着它的进展出现在这里（结束落盘后完整保留）。" : "（它没有留下过程记录）"}
          </div>
        )}
        {!loading && messages.length > 0 && (
          <div className="mx-auto w-full max-w-[880px] px-3 py-2">
            <MessageList messages={messages} isLoading={running && liveSteps.length > 0} />
          </div>
        )}
      </div>
    </div>
  );
}

export default SubagentView;
