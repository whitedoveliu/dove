"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, FileText } from "lucide-react";

import { cn } from "@/lib/utils";
import { findMessageElement } from "@/lib/message-anchor";

/* ============================== 契约（纯 props） ============================== */

export interface PromptRailItem {
  /** 这条 user prompt 对应哪条消息（点击回跳用） */
  messageId: string;
  /** 该 prompt 的原文（气泡里显示，内部自己截断） */
  text: string;
  /** 它后面那条助手回复的摘要（气泡里显示第二行；拿不到就不显示这一行） */
  replySummary?: string;
  /** 该轮产生/改动的文件（气泡里的 chip，例如 exec-2xxx.png） */
  files?: { name: string; path: string }[];
}

export interface PromptRailProps {
  items: PromptRailItem[];
  /** 点击某根横线：父代理滚动到那条消息 */
  onJump: (messageId: string) => void;
  /** 当前视口附近的 prompt（不传时自己按滚动位置算） */
  activeMessageId?: string | null;
  /** 滚动容器的引用或「取滚动容器」的函数：用于计算每根横线的纵向位置 */
  getScrollContainer?: () => HTMLElement | null;
  /**
   * 逃生口：消息 DOM 上没有 `data-message-id` 时，父代理可以直接给出元素。
   * 不给就按 `[data-message-id="<id>"]` 找（找到才算得出位置，见下面的降级说明）。
   */
  resolveMessageElement?: (messageId: string) => HTMLElement | null;
  /** 只用来加放置/间距类名：栏宽由组件自己定（26px），别在这里改宽度 */
  className?: string;
}

/* ================================== 常量 ================================== */

/** 默认刻度长 8px，hover/聚焦变 22px（产品要求「hover 的时候横线变长」） */
const TICK_SHORT = 8;
const TICK_LONG = 22;
const TICK_THICK = 2;

/** 栏宽 26px：够放下变长后的横线，又不至于挡住右边的预览面板 */
const RAIL_WIDTH = 26;
/**
 * 距窗口右缘的安全边距。Tauri 窗口有圆角 / 系统安全区，贴死右缘的话
 * 横线和气泡会被切掉一角 —— 所以整条栏的刻度统一右缩 5px。
 */
const EDGE_INSET = 5;

const BUBBLE_WIDTH = 268;
/** 气泡与横线之间的缝 —— 留一点，视线能从横线牵到卡片上 */
const BUBBLE_GAP = 10;
/** 气泡距窗口四边的最小距离（防裁切） */
const BUBBLE_MARGIN = 8;
const BUBBLE_ID = "prompt-rail-bubble";

/** 气泡里最多显示几个文件 chip，其余折成 +N */
const CHIP_LIMIT = 3;

/** 单根横线的命中区高度：按数量自适应（稀疏时给足 14px，密集时收到 6px） */
const ROW_MIN = 6;
const ROW_MAX = 14;

/* ================================= 小工具 ================================= */

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** 位置只在看得见的差别上重渲染，省掉滚动时每帧的 setState */
function sameLayout(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) > 0.5) return false;
  }
  return true;
}

/** 文件名（气泡里的 chip 只显示名字，完整路径放 title） */
function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut >= 0 ? path.slice(cut + 1) : path;
}

function ariaLabelFor(item: PromptRailItem, index: number): string {
  const head = item.text.replace(/\s+/g, " ").trim().slice(0, 32);
  return head ? `跳转到第 ${index + 1} 条提示词：${head}` : `跳转到第 ${index + 1} 条提示词`;
}

/* ================================== 组件 ================================== */

