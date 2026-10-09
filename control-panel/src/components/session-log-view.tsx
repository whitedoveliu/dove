"use client";

import * as React from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  Braces,
  Check,
  ChevronRight,
  CircleDot,
  Copy,
  History,
  Pause,
  Play,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  getSessions,
  sessionLogStreamUrl,
  type SessionLogRecord,
  type SessionSummary,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Hint } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MAX_RECORDS = 3000;

type Tone = "default" | "neutral" | "success" | "warning" | "danger" | "info" | "solid";
type Group = "chat" | "tool" | "system" | "error";

const TYPE_META: Record<string, { label: string; tone: Tone; group: Group }> = {
  run_start: { label: "运行开始", tone: "solid", group: "system" },
  run_ready: { label: "运行就绪", tone: "neutral", group: "system" },
  run_end: { label: "运行结束", tone: "neutral", group: "system" },
  turn_start: { label: "用户消息", tone: "default", group: "chat" },
  turn_end: { label: "回合结束", tone: "neutral", group: "system" },
  step_start: { label: "步骤", tone: "info", group: "system" },
  assistant_text: { label: "回复", tone: "default", group: "chat" },
  thinking: { label: "思考", tone: "info", group: "chat" },
  tool_call: { label: "工具调用", tone: "default", group: "tool" },
  tool_params: { label: "工具参数", tone: "neutral", group: "tool" },
  tool_result: { label: "工具结果", tone: "success", group: "tool" },
  tool_info: { label: "工具信息", tone: "neutral", group: "tool" },
  agent_log: { label: "运行日志", tone: "neutral", group: "system" },
  stats: { label: "用量统计", tone: "info", group: "system" },
  todo_update: { label: "任务清单", tone: "info", group: "system" },
  ask_user: { label: "询问用户", tone: "warning", group: "chat" },
  user_answer: { label: "用户回答", tone: "default", group: "chat" },
  commit: { label: "提交", tone: "success", group: "system" },
  build_start: { label: "开始构建", tone: "neutral", group: "system" },
  build_error: { label: "构建失败", tone: "danger", group: "error" },
  preview_ready: { label: "预览就绪", tone: "success", group: "system" },
  model_upgrade: { label: "模型升级", tone: "warning", group: "system" },
  restore_confirm: { label: "版本回滚", tone: "warning", group: "system" },
  browser_action: { label: "浏览器动作", tone: "info", group: "tool" },
  image: { label: "图片", tone: "neutral", group: "chat" },
  ephemeral: { label: "瞬时事件", tone: "neutral", group: "system" },
  interrupted: { label: "已中断", tone: "warning", group: "error" },
  locked: { label: "项目占用", tone: "warning", group: "error" },
  error: { label: "错误", tone: "danger", group: "error" },
};

const GROUPS: { key: Group | "all"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "chat", label: "对话" },
  { key: "tool", label: "工具" },
  { key: "system", label: "系统" },
  { key: "error", label: "异常" },
];

function metaFor(type: string) {
  return TYPE_META[type] ?? { label: type, tone: "neutral" as Tone, group: "system" as Group };
}

function timeOf(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
    "." +
    String(date.getMilliseconds()).padStart(3, "0")
  );
}

/** 一行摘要：把 payload 压成人类可读的一句话。 */
function summarize(record: SessionLogRecord): string {
  const data = (record.data ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : "");
  switch (record.type) {
    case "turn_start":
      return str("message") || "（空消息）";
    case "step_start":
      return str("label") || "新步骤";
    case "assistant_text":
    case "thinking":
      return str("text");
    case "tool_call":
      return [str("tool"), str("info")].filter(Boolean).join(" · ");
    case "tool_params":
      return [str("tool"), data.params ? JSON.stringify(data.params) : ""].filter(Boolean).join(" ");
    case "tool_result": {
      const value = str("result");
      return value.replace(/\s+/g, " ").slice(0, 240);
    }
    case "tool_info":
    case "agent_log":
      return str("text").slice(0, 240);
    case "ask_user":
      return str("question");
    case "user_answer":
      return str("answer");
    case "error":
    case "build_error":
      return str("message") || str("error");
    case "stats": {
      const usage = data.usage as { total_cost?: number; model?: string } | undefined;
      return `模型 ${usage?.model ?? "-"} · 花费 $${(usage?.total_cost ?? 0).toFixed(4)} · 轮次 ${data.rounds ?? "-"}`;
    }
    case "commit":
      return str("commit_hash").slice(0, 10);
    case "model_upgrade":
      return `${str("from")} → ${str("to")}`;
    case "turn_end":
      return `${str("status")} · ${data.duration_ms ?? "-"}ms`;
    case "run_start":
      return `模型 ${str("model") ?? "-"}`;
    case "image":
      return str("content");
    default: {
      const json = JSON.stringify(data);
      return json.length > 240 ? json.slice(0, 240) + "…" : json;
    }
  }
}

