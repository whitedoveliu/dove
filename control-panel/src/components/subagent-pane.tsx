"use client";

import * as React from "react";
import { Bot, Check, Loader2, TriangleAlert, X, Ban, Clock } from "lucide-react";

import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { SubagentView } from "@/components/subagent-view";
import { formatDuration } from "@/components/subagent-bar";
import { runningCountOf, useSubagentFeed, consumeSubagentListOpen, type LiveAgent } from "@/lib/subagent-feed";
import {
  listSubagents, type SubagentInfo, type SubagentStatusFilter,
} from "@/lib/api";

/**
 * 预览面板的「后台 Agent」页。
 *
 * 结构（对齐 Kimi Code 那张截图的意思，视觉用面板自己的语言）：
 *   状态页签（最近 / 进行中 / 已完成 / 失败 / 全部）→ 两列卡片 → 点卡片在下面开一个 tab，
 *   tab 里是那个子代理的**运行过程**（复用 SubagentView / markdown 渲染件）。
 *
 * 数据两份合一份（都来自同一条链，不是两个真相源）：
 *   · 落盘的：GET /api/projects/{port}/subagents?status=…（刷新、重启后还在的那份）；
 *   · 实时的：lib/subagent-feed 里 ChatPanel 从 SSE 累积的那份（管「活」）。
 *   合并规则：同 id 以实时为准（它的状态更新），实时没有的用落盘的；
 *   列表里的**实时状态**只在 running/done 之间翻转，进度细节留给详情页。
 *
 * 什么时候重新拉：项目变、页签变、以及 feed 的 statusRevision 变（子代理起 / 停各一次）。
 * **不是轮询** —— 用户要求走已有的那条 SSE 流，这里只在它报「集合或状态变了」时补一次持久化快照。
 */
const TABS: { value: SubagentStatusFilter; label: string }[] = [
  { value: "recent", label: "最近" },
  { value: "running", label: "进行中" },
  { value: "done", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "all", label: "全部" },
];

export interface SubagentPaneProps {
  /** 面板里的 projectKey 就是端口号字符串；为空 = 还没选任务 */
  port: string | null;
  className?: string;
}

/** 卡片上的一行：落盘的行 + 实时覆盖 */
type Row = SubagentInfo & { live?: LiveAgent };

/**
 * 实时覆盖落盘：同 id 的以实时那份的**状态**为准（SSE 事件比快照新），其余字段沿用落盘的。
 *
 * **只覆盖，不追加**：这一页的列表永远来自那次按页签的请求（否则一个在跑的子代理
 * 会被塞进「已完成」页签里）。刚起来的那个要等下一次快照 —— 而它一起，
 * feed 的 statusRevision 就动了（见 lib/subagent-feed.ts），这里会立刻重拉，不是等轮询。
 */
function mergeRows(persisted: SubagentInfo[], live: LiveAgent[]): Row[] {
  const byId = new Map(live.map((a) => [a.id, a]));
  // 盘上的**终态**优先于 live 的 running —— 后台子代理比它那一轮的 SSE 活得久，
  // 父回合一结束那条实时流就关了（结束事件不会再来），live 会一直冻在 running：
  // 实测症状是「详情页写着已完成，列表卡片还在转圈 + 计时器一路涨」。
  // 终态之外（running / unknown）仍按 live 走：那也是它更有信息量的时候。
  const TERMINAL = new Set(["done", "error", "canceled"]);
  return persisted.map((p) => {
    const l = byId.get(p.id);
    if (!l) return p;
    return {
      ...p,
      status: TERMINAL.has(p.status) && !TERMINAL.has(l.status) ? p.status : l.status,
      label: p.label || l.label,
      usage: p.usage ?? (l.usage as { inputTokens: number; outputTokens: number } | null) ?? null,
      live: l,
    };
  });
}

const STATUS_VIEW: Record<string, { label: string; tone: "success" | "default" | "danger" | "neutral"; icon: React.ReactNode }> = {
  running: { label: "运行中", tone: "default", icon: <Loader2 className="animate-spin" /> },
  done: { label: "完成", tone: "success", icon: <Check /> },
  error: { label: "失败", tone: "danger", icon: <TriangleAlert /> },
  canceled: { label: "已取消", tone: "neutral", icon: <Ban /> },
  // 内核判出来的「记录说在跑，但它已经不在跑了」（重启 / 崩溃留下的）——
  // 不能显示成运行中（那会一直转圈），也不该说成失败（不知道结果）
  stale: { label: "已中断", tone: "neutral", icon: <TriangleAlert /> },
  unknown: { label: "状态未知", tone: "neutral", icon: <Clock /> },
};

