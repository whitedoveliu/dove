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
  /**
   * token 用量（入 / 出）。两个来源、**同一个数**：
   *   · 实时：内核在 subagent_done / task_done 事件里发的那份（run 的结果）；
   *   · 刷新后：8008 的子代理列表从任务表带出来的那份（见 legacy/routes-subagents.ts）。
   * undefined / null = 没记录或 provider 没报 → 显示「未上报」，
   * **绝不显示 0**（0 会被读成「没花 token」，见 agents/task-registry.ts:finish）。
   */
  usage?: { inputTokens?: number; outputTokens?: number } | null;
}

const MAX_STEPS = 200;
const MAX_TEXT = 1200;

export function reduceSubagents(
  prev: SubagentInfo[],
  e: { action?: string; label?: string; taskId?: string; subagentId?: string; content?: string;
       tool?: string; info?: string; steps?: number; endReason?: string; background?: boolean;
       usage?: { inputTokens?: number; outputTokens?: number } | null },
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
    // usage 只在这次事件里带 —— done 之后不会再有更新，所以拿不到就保持原值
    const usage = e.usage ?? undefined;
    let i = prev.findIndex((s) => s.key === key);
    if (i < 0) i = prev.findIndex((s) => s.label === label && s.status === "running");
    if (i < 0) {
      return [...prev, {
        key, id: sid || key, label: label || "子任务", background: e.background === true,
        status, steps: [], stepCount: Number(e.steps ?? 0),
        usage,
      }];
    }
    const next = prev.slice();
    next[i] = { ...next[i]!, status, stepCount: Number(e.steps ?? 0), usage: usage ?? next[i]!.usage ?? undefined };
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

/** 紧凑 token 数：1234 → 1.2k。**没有 0 的用法** —— 没上报就是不显示 */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + "k";
}

/**
 * 耗时文案：`14分50秒` / `1小时2分` / `38秒`。
 *
 * 读法对齐 Kimi Code 那排后台任务卡片（中文、不带冒号、超过一小时才说小时）——
 * 秒数在跑的时候是活的（调用方自己按 startedAt 走表，见 subagent-pane 的 useNow）。
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/**
 * 用量文案。**未上报 ≠ 0**：没有数就写「未上报」，写 0 会被读成「没花 token」
 * （内核存的也是 NULL 而不是 0，两边口径一致，见 agents/task-registry.ts:finish）。
 */
function usageLine(u: SubagentInfo["usage"]): string {
  if (!u) return "用量未上报";
  return "用量 " + fmtTokens(u.inputTokens ?? 0) + " 入 / " + fmtTokens(u.outputTokens ?? 0) + " 出";
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
                {/* 已经拿到用量的（后台任务收尾后）在胶囊上直接给个总数，不用点开 */}
                {a.usage && (
                  <span className="text-2xs opacity-70" title={usageLine(a.usage)}>
                    {fmtTokens((a.usage.inputTokens ?? 0) + (a.usage.outputTokens ?? 0))} tok
                  </span>
                )}
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
              {/* 用量：结束后才有数。还没结束时不写「未上报」—— 那不是"没报"，是"还没到" */}
              {a.status !== "running" && (
                <>
                  <span>·</span>
                  <span>{usageLine(a.usage)}</span>
                </>
              )}
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

/**
 * 输入框上方的后台任务按钮（「后台 Agent n」）。
 *
 * 对齐 Kimi Code：输入框上方一排小按钮，点了在**右侧面板**开「后台 Agent」那一页
 * （不是在这里展开 —— 过程要看的东西多，得给块整地方）。
 *
 * 几条取舍，写下来免得下次有人「顺手」改掉：
 *   · 这里**只有 Agent 一种**。Kimi 还有「后台 Bash」（后台跑的命令流），
 *     而 Dove 的后台任务只有子代理一种（Bash 走工具、没有后台模式）——
 *     不给一个按不动的按钮，等真有后台命令了再加第二个。
 *   · 只在**当前项目有子代理**时出现；一旦出现就一直在（跑完了也留着），
 *     否则刷新之后就没有入口去看已完成的那些了（用户明确要求「刷新后还能看到」）。
 *   · 数量角标：跑着几个就显示几个（带转圈）；都跑完了显示总数（带对勾）。
 */
export function SubagentButtons({
  agents, onOpen, className,
}: {
  agents: SubagentInfo[];
  /** 点按钮 → 打开右侧面板的「后台 Agent」页 */
  onOpen: () => void;
  className?: string;
}) {
  if (agents.length === 0) return null;
  const running = agents.filter((a) => a.status === "running").length;

  return (
    <div className={cn("flex items-center gap-1.5 px-1", className)}>
      <button
        type="button"
        onClick={onOpen}
        title={
          running > 0
            ? `${running} 个 Agent 正在后台跑，点开看它们的进度与过程`
            : `${agents.length} 个后台 Agent 已结束，点开看它们的过程`
        }
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-full border border-border bg-surface-inset px-2 text-2xs",
          "text-text-secondary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary",
        )}
      >
        {running > 0
          ? <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
          : <Bot className="size-3 shrink-0" />}
        <span>后台 Agent</span>
        <span
          className={cn(
            "rounded-sm px-1 font-medium tabular-nums",
            running > 0 ? "bg-accent-subtle text-accent-subtle-fg" : "bg-surface-hover text-text-tertiary",
          )}
        >
          {running > 0 ? running : agents.length}
        </span>
      </button>
    </div>
  );
}
