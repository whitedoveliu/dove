import * as React from "react";
import { Bot, ChevronDown, ChevronRight, Loader2, Check, X, Brain, Wrench, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { displayName } from "@/components/tool-activity";

/**
 * 子代理状态栏（顶部）
 *
 * 子代理是**上下文隔离**的：它在自己的上下文里翻文件、试错，
 * 主对话里只会看到一句「Task」然后干等。所以这里要能看到：
 *   · 有几个在跑、分别叫什么
 *   · 它**正在想什么**（reasoning）、**正在跑什么**（工具调用，带参数）
 * 展开后是**有边界的滚动框**，内容按时间往下滚，自动跟到底部。
 */

export type SubagentStep =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; tool: string; info: string }
  | { kind: "text"; text: string };

export interface SubagentInfo {
  key: string;
  /** 内核给的线程 id —— 归户、点进去拉历史都用它 */
  id: string;
  /** 谁派的（线程 id）。空 = 直接由主对话派出 */
  parentId?: string;
  /** 树深度，用于缩进（当前子代理不能再派子代理，所以实际只有 0/1） */
  depth?: number;
  label: string;
  background: boolean;
  status: "running" | "done" | "error";
  /** 实时时间线 */
  steps: SubagentStep[];
  /** 内核报的步数 */
  stepCount: number;
}

const MAX_STEPS = 200;
const MAX_TEXT = 1200;

export function reduceSubagents(
  prev: SubagentInfo[],
  e: { action?: string; label?: string; taskId?: string; subagentId?: string; content?: string;
       tool?: string; info?: string; steps?: number; endReason?: string; background?: boolean },
): SubagentInfo[] {
  const action = String(e.action ?? "");
  const label = String(e.label ?? "");
  const sid = String(e.subagentId ?? "");
  const key = String(sid || e.taskId || label || "subagent");

  /**
   * 归户优先级：**subagentId → label → 最近一个在跑的**。
   * id 是最可靠的；只有 label 时两个同名的并发子代理会串（实测过），
   * 最后那级兜底只在事件没带 id 时才会用到（老内核）。
   */
  const findIdx = (arr: SubagentInfo[]): number => {
    let i = sid ? arr.findIndex((s) => s.id === sid) : -1;
    if (i < 0 && label) i = arr.findIndex((s) => s.label === label && s.status === "running");
    if (i < 0 && label) i = arr.findIndex((s) => s.label === label);
    if (i < 0) {
      const r = [...arr].reverse().findIndex((s) => s.status === "running");
      if (r >= 0) i = arr.length - 1 - r;
    }
    return i;
  };

  if (action === "reasoning" || action === "text" || action === "tool") {
    const i = findIdx(prev);
    if (i < 0) return prev;
    const next = prev.slice();
    const cur = next[i]!;
    const steps = cur.steps.slice();

    if (action === "tool") {
      steps.push({ kind: "tool", tool: String(e.tool ?? ""), info: String(e.info ?? "") });
    } else {
      // reasoning 和 text 都按「连续同类型合并」—— 否则每个 token 一条会把列表刷爆
      const kind = action === "reasoning" ? "reasoning" as const : "text" as const;
      const chunk = String(e.content ?? "");
      const last = steps[steps.length - 1];
      if (last?.kind === kind) {
        steps[steps.length - 1] = { kind, text: (last.text + chunk).slice(-MAX_TEXT) };
      } else if (chunk) {
        steps.push({ kind, text: chunk.slice(-MAX_TEXT) });
      }
    }

    next[i] = { ...cur, steps: steps.slice(-MAX_STEPS) };
    return next;
  }

  if (action === "start") {
    if (prev.some((s) => s.key === key)) return prev;
    return [...prev, {
      key, id: sid || key, label: label || "子任务",
      background: e.background === true, status: "running", steps: [], stepCount: 0,
    }];
  }

  if (action === "done") {
    const status = e.endReason === "error" ? "error" as const : "done" as const;
    let i = prev.findIndex((s) => s.key === key);
    if (i < 0) i = prev.findIndex((s) => s.label === label && s.status === "running");
    if (i < 0) {
      return [...prev, {
        key, id: sid || key, label: label || "子任务", background: e.background === true,
        status, steps: [], stepCount: Number(e.steps ?? 0),
      }];
    }
    const next = prev.slice();
    next[i] = { ...next[i]!, status, stepCount: Number(e.steps ?? 0) };
    return next;
  }

  return prev;
}

/**
 * 把扁平的子代理列表整理成树（A5）。
 *
 * 按 parentId 挂到父节点下面，并算出 depth 供缩进用。
 * 认不出父节点的（父已删/跨项目）当根处理 —— 不能因为一个孤儿就把整棵子树丢了。
 *
 * 诚实说明：当前子代理**不能再派子代理**（spawnSubagent: undefined 是刻意的防递归），
 * 所以实际只会有一层。这里按多层实现，等将来放开递归时不用重写。
 */
export function buildTree(agents: SubagentInfo[]): SubagentInfo[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const depth = new Map<string, number>();
  const calc = (a: SubagentInfo, seen: Set<string>): number => {
    if (depth.has(a.id)) return depth.get(a.id)!;
    if (seen.has(a.id)) return 0;                       // 成环保护
    const pid = a.parentId;
    const parent = pid ? byId.get(pid) : undefined;
    if (!parent) { depth.set(a.id, 0); return 0; }
    seen.add(a.id);
    const d = calc(parent, seen) + 1;
    depth.set(a.id, d);
    return d;
  };
  // 排序：先按树深度（父在子前），同深度保持传入顺序（调用方已按开始时间排过）
  return agents
    .map((a, i) => ({ a: { ...a, depth: calc(a, new Set()) }, i }))
    .sort((x, y) => (x.a.depth! - y.a.depth!) || (x.i - y.i))
    .map((x) => x.a);
}