function statusView(status: string) {
  return STATUS_VIEW[status] ?? STATUS_VIEW.unknown!;
}

/**
 * 每秒走一次的「现在」——**只在这一页真有在跑的行时才起定时器**。
 * 它是展示用的时钟（把 14分50秒 那个数字刷新），不是数据轮询：不发任何请求。
 */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** 用时：结束的用内核给的 durationMs，在跑的按下生开始自己算（每秒刷新） */
function durationOf(row: Row, now: number): string | null {
  if (row.durationMs != null) return formatDuration(row.durationMs);
  if (row.status === "running" && row.startedAt > 0) return formatDuration(now - row.startedAt);
  return null;
}

function SubagentCard({ row, now, onOpen }: { row: Row; now: number; onOpen: () => void }) {
  const view = statusView(row.status);
  const duration = durationOf(row, now);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={row.label}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface px-2.5 py-2 text-left",
        "transition-colors duration-fast hover:border-border-default hover:bg-surface-hover",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Bot className="size-3.5 shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">{row.label}</span>
      </div>
      {/* 仓库路径（长路径由 CSS 截断，完整值在 title 里） */}
      {row.projectPath && (
        <span className="truncate font-mono text-2xs text-text-tertiary" title={row.projectPath}>
          {row.projectPath}
        </span>
      )}
      {/* 模型：内核没记过就写「未记录」—— 不拿默认值冒充 */}
      <span className="truncate font-mono text-2xs text-text-tertiary">
        {row.model ?? "模型未记录"}
        {row.background ? " · 后台" : " · 前台"}
      </span>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
        <Badge variant={view.tone} className="shrink-0">
          {view.icon}
          {view.label}
        </Badge>
        {duration && <span className="shrink-0 text-2xs tabular-nums text-text-tertiary">{duration}</span>}
        {row.usage && (
          <span className="ml-auto shrink-0 text-2xs text-text-tertiary" title="token 用量（入 + 出）">
            {(row.usage.inputTokens ?? 0) + (row.usage.outputTokens ?? 0)} tok
          </span>
        )}
      </div>
    </button>
  );
}