/**
 * PromptRail —— 会话最右缘的「提示词刻度栏」。
 *
 * 一根横线 = 一次 user prompt，纵向位置 = 这条消息在**消息滚动容器**里的相对位置
 * （`offsetTop / scrollHeight`），所以它既是 minimap 也是书签：滚动时横线**不动**
 * （动的是你正看的那一段），hover 出现该轮的对话气泡，点击跳过去。
 *
 * 为什么不用固定间距：会话里每条消息的高度差着一个量级（一句「hi」和一轮十几屏的
 * 工具输出），一律等分会把「位置感」整个抹掉 —— 那就退回成一个序号列表，
 * 用户看不出自己现在读到哪、后面还剩多少。等分只作为**算不出位置时**的兜底。
 *
 * 气泡不用 radix Tooltip 而自绘，理由有三条：
 *   ① 刻度只有 2px 高，需要**零延迟**跟手（Tooltip 的 delay/skipDelay 机器在这里是负担）；
 *   ② 需求是「hover 与 focus-visible 同样出气泡」，自绘能直接用 `:focus-visible` 判定，
 *      而 Tooltip 任何形式的聚焦都会弹（鼠标点一下也弹，不是想要的）；
 *   ③ 栏贴窗口右缘，气泡必须自己贴边/夹紧；自己拿 getBoundingClientRect 算最直接，
 *      也不用被 Provider 的嵌套语义牵着走。
 * 代价：气泡内容不可交互（本需求里只是展示），所以设了 pointer-events-none，
 * 顺带保证鼠标划过气泡不会把横线的 hover 抢走。
 */