export interface SessionLogViewProps {
  port: string | null;
  className?: string;
}

/**
 * SessionLogView — 会话执行轨迹的实时视图。
 *
 * 数据来自 `/api/projects/{port}/session-log/stream`（SSE + 文件 tail）：
 * 打开时先补齐历史，之后持续推送新记录；按 seq 去重，因此断线重连不会重复。
 */
export function SessionLogView({ port, className }: SessionLogViewProps) {
  const [records, setRecords] = React.useState<SessionLogRecord[]>([]);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [session, setSession] = React.useState<string>("");
  const [connected, setConnected] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [group, setGroup] = React.useState<Group | "all">("all");
  const [follow, setFollow] = React.useState(true);
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const [copied, setCopied] = React.useState(false);
  const [logDir, setLogDir] = React.useState<string>("");

  const bottomRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const seenRef = React.useRef<Set<number>>(new Set());

  /* ------------------------------ 会话列表 ------------------------------ */
  const loadSessions = React.useCallback(async () => {
    if (!port) return;
    try {
      const result = await getSessions(port, 40);
      setSessions(result.sessions);
      setLogDir(result.dir);
      // 文件尚未创建时也先订阅"今天"，等 Agent 写入即自动出现
      setSession((prev) => prev || result.latest || result.today || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取会话列表失败");
    }
  }, [port]);

  React.useEffect(() => {
    setRecords([]);
    setSession("");
    setExpanded(new Set());
    seenRef.current = new Set();
    void loadSessions();
  }, [port, loadSessions]);

  /* --------------------------- 实时日志（SSE） --------------------------- */
  React.useEffect(() => {
    if (!port || !session) return;
    const source = new EventSource(sessionLogStreamUrl(port, session, 0));
    setConnected(false);
    setError(null);

    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("record", (event) => {
      try {
        const record = JSON.parse((event as MessageEvent).data) as SessionLogRecord;
        if (seenRef.current.has(record.seq)) return; // 断线重连时去重
        seenRef.current.add(record.seq);
        setRecords((prev) => {
          const next = prev.length >= MAX_RECORDS ? prev.slice(prev.length - MAX_RECORDS + 1) : prev.slice();
          next.push(record);
          return next;
        });
        setConnected(true);
      } catch {
        /* 忽略坏行 */
      }
    });
    source.addEventListener("error", () => setConnected(false));

    return () => source.close();
  }, [port, session]);

  // 会话进行中时定期刷新列表（拿到新的会话/turn 数）
  React.useEffect(() => {
    const timer = window.setInterval(() => void loadSessions(), 5000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  /* ------------------------------- 自动滚动 ------------------------------ */
  React.useEffect(() => {
    if (!follow) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [records, follow]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    setFollow(atBottom);
  };

  const visible = React.useMemo(
    () => (group === "all" ? records : records.filter((r) => metaFor(r.type).group === group)),
    [records, group]
  );

  const counts = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const record of records) {
      const key = metaFor(record.type).group;
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [records]);

  const toggle = (seq: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  const copyAll = async () => {
    const text = records.map((r) => JSON.stringify(r)).join("\n");
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  if (!port) {
    return (
      <EmptyState
        icon={<History />}
        title="尚未选择项目"
        description="选择一个项目后，这里会实时显示它的完整执行轨迹。"
      />
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {/* 工具条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-subtle px-3 py-2">
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium",
            connected ? "bg-success-subtle text-success-fg" : "bg-surface-inset text-text-tertiary"
          )}
          title={connected ? "实时同步中" : "连接已断开"}
        >
          <CircleDot className={cn("size-3", connected && "animate-pulse-soft")} />
          {connected ? "实时" : "已断开"}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 max-w-[15rem] items-center gap-1 rounded-lg px-2 py-1 font-mono text-2xs text-text-secondary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
              title={session}
            >
              <History className="size-3 shrink-0" />
              <span className="truncate">{session === new Date().toISOString().slice(0, 10) ? "今天" : session || "无会话"}</span>
              <ChevronRight className="size-3 shrink-0 rotate-90" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel>历史会话</DropdownMenuLabel>
            {sessions.length === 0 && (
              <DropdownMenuItem disabled>暂无日志</DropdownMenuItem>
            )}
            {sessions.slice(0, 20).map((item) => {
              const today = new Date().toISOString().slice(0, 10);
              const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
              const label =
                item.id === today ? "今天" : item.id === yesterday ? "昨天" : item.id;
              return (
                <DropdownMenuItem key={item.id} onSelect={() => setSession(item.id)}>
                  <span className="shrink-0 text-xs">{label}</span>
                  <span className="truncate font-mono text-2xs text-text-tertiary">{item.id}</span>
                  <span className="ml-auto shrink-0 text-2xs text-text-tertiary">
                    {item.last_type === "run_end" ? "空闲" : "进行中"}
                  </span>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void loadSessions()}>
              <ArrowDownToLine />
              刷新列表
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-0.5">
          {GROUPS.map((item) => {
            const count = item.key === "all" ? records.length : counts[item.key] ?? 0;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setGroup(item.key)}
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-2xs transition-colors duration-fast",
                  group === item.key
                    ? "bg-surface-selected text-accent-subtle-fg"
                    : "text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
                )}
              >
                {item.label}
                {count > 0 && <span className="ml-1 font-mono opacity-70">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-0.5">
          <Hint label={follow ? "暂停自动滚动" : "恢复自动滚动"}>
            <IconButton
              size="xs"
              aria-label="切换自动滚动"
              onClick={() => setFollow((prev) => !prev)}
              className={cn(follow && "text-accent")}
            >
              {follow ? <Pause /> : <Play />}
            </IconButton>
          </Hint>
          <Hint label={copied ? "已复制" : "复制全部记录（NDJSON）"}>
            <IconButton size="xs" aria-label="复制全部记录" onClick={copyAll} disabled={!records.length}>
              {copied ? <Check className="text-success" /> : <Copy />}
            </IconButton>
          </Hint>
        </div>
      </div>

      {/* 记录流 */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-danger-fg">
            <AlertTriangle className="size-3.5" />
            {error}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            icon={<Braces />}
            title={records.length ? "当前筛选下没有记录" : "等待第一条记录"}
            description={
              records.length
                ? "切换到「全部」查看完整轨迹。"
                : "发送一条消息后，turn / step / 工具调用会实时出现在这里。"
            }
          />
        ) : (
          <ul className="divide-y divide-border-subtle/60">
            {visible.map((record, index) => {
              const meta = metaFor(record.type);
              const isOpen = expanded.has(record.seq);
              const previous = visible[index - 1];
              const startsRun = !previous || previous.run !== record.run;
              const isLiveRun =
                record.run === visible[visible.length - 1]?.run &&
                records[records.length - 1]?.type !== "run_end";
              return (
                <React.Fragment key={record.seq}>
                {startsRun && (
                  <li className="flex items-center gap-2 bg-surface-inset/70 px-3 py-1 text-2xs text-text-tertiary">
                    <Play className="size-2.5 shrink-0 text-accent" />
                    <span className="font-mono">run {record.run}</span>
                    <span>{new Date(record.ts).toLocaleString("zh-CN", { hour12: false })}</span>
                    {isLiveRun && (
                      <span className="ml-auto flex items-center gap-1 text-success-fg">
                        <CircleDot className="size-2.5 animate-pulse-soft" />
                        进行中
                      </span>
                    )}
                  </li>
                )}
                <li className="group">
                  <button
                    type="button"
                    onClick={() => toggle(record.seq)}
                    className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors duration-fast hover:bg-surface-hover"
                  >
                    <ChevronRight
                      className={cn(
                        "mt-0.5 size-3 shrink-0 text-text-tertiary transition-transform duration-fast",
                        isOpen && "rotate-90"
                      )}
                    />
                    <span className="mt-px shrink-0 font-mono text-2xs text-text-tertiary">
                      {timeOf(record.ts)}
                    </span>
                    <span
                      className="mt-px shrink-0 font-mono text-2xs text-text-disabled"
                      title={`turn ${record.turn} / step ${record.step}`}
                    >
                      T{record.turn}S{record.step}
                    </span>
                    <Badge variant={meta.tone} className="mt-px shrink-0">
                      {meta.label}
                    </Badge>
                    <span
                      className={cn(
                        "min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-2xs leading-5",
                        record.type === "error" || record.type === "build_error"
                          ? "text-danger-fg"
                          : "text-text-secondary"
                      )}
                    >
                      {summarize(record)}
                    </span>
                  </button>
                  {isOpen && (
                    <pre className="mx-3 mb-2 max-h-72 overflow-auto rounded-lg border border-border-subtle bg-surface-inset p-2.5 font-mono text-2xs leading-relaxed text-text-secondary">
                      {JSON.stringify(record.data ?? {}, null, 2)}
                    </pre>
                  )}
                </li>
                </React.Fragment>
              );
            })}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 状态栏 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-3 py-1.5 text-2xs text-text-tertiary">
        {!connected && !error && <Spinner size={10} label="连接中" />}
        <span>{records.length} 条记录</span>
        {records.length > 0 && (
          <span className="font-mono">
            最后 T{records[records.length - 1].turn}S{records[records.length - 1].step}
          </span>
        )}
        {logDir && (
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(logDir)}
            className="ml-auto truncate font-mono transition-colors hover:text-text-primary"
            title={`${logDir}（点击复制路径）`}
          >
            .logs/sessions/*.jsonl
          </button>
        )}
      </div>
    </div>
  );
}