/** 详情 tab 条：第一个是列表，后面每个子代理一个（可关） */
function PaneTabs({
  open, active, titles, onSelect, onClose,
}: {
  open: string[];
  active: string;
  titles: Map<string, string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="后台 Agent"
      className="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-border-subtle bg-surface-inset px-1"
    >
      <button
        type="button"
        role="tab"
        aria-selected={active === "list"}
        onClick={() => onSelect("list")}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-t-sm border-b-2 px-2 text-2xs transition-colors duration-fast",
          active === "list"
            ? "border-accent bg-surface-raised font-medium text-text-primary"
            : "border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary",
        )}
      >
        <Bot className="size-3.5" />
        列表
      </button>
      {open.map((id) => (
        <div
          key={id}
          className={cn(
            "group flex max-w-[13rem] min-w-0 shrink-0 items-center gap-1 rounded-t-sm px-2 text-2xs",
            "border-b-2 transition-colors duration-fast",
            active === id
              ? "border-accent bg-surface-raised text-text-primary"
              : "border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary",
          )}
          // 中键关闭（与文件 tab 同一套肌肉记忆）
          onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(id); } }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={active === id}
            title={titles.get(id) ?? id}
            onClick={() => onSelect(id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 outline-none"
          >
            <span className={cn("truncate", active === id && "font-medium")}>{titles.get(id) ?? id}</span>
          </button>
          <button
            type="button"
            aria-label={`关闭 ${titles.get(id) ?? id}`}
            title="关闭"
            onClick={(e) => { e.stopPropagation(); onClose(id); }}
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-sm text-text-tertiary",
              "transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary",
              active === id ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function SubagentPane({ port, className }: SubagentPaneProps) {
  const feed = useSubagentFeed();
  const [filter, setFilter] = React.useState<SubagentStatusFilter>("recent");
  const [rows, setRows] = React.useState<SubagentInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");
  /** 打开过的子代理（tab 顺序 = 打开顺序）；"list" 是第一个 tab */
  const [open, setOpen] = React.useState<string[]>([]);
  const [active, setActive] = React.useState("list");

  const live = feed.projectKey === port ? feed.agents : [];
  const running = runningCountOf(live);

  // 拉持久化的那一份：项目变 / 页签变 / 子代理起停（statusRevision）都要重来
  const revision = feed.projectKey === port ? feed.statusRevision : 0;
  const reload = React.useCallback(() => {
    if (!port) { setRows([]); return () => { /* 没端口没什么可收的 */ }; }
    let alive = true;
    setLoading(true);
    setErr("");
    listSubagents(port, { status: filter })
      .then((list) => { if (alive) setRows(list); })
      .catch((e) => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [port, filter]);
  React.useEffect(() => reload(), [reload, revision]);

  // 兜底轮询：**只在还有「运行中」的时候开**（5 秒一次），没有在跑的就完全不轮询。
  // 为什么需要：起/停通常靠 statusRevision 立刻推动，但后台子代理可能比它那一轮的 SSE
  // 活得久 —— 父回合结束时那条流已经关了，结束事件不会再来，只能自己去问一次。
  const anyRunning = React.useMemo(() => {
    const liveRunning = feed.projectKey === port && feed.agents.some((a) => a.status === "running");
    return liveRunning || rows.some((r) => r.status === "running");
  }, [feed, port, rows]);
  React.useEffect(() => {
    if (!port || !anyRunning) return;
    const timer = setInterval(() => { reload(); }, 5000);
    return () => clearInterval(timer);
  }, [port, anyRunning, reload]);

  // 输入框上方那个按钮：点了就把这一页拉回列表（即使刚才停在某个子代理上），并消费掉请求
  const openPending = feed.openPending;
  React.useEffect(() => {
    if (!openPending) return;
    setActive("list");
    consumeSubagentListOpen();
  }, [openPending]);

  // 切任务：列表与已开的 tab 都换掉（不能把上一个任务的子代理挂在这儿）
  React.useEffect(() => { setOpen([]); setActive("list"); }, [port]);

  const merged = React.useMemo(() => mergeRows(rows, live), [rows, live]);
  const now = useNow(merged.some((r) => r.status === "running"));
  const titles = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of merged) m.set(r.id, r.label);
    for (const l of live) if (!m.has(l.id)) m.set(l.id, l.label);
    return m;
  }, [merged, live]);

  const openTab = (id: string) => {
    setOpen((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActive(id);
  };
  const closeTab = (id: string) => {
    const idx = open.indexOf(id);
    if (idx < 0) return;
    const next = open.filter((x) => x !== id);
    setOpen(next);
    // 关的是当前 tab → 落到相邻（右邻优先），都没有就回列表
    if (active === id) setActive(next[idx] ?? next[idx - 1] ?? "list");
  };

  if (!port) {
    return (
      <EmptyState
        className={className}
        icon={<Bot />}
        title="尚未选择任务"
        description="在左侧目录面板选择或新建一个任务，这里会显示它派出去的子代理。"
      />
    );
  }

  const detailId = active === "list" ? null : active;
  const liveOf = (id: string) => live.find((a) => a.id === id);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <PaneTabs open={open} active={active} titles={titles} onSelect={setActive} onClose={closeTab} />

      {detailId ? (
        <SubagentView
          projectKey={port}
          subagentId={detailId}
          label={titles.get(detailId) ?? detailId}
          running={liveOf(detailId)?.status === "running"}
          liveSteps={liveOf(detailId)?.steps ?? []}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-subtle bg-surface-raised px-2 py-1.5">
            <Tabs value={filter} onValueChange={(v) => setFilter(v as SubagentStatusFilter)}>
              <TabsList>
                {TABS.map((t) => (
                  <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {loading && <Loader2 className="size-3 shrink-0 animate-spin text-text-tertiary" />}
            {running > 0 && (
              <span className="ml-auto shrink-0 text-2xs text-accent">{running} 个在跑</span>
            )}
          </div>

          {err && <div className="px-3 py-3 text-xs text-danger">读不到子代理列表：{err}</div>}

          {!err && merged.length === 0 && !loading && (
            <EmptyState
              compact
              className="px-4 py-6"
              icon={<Bot />}
              title="这里没有后台 Agent"
              description="换个页签（最近 / 全部）看看，或让 AI 用 Task 派一个后台子代理（把 background 设成 true）。"
            />
          )}

          {merged.length > 0 && (
            <div className="grid grid-cols-2 gap-2 p-2">
              {merged.map((row) => (
                <SubagentCard key={row.id} row={row} now={now} onOpen={() => openTab(row.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SubagentPane;