function StepLine({ step }: { step: SubagentStep }) {
  if (step.kind === "reasoning") {
    return (
      <div className="flex gap-1.5 text-2xs italic text-text-tertiary">
        <Brain className="mt-0.5 size-2.5 shrink-0 opacity-60" />
        <span className="whitespace-pre-wrap break-words">{step.text}</span>
      </div>
    );
  }
  if (step.kind === "tool") {
    return (
      <div className="flex gap-1.5 font-mono text-2xs">
        <Wrench className="mt-0.5 size-2.5 shrink-0 text-muted-foreground/60" />
        <span className="shrink-0 text-muted-foreground">{displayName(step.tool)}</span>
        {step.info && <span className="truncate text-muted-foreground/60">{step.info}</span>}
      </div>
    );
  }
  return (
    <div className="flex gap-1.5 text-2xs text-text-secondary">
      <MessageSquare className="mt-0.5 size-2.5 shrink-0 opacity-60" />
      <span className="whitespace-pre-wrap break-words">{step.text}</span>
    </div>
  );
}

/** 展开后的实时框：有边界 + 自动滚到底 */
function LiveBox({ agent }: { agent: SubagentInfo }) {
  const ref = React.useRef<HTMLDivElement>(null);
  // 只在用户没往上翻时自动滚 —— 否则他往回看历史会被一直拽到底部
  const stickRef = React.useRef(true);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [agent.steps.length, agent.status]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="flex max-h-64 min-h-[4rem] flex-col gap-1 overflow-y-auto rounded bg-surface-hover/40 p-2"
    >
      {agent.steps.length === 0 && (
        <span className="text-2xs text-text-tertiary">
          {agent.status === "running" ? "（等待它输出…）" : "（没有留下过程记录）"}
        </span>
      )}
      {agent.steps.map((s, i) => <StepLine key={i} step={s} />)}
    </div>
  );
}

export function SubagentBar({
  agents, onClearDone, onOpen,
}: {
  agents: SubagentInfo[];
  onClearDone: () => void;
  /** 点「进入」→ 切到子代理视图（A4） */
  onOpen?: (a: SubagentInfo) => void;
}) {
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  // 有在跑的默认展开，用户一抬眼就能看到它在干什么
  const autoKey = agents.find((a) => a.status === "running")?.key ?? null;
  const effective = openKey ?? autoKey;
  const tree = buildTree(agents);

  if (agents.length === 0) return null;

  const running = agents.filter((a) => a.status === "running").length;
  const done = agents.length - running;

  return (
    <div className="mx-6 mb-1 mt-2 rounded-lg border border-border bg-surface/60">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        {running > 0
          ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-accent" />
          : <Check className="w-3.5 h-3.5 shrink-0 text-success" />}
        <span className="shrink-0 font-medium text-text-primary">
          {running > 0 ? running + " 个 subagent 工作中" : done + " 个 subagent 已完成"}
        </span>

        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tree.map((a) => {
            const active = effective === a.key;
            return (
              <button
                key={a.key}
                type="button"
                onClick={() => setOpenKey(active ? null : a.key)}
                title={a.label}
                // depth 缩进：嵌套子代理往里收（当前只有一层，将来放开递归就自动生效）
                style={{ marginLeft: a.depth ? a.depth * 10 : undefined }}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 transition-colors",
                  active ? "border-accent/60 bg-accent-subtle text-accent-subtle-fg" : "border-border text-text-secondary hover:bg-surface-hover",
                )}
              >
                <Bot className="w-3 h-3" />
                <span className="max-w-[10rem] truncate">{a.label}</span>
                {a.status === "running" && <span className="text-2xs opacity-70">…</span>}
                {a.status === "done" && <Check className="w-2.5 h-2.5 text-success" />}
                {a.status === "error" && <X className="w-2.5 h-2.5 text-danger" />}
                {active ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
              </button>
            );
          })}
        </div>

        {done > 0 && (
          <button
            type="button"
            onClick={onClearDone}
            className="shrink-0 text-2xs text-text-tertiary hover:text-text-secondary"
          >
            清掉已完成的
          </button>
        )}
      </div>

      {effective && (() => {
        const a = agents.find((x) => x.key === effective);
        if (!a) return null;
        return (
          <div className="border-t border-border px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-2xs text-text-tertiary">
              <span>{a.label}</span>
              <span>·</span>
              <span>{a.background ? "后台" : "前台"}</span>
              <span>·</span>
              <span>{a.status === "running" ? "进行中" : a.status === "done" ? "完成（" + a.stepCount + " 步）" : "失败"}</span>
              {onOpen && (
                <button
                  type="button"
                  onClick={() => onOpen(a)}
                  className="ml-auto rounded px-1.5 py-0.5 text-2xs text-accent transition-colors hover:bg-accent-subtle"
                >
                  进入查看 →
                </button>
              )}
            </div>
            <LiveBox agent={a} />
          </div>
        );
      })()}
    </div>
  );
}
