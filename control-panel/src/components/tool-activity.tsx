import * as React from "react";
import {
  Brain, Compass, Hammer, Terminal, Wrench, ChevronRight, ChevronDown,
  FileText, Pencil, FilePlus, FileSearch, FolderSearch, Globe, Search,
  SquareTerminal, ScrollText, Bot, ListTodo, Zap, Check, X, CircleX,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 工具调用展示：图标轨道 + 点击展开
 *
 * 参考 Alma 的实现（用户给的规格书）：
 *  - 每次工具调用不再各占一行，而是收成一枚 24px 圆形图标
 *  - 图标从左到右重叠排列（后一枚 marginLeft -7px，ring 描边做层叠感）
 *  - 点图标 -> 展开该阶段的工具行；点行 -> 展开完整参数 + 输出
 *  - 头部右侧显示「用了 N 个工具」
 *
 * 为什么按「阶段」归并而不是一个工具一枚图标：
 * 一轮里常连调 5~8 个工具，一个一枚会排成长龙且大部分同质
 * （比如连读 4 个文件）。按类别归并后一眼能看出这段在探索 / 改代码 / 跑命令。
 */

export interface ToolItem {
  tool: string;
  info?: string;
  params?: string;
  result?: string;
  /** false = 执行失败；undefined = 还没结果（运行中） */
  ok?: boolean | undefined;
}

type Phase = "thinking" | "exploring" | "making" | "running" | "generic";

const PHASE_OF: Record<string, Phase> = {
  Read: "exploring", Glob: "exploring", Grep: "exploring", LS: "exploring",
  WebSearch: "exploring", WebFetch: "exploring", Recall: "exploring",
  Edit: "making", Write: "making", MultiEdit: "making",
  Bash: "running", BashOutput: "running", KillShell: "running", run_script: "running",
};

type IconCmp = React.ComponentType<{ className?: string }>;

const TOOL_ICON: Record<string, IconCmp> = {
  Read: FileText, Edit: Pencil, Write: FilePlus, Grep: FileSearch, Glob: FolderSearch,
  WebFetch: Globe, WebSearch: Search, Bash: SquareTerminal, BashOutput: ScrollText,
  KillShell: CircleX, Task: Bot, TodoWrite: ListTodo, Skill: Zap,
};

const PHASE_ICON: Record<Phase, IconCmp> = {
  thinking: Brain, exploring: Compass, making: Hammer, running: Terminal, generic: Wrench,
};

const PHASE_LABEL: Record<Phase, { verb: string; noun: string }> = {
  thinking: { verb: "思考", noun: "段" },
  exploring: { verb: "浏览", noun: "个文件/页面" },
  making: { verb: "修改", noun: "个文件" },
  running: { verb: "运行", noun: "条命令" },
  generic: { verb: "调用", noun: "个工具" },
};

const VERB_OF: Record<string, string> = {
  Read: "Read", Glob: "Globbed", Grep: "Searched", WebSearch: "Searched the web",
  WebFetch: "Fetched", Edit: "Edited", Write: "Wrote", Bash: "Ran",
  BashOutput: "Checked", Recall: "Recalled", Skill: "Used skill", TodoWrite: "Updated",
};

/**
 * 内部工具名 → **用户在界面上看到的名字**。
 *
 * 为什么不直接改工具本身的名字：工具名是模型看到的、也是协议里用的，
 * 改它要动提示词、白名单、历史记录里已有的调用，风险大。
 * 而用户的诉求是「我不想看到 Task 这个词」—— 那是**显示层**的事。
 *
 * Task 这里叫 subagent，因为：
 *   · 它干的就是「派一个子代理」，内部实现里从头到尾都叫 subagent（runSubagent / subagent_text）
 *   · Claude Code 里 `Task` 恰恰是**待办清单**，叫 Task 反而会让人误解
 */
const TOOL_DISPLAY: Record<string, string> = {
  Task: "subagent",
  TaskOutput: "subagent 结果",
  AskUserQuestion: "ask_user",
};

/** 取工具的显示名（没有映射就用内部名）—— MessageList 的单工具回退路径也用它 */
export function displayName(tool: string): string {
  return TOOL_DISPLAY[tool] ?? tool;
}

/** 这些工具的调用本质是「派了个子代理」 */
const SUBAGENT_TOOLS = new Set(["Task", "TaskOutput"]);

/**
 * 一次工具批次的汇总文案。
 *
 * 派子代理是「上下文隔离」的大动作 —— 用户关心的是「你派了几个子代理」，
 * 而不是「你用了两个工具」。所以：
 *   全是子代理        -> 调用了 N 个 subagent
 *   子代理 + 别的工具 -> 调用了 N 个 subagent · 另用了 M 个工具
 *   没有子代理        -> 用了 N 个工具（和以前一样）
 */
/** 正在跑的时候说什么：有子代理就说清楚是子代理在干活 */
function runningLabel(items: ToolItem[]): string {
  const subs = items.filter((i) => SUBAGENT_TOOLS.has(i.tool)).length;
  if (subs === 0) return "正在执行...";
  return subs === 1 ? "subagent 工作中..." : subs + " 个 subagent 工作中...";
}

function summarizeRun(items: ToolItem[]): string {
  const subs = items.filter((i) => SUBAGENT_TOOLS.has(i.tool)).length;
  const others = items.length - subs;
  if (subs === 0) return "用了 " + items.length + " 个工具";
  const subText = "调用了 " + subs + " 个 subagent";
  return others > 0 ? subText + " · 另用了 " + others + " 个工具" : subText;
}

function phaseOf(tool: string): Phase {
  return PHASE_OF[tool] ?? "generic";
}

function buildPhases(items: ToolItem[]): { phase: Phase; tools: ToolItem[] }[] {
  const out: { phase: Phase; tools: ToolItem[] }[] = [];
  for (const it of items) {
    const ph = phaseOf(it.tool);
    const last = out[out.length - 1];
    if (last && last.phase === ph) last.tools.push(it);
    else out.push({ phase: ph, tools: [it] });
  }
  return out;
}

function parseParams(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

function shorten(s: string, n = 70): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "..." : one;
}

function ToolRow({ item, expanded, onToggle }: { item: ToolItem; expanded: boolean; onToggle: () => void }) {
  const Icon = TOOL_ICON[item.tool] ?? Wrench;
  // 没有专属动词（比如 Task）时用显示名，而不是把内部名甩给用户看
  const verb = VERB_OF[item.tool] ?? displayName(item.tool);
  const params = parseParams(item.params);
  const failed = item.ok === false;
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group/row flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono transition-colors hover:bg-surface-hover"
      >
        {failed
          ? <X className="w-3 h-3 shrink-0 text-danger" />
          : <Check className="w-3 h-3 shrink-0 text-muted-foreground/40" />}
        <Icon className="w-3 h-3 shrink-0 text-muted-foreground/70" />
        <span className="shrink-0 font-medium text-muted-foreground">{verb}</span>
        {item.info && <span className="truncate text-muted-foreground/60">{shorten(item.info)}</span>}
        <ChevronRight
          className={cn(
            "ml-auto w-3 h-3 shrink-0 text-muted-foreground/40 opacity-0 transition-transform group-hover/row:opacity-100",
            expanded && "rotate-90 opacity-100",
          )}
        />
      </button>
      {expanded && (
        <div className="ml-7 mr-2 mb-1 mt-0.5 flex flex-col gap-1.5 border-l border-border/40 pl-3">
          {params && Object.keys(params).length > 0 && (
            <div>
              <div className="mb-0.5 text-2xs uppercase tracking-wide text-muted-foreground/50">参数</div>
              <dl className="flex flex-col gap-0.5 font-mono text-2xs">
                {Object.entries(params).map(([k, v]) => {
                  const s = typeof v === "string" ? v : JSON.stringify(v);
                  const big = s.length > 100 || s.indexOf("\n") >= 0;
                  return (
                    <div key={k} className={cn(big ? "flex flex-col gap-0.5" : "flex gap-2")}>
                      <dt className="shrink-0 text-muted-foreground/50">{k}</dt>
                      <dd className={cn("text-muted-foreground/80", big && "overflow-x-auto whitespace-pre rounded bg-surface-hover/60 p-1.5")}>
                        {big ? s : shorten(s, 160)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          )}
          {item.result && (
            <div>
              <div className="mb-0.5 text-2xs uppercase tracking-wide text-muted-foreground/50">输出</div>
              <pre className={cn(
                "max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-hover/60 p-1.5 font-mono text-2xs",
                failed ? "text-danger" : "text-muted-foreground/80",
              )}>
                {item.result}
              </pre>
            </div>
          )}
          {!params && !item.result && <div className="text-2xs text-muted-foreground/50">没有可用详情</div>}
        </div>
      )}
    </div>
  );
}

function PhaseBody({
  phase, phaseIdx, openRows, onToggleRow, showHeader,
}: {
  phase: { phase: Phase; tools: ToolItem[] };
  phaseIdx: number;
  openRows: Set<string>;
  onToggleRow: (k: string) => void;
  showHeader?: boolean;
}) {
  const Icon = PHASE_ICON[phase.phase];
  const label = PHASE_LABEL[phase.phase];
  return (
    <div className="ml-1 flex flex-col border-l border-border/40 pl-2">
      {showHeader && (
        <div className="flex items-center gap-1.5 px-2 py-0.5 text-2xs text-muted-foreground/50">
          <Icon className="w-2.5 h-2.5" />
          {label.verb} {phase.tools.length} {label.noun}
        </div>
      )}
      {phase.tools.map((t, j) => {
        const key = phaseIdx + ":" + j;
        return <ToolRow key={j} item={t} expanded={openRows.has(key)} onToggle={() => onToggleRow(key)} />;
      })}
    </div>
  );
}

/**
 * 展开状态的**模块级缓存** —— 组件卸载后不丢。
 *
 * 为什么需要：openPhase / openRows 原来是组件本地 state。
 * 用户展开某条工具详情 → 切到别的会话（组件卸载）→ 切回来（重新挂载）
 * → 状态归零，又变回折叠的（用户实测报的）。
 *
 * 用模块级 Map 而不是提升到 ChatPanel：这份状态纯属展示细节，
 * 提升上去要把 props 穿过 MessageList 好几层，不值。
 * key 由调用方给，**必须含 messageId** —— 只用下标的话不同消息会撞。
 */
interface TrackUiState { openPhase: number | null; openRows: Set<string> }
const trackUiCache = new Map<string, TrackUiState>();

export function ToolActivityTrack({ items, running, persistKey }: {
  items: ToolItem[];
  running: boolean;
  /** 稳定且全局唯一的 key（含消息 id）。缺省则不持久化（行为同以前） */
  persistKey?: string;
}) {
  const [openPhase, setOpenPhase] = React.useState<number | null>(
    () => (persistKey ? trackUiCache.get(persistKey)?.openPhase ?? null : null),
  );
  const [openRows, setOpenRows] = React.useState<Set<string>>(
    () => (persistKey ? new Set(trackUiCache.get(persistKey)?.openRows ?? []) : new Set()),
  );

  // 每次变化写回缓存 —— 卸载时不用额外清理，值已经在里面了
  React.useEffect(() => {
    if (!persistKey) return;
    trackUiCache.set(persistKey, { openPhase, openRows });
  }, [persistKey, openPhase, openRows]);

  const phases = React.useMemo(() => buildPhases(items), [items]);
  if (items.length === 0) return null;

  const togglePhase = (i: number) => {
    setOpenPhase((prev) => (prev === i ? null : i));
    setOpenRows(new Set());
  };
  const toggleRow = (key: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const MAX_AVATARS = 8;
  const shown = phases.length > MAX_AVATARS ? phases.slice(-MAX_AVATARS) : phases;
  const hidden = phases.length - shown.length;

  return (
    <div className="my-1.5 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="flex items-center">
          {hidden > 0 && (
            <span
              title={phases.slice(0, hidden).map((p) => PHASE_LABEL[p.phase].verb).join("、")}
              className="z-0 -mr-1.5 inline-flex h-6 items-center rounded-full border border-border bg-surface px-1.5 text-2xs text-muted-foreground/70 ring-2 ring-background"
            >
              +{hidden}
            </span>
          )}
          {shown.map((p, i) => {
            const realIdx = hidden + i;
            const Icon = PHASE_ICON[p.phase];
            const active = openPhase === realIdx;
            const isLast = running && i === shown.length - 1;
            return (
              <button
                key={realIdx}
                type="button"
                aria-label={p.phase + " 阶段，" + p.tools.length + " 个工具"}
                aria-expanded={active}
                onClick={() => togglePhase(realIdx)}
                title={PHASE_LABEL[p.phase].verb + " " + p.tools.length + " " + PHASE_LABEL[p.phase].noun}
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full border bg-surface ring-2 ring-background transition-all",
                  "hover:border-muted-foreground/40",
                  active ? "z-20 border-muted-foreground/60 bg-surface-hover" : "z-0",
                  i > 0 && "-ml-[7px]",
                  isLast && "animate-pulse",
                )}
              >
                <Icon className="w-3 h-3 text-muted-foreground/70" />
              </button>
            );
          })}
        </div>

        <span className={cn("text-xs text-muted-foreground/70", running && "animate-pulse")}>
          {running ? runningLabel(items) : summarizeRun(items)}
        </span>

        {phases.length > 1 && (
          <button
            type="button"
            onClick={() => { setOpenPhase(openPhase === -1 ? null : -1); setOpenRows(new Set()); }}
            title="展开全部阶段"
            className="text-2xs text-muted-foreground/50 hover:text-muted-foreground"
          >
            {openPhase === -1 ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        )}
      </div>

      {openPhase === -1
        ? phases.map((p, i) => (
            <PhaseBody key={i} phase={p} phaseIdx={i} openRows={openRows} onToggleRow={toggleRow} showHeader />
          ))
        : openPhase !== null && phases[openPhase] && (
            <PhaseBody phase={phases[openPhase]!} phaseIdx={openPhase} openRows={openRows} onToggleRow={toggleRow} />
          )}
    </div>
  );
}