export function PromptRail({
  items,
  onJump,
  activeMessageId,
  getScrollContainer,
  resolveMessageElement,
  className,
}: PromptRailProps): React.JSX.Element | null {
  const railRef = React.useRef<HTMLElement | null>(null);
  const bubbleRef = React.useRef<HTMLDivElement | null>(null);
  const tickRefs = React.useRef(new Map<string, HTMLButtonElement>());
  /** rAF 里要知道「现在开着哪张气泡」，又不想把它塞进 recompute 的依赖里 */
  const openIdRef = React.useRef<string | null>(null);

  /**
   * props / items 的「最新值」ref —— 重算只从 ref 读，所以 `recompute` 与
   * `schedule` 的身份**永不变化**，下面那套监听 + ResizeObserver 只会装一次。
   *
   * 为什么非要这样：`items` 每次流式 delta 都会换一个新数组（ChatPanel 的
   * applyMessages 每帧都 setMessages 一个新 list），父代理传的 getScrollContainer
   * 以前还是个内联箭头 —— effect 依赖它们 = 每个 delta 拆掉重建一个 observer
   * 和两个监听（cleanup 是对的、不是泄漏，但纯属白干）。
   */
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  const getScrollContainerRef = React.useRef(getScrollContainer);
  getScrollContainerRef.current = getScrollContainer;
  const resolveMessageElementRef = React.useRef(resolveMessageElement);
  resolveMessageElementRef.current = resolveMessageElement;

  /** 每根横线的 y（相对栏顶，px）；首帧 ys 还没跟上 items 时缺项 → 渲染退回按比例均分 */
  const [ys, setYs] = React.useState<number[]>([]);
  const [rowH, setRowH] = React.useState(ROW_MAX);
  /** hover / 键盘聚焦打开的气泡 */
  const [openId, setOpenId] = React.useState<string | null>(null);
  /** 自己算出来的「视口附近」下标（父代理传了 activeMessageId 就以它为准） */
  const [scrolledActive, setScrolledActive] = React.useState(-1);

  const placeBubble = React.useCallback(() => {
    const id = openIdRef.current;
    const node = bubbleRef.current;
    if (!id || !node) return;
    const tick = tickRefs.current.get(id);
    if (!tick) return;

    const rect = tick.getBoundingClientRect();
    const w = BUBBLE_WIDTH;
    const h = node.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 横向：优先贴横线**左侧**展开（栏在最右缘，右边根本没地方）。
    // 左边放不下就翻到右侧；两边都紧就贴着窗口边夹住 —— 总之不越界。
    const leftOfTick = rect.left - BUBBLE_GAP - w;
    const rightOfTick = rect.right + BUBBLE_GAP;
    let left: number;
    if (leftOfTick >= BUBBLE_MARGIN) left = leftOfTick;
    else if (rightOfTick + w <= vw - BUBBLE_MARGIN) left = rightOfTick;
    else left = vw - BUBBLE_MARGIN - w;
    left = Math.max(BUBBLE_MARGIN, left);

    // 纵向：气泡中心对齐横线；上下留 BUBBLE_MARGIN，越界就把整张卡推回来。
    // （「翻转」在这里等价于夹紧：都要让卡片离横线最近且完整可见，
    //   硬翻到另一侧反而会让卡片飞到屏幕另一头，和横线失去视觉联系。）
    let top = rect.top + rect.height / 2 - h / 2;
    top = Math.max(BUBBLE_MARGIN, Math.min(top, vh - BUBBLE_MARGIN - h));

    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }, []);

  /**
   * 重算所有横线的纵向位置。
   * 读（getBoundingClientRect）全部先做完再一起 setState，避免读写交错反复触发布局。
   * **身份稳定**（只依赖 placeBubble），因为它被下面的监听/observer 闭包持有 ——
   * 每帧换新函数等于每帧重装监听，见上面的 refs 注释。
   */
  const recompute = React.useCallback(() => {
    const list = itemsRef.current;
    const rail = railRef.current;
    const n = list.length;
    if (!rail || n === 0) return;
    const railH = rail.clientHeight;
    if (railH <= 0) return;

    const nextRowH = clamp(railH / n, ROW_MIN, Math.min(ROW_MAX, railH / 2));
    const pad = nextRowH / 2;

    const container = getScrollContainerRef.current?.() ?? null;
    const scrollH = container?.scrollHeight ?? 0;
    const usable = container && scrollH > 0;
    const containerRect = usable ? container.getBoundingClientRect() : null;

    // 滚动容器落在栏的哪一段（0..1）。拿不到容器就退化成「占满整条栏」。
    const railRect = rail.getBoundingClientRect();
    let bandTop = 0;
    let bandBottom = 1;
    if (containerRect && railRect.height > 0) {
      const top = clamp01((containerRect.top - railRect.top) / railRect.height);
      const bottom = clamp01((containerRect.bottom - railRect.top) / railRect.height);
      bandTop = Math.min(top, bottom);
      bandBottom = Math.max(top, bottom);
    }

    const ratios: (number | null)[] = list.map((item) => {
      if (!container || !containerRect || !usable) return null;
      const el =
        resolveMessageElementRef.current?.(item.messageId) ??
        findMessageElement(container, item.messageId);
      if (!el || !container.contains(el)) return null;
      // 消息相对内容原点的偏移 → 占整段会话的比例（滚动位置不参与，所以横线是书签不是滑块）
      const offset = el.getBoundingClientRect().top - containerRect.top + container.scrollTop;
      return clamp01(offset / scrollH);
    });

    const nextYs = list.map((_, i) => {
      const ratio = ratios[i];
      // 降级：拿不到容器、或这条消息在 DOM 里找不到时，按序号等分插值。
      // 逐条降级而不是「一坏全坏」：流式新增的消息会晚一帧出现，
      // 整体切模式会让整条栏闪一下，逐条兜底则自然收敛。
      if (ratio == null) return pad + ((i + 0.5) / n) * (railH - 2 * pad);
      // 比例 → 栏内位置：先落进**滚动容器在屏幕上的那一段**再换算到栏的坐标系。
      // 栏和容器上下对齐时这就是简单缩放；栏比容器高（比如整窗高 vs 消息区）时，
      // 横线仍然和消息待在同一水平带上，而不是被均匀摊满整条栏。
      const fraction = bandTop + ratio * (bandBottom - bandTop);
      return pad + fraction * (railH - 2 * pad);
    });

    // 「当前视口附近的 prompt」= 滚动锚点（视口 40% 处）往上最后越过的那条
    let nextActive = -1;
    if (container && scrollH > 0) {
      const anchor = (container.scrollTop + container.clientHeight * 0.4) / scrollH;
      ratios.forEach((ratio, i) => {
        if (ratio !== null && ratio <= anchor) nextActive = i;
      });
    }

    setRowH((prev) => (Math.abs(prev - nextRowH) > 0.5 ? nextRowH : prev));
    setYs((prev) => (sameLayout(prev, nextYs) ? prev : nextYs));
    setScrolledActive((prev) => (prev === nextActive ? prev : nextActive));
    placeBubble();
  }, [placeBubble]);

  /** 每帧最多算一次（不在事件回调里同步 reflow）—— 身份稳定，见 refs 注释 */
  const rafRef = React.useRef(0);
  const schedule = React.useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      recompute();
    });
  }, [recompute]);

  /**
   * 位置重算的**装置**：滚动监听 + resize + ResizeObserver，全在一个只装一次的 effect 里
   * （依赖只有身份稳定的 `schedule`）。
   */
  React.useEffect(() => {
    const container = getScrollContainerRef.current?.() ?? null;

    schedule();
    container?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      if (container) {
        observer.observe(container);
        // 容器自己是 flex-1 + overflow-y-auto，高度由布局定死：内容长高**不会**让它触发，
        // 所以要盯住它的直接子元素，否则流式新增消息时横线一直停在旧位置。
        const inner = container.firstElementChild;
        if (inner) observer.observe(inner);
      }
      if (railRef.current) observer.observe(railRef.current);
    }

    return () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      container?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [schedule]);

  // items 变了（新增一轮 / 流式更新 / 换会话）就重算一次位置。
  // 这里依赖的是 items 的**身份**——每次流式 delta 都会换新数组，所以触发词恰好是「每次更新」，
  // 但代价只有一个 rAF，装置本身不再重建（这是 ⑥ 要修的那个开销）。
  React.useEffect(() => {
    schedule();
  }, [items, schedule]);

  /**
   * 窗口失焦 / 页面藏起来时收掉气泡。
   *
   * 气泡只由 pointerenter/pointerleave 与 focus/blur 驱动，而**窗口失焦不派发
   * pointerleave**（切到别的 App、最小化、切到别的标签页都算）：指针在屏幕上的位置没变，
   * 于是气泡和那根变长的横线留在画面上，回来时看着像「鼠标还停在那儿」。
   * 这是唯一一条不问指针、只问窗口的清理路径。
   */
  React.useEffect(() => {
    const close = () => setOpenId(null);
    const onVisibilityChange = () => { if (document.hidden) close(); };
    window.addEventListener("blur", close);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", close);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // 换了一根横线（或刚拿到新位置）就把气泡重新贴一次 —— 布局阶段同步执行，
  // 所以气泡不会先出现在左上角再跳过去。
  React.useLayoutEffect(() => {
    openIdRef.current = openId;
    placeBubble();
  }, [openId, placeBubble, ys, rowH]);

  // 少于两条就没有「导航」可言，还白挡一块地方 —— 整条栏不渲染。
  if (items.length < 2) return null;

  const n = items.length;
  const propActive =
    activeMessageId != null ? items.findIndex((item) => item.messageId === activeMessageId) : -1;
  const activeIndex = propActive >= 0 ? propActive : scrolledActive;

  const openItem = openId ? items.find((item) => item.messageId === openId) ?? null : null;
  const openFiles = openItem?.files ?? [];
  const hiddenFiles = Math.max(0, openFiles.length - CHIP_LIMIT);

  const focusTick = (index: number) => {
    const target = items[clamp(index, 0, n - 1)];
    tickRefs.current.get(target.messageId)?.focus();
    setOpenId(target.messageId);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case "Enter":
      case " ":
        // 自己处理：preventDefault 顺手掐掉按钮的原生「keydown 即 click」，
        // 否则 Enter/Space 会触发两次 onJump。
        event.preventDefault();
        setOpenId(items[index].messageId);
        onJump(items[index].messageId);
        break;
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        focusTick(index + 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        focusTick(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusTick(0);
        break;
      case "End":
        event.preventDefault();
        focusTick(n - 1);
        break;
      case "Escape":
        event.preventDefault();
        // 只收气泡。别让它冒到 window 上（App 有全局快捷键监听）。
        event.stopPropagation();
        setOpenId(null);
        break;
      default:
        break;
    }
  };

  return (
    <nav
      ref={railRef}
      aria-label="提示词导航"
      className={cn(
        // pointer-events-none：空处不挡右边预览面板的点击；命中区由每根横线自己打开
        "pointer-events-none relative h-full shrink-0 select-none",
        className
      )}
      style={{ width: RAIL_WIDTH }}
    >
      {items.map((item, index) => {
        const measured = ys[index];
        const isOpen = openId === item.messageId;
        const isActive = index === activeIndex;
        return (
          <button
            key={item.messageId}
            ref={(node) => {
              if (node) tickRefs.current.set(item.messageId, node);
              else tickRefs.current.delete(item.messageId);
            }}
            type="button"
            role="button"
            tabIndex={0}
            aria-label={ariaLabelFor(item, index)}
            aria-describedby={isOpen ? BUBBLE_ID : undefined}
            data-active={isActive || undefined}
            // 命中区是整行（栏宽 × rowH），横线只是行右端的一根线：
            // 这样 hover 时线变长不会让指针落空、来回闪。
            className="group pointer-events-auto absolute left-0 right-0 flex cursor-pointer items-center justify-end focus-visible:outline-none"
            style={{
              top: measured != null ? `${measured}px` : `${((index + 0.5) / n) * 100}%`,
              height: rowH,
              paddingRight: EDGE_INSET,
              transform: "translateY(-50%)",
            }}
            onClick={() => {
              setOpenId(item.messageId);
              onJump(item.messageId);
            }}
            onPointerEnter={() => setOpenId(item.messageId)}
            onPointerLeave={() => setOpenId((prev) => (prev === item.messageId ? null : prev))}
            onFocus={(event) => {
              // 只要键盘来的焦点（鼠标点一下也弹气泡会很吵）
              if (event.currentTarget.matches(":focus-visible")) setOpenId(item.messageId);
            }}
            onBlur={() => setOpenId((prev) => (prev === item.messageId ? null : prev))}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <span
              aria-hidden
              className={cn(
                // 长度和颜色都由 openId（hover / 键盘聚焦）驱动而不是靠 CSS :hover ——
                // 一条状态源：横线变长和气泡弹出永远同时发生。
                "shrink-0 rounded-full transition-all duration-fast ease-standard motion-reduce:transition-none",
                "group-focus-visible:ring-2 group-focus-visible:ring-accent-ring/50",
                isOpen ? "bg-accent" : isActive ? "bg-text-secondary" : "bg-text-tertiary/40"
              )}
              style={{ height: TICK_THICK, width: isOpen ? TICK_LONG : TICK_SHORT }}
            />
          </button>
        );
      })}

      {openItem &&
        typeof document !== "undefined" &&
        createPortal(
          // key=openId：换横线时重放一次进场动画，让「气泡跟着指针走」看得出来
          <div
            key={openId}
            id={BUBBLE_ID}
            ref={bubbleRef}
            role="tooltip"
            className="pointer-events-none fixed left-0 top-0 z-tooltip animate-pop-in rounded-xl border border-border-subtle bg-surface-overlay p-2.5 shadow-lg"
            style={{ width: BUBBLE_WIDTH }}
          >
            <p className="line-clamp-2 break-words text-xs text-text-primary">{openItem.text}</p>

            {openItem.replySummary && (
              <p className="mt-1.5 flex items-start gap-1 text-2xs text-text-secondary">
                <CornerDownRight className="mt-0.5 size-3 shrink-0 text-text-tertiary" />
                <span className="line-clamp-1">{openItem.replySummary}</span>
              </p>
            )}

            {openFiles.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {openFiles.slice(0, CHIP_LIMIT).map((file) => (
                  <span
                    key={file.path}
                    title={file.path}
                    className="flex max-w-[124px] items-center gap-1 rounded-md bg-surface-inset px-1.5 py-0.5 font-mono text-2xs text-text-secondary"
                  >
                    <FileText className="size-3 shrink-0 text-text-tertiary" />
                    <span className="truncate">{file.name || basename(file.path)}</span>
                  </span>
                ))}
                {hiddenFiles > 0 && (
                  <span className="rounded-md bg-surface-inset px-1.5 py-0.5 font-mono text-2xs text-text-tertiary">
                    +{hiddenFiles}
                  </span>
                )}
              </div>
            )}
          </div>,
          document.body
        )}
    </nav>
  );
}

export default PromptRail;
