import * as React from "react";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 输入框的正文 —— **contenteditable 版**（textarea 装不下引用 chip）。
 *
 * 为什么不是 <textarea>：
 *   要在**文字中间**插「引用 chip」（圆角小药丸，hover 出原文），textarea 里
 *   一个元素都放不进去。只有两条路：
 *     (i) 透明 textarea + 镜像层：textarea 管输入，上面盖一层同样排版的镜像来画 chip。
 *         要求两层**逐像素同排版**，光标才是准的。但 chip 比它替代的原文**窄得多**，
 *         镜像里的折行位置必然和 textarea 自己算的不一样 —— 从 chip 往后，
 *         看到的位置和光标的真实位置就对不上了。做不到。
 *     (ii) contenteditable：排版归 DOM，chip 是真正的 inline 元素，
 *         光标 / 选择 / 折行全由浏览器算。**选这条。**
 *
 * 代价：textarea 白送的能力要自己接（换行、粘贴、长高、输入法），下面每处都写了为什么。
 * React 只负责挂载这一个**空**节点，内容归 DOM 自己长；只有「外部给的值 ≠ DOM 当前的
 * 序列化结果」时我们才把 DOM 写回去 —— 这样输入法拼字、Cmd+Z 撤销栈都不会被
 * React 的 re-render 打断。
 *
 * ⚠️ 序列化（serialize）：chip 序列化成**被引用文字的完整原文** —— 发出去的消息里
 *    必须是原文（这是「添加到评论」的全部意义），显示成缩写只是给人看的。
 */

/** ComposerBox 通过 ref 拿到这两个动作（React 19：ref 是普通 prop） */
export interface ComposerHandle {
  /** 把一段引用插到**光标处**（不是末尾、不是覆盖），显示成缩写 chip */
  insertReference: (text: string) => void;
  focus: () => void;
}

export interface ComposerInputProps {
  /** 序列化后的纯文本（chip 展开成原文）—— 和以前 textarea 的 value 同语义 */
  value: string;
  onChange: (v: string) => void;
  /** Enter / 方向键 / Escape 等按键的后处理（斜杠菜单、发送都在 ComposerBox 里） */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** 剪贴板里是文件时走这里（截图直接 Cmd+V、访达里拷贝的文件）—— 不往正文里粘路径 */
  onPasteFiles?: (files: File[]) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** 长到这个高度就内部滚动（和以前 textarea 的 max-h 对齐） */
  maxHeight?: number;
  ref?: React.Ref<ComposerHandle>;
}

/** 引用 chip 的长相：圆角浅色药丸 + 左侧引号图标（对齐截图） */
const CHIP_CLASS = cn(
  "mx-[1px] inline-flex max-w-[15rem] select-none items-center gap-1 whitespace-nowrap",
  "rounded-md border border-accent-border bg-accent-subtle px-1.5 py-[1px]",
  "align-baseline text-[0.92em] leading-[1.45] text-accent-subtle-fg",
);

/** 静态的引号图标（lucide quote）。**常量字符串**，chip 里的用户内容一律走 textContent */
const QUOTE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" width="10" height="10" aria-hidden="true">' +
  '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/>' +
  '<path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>';

/** 缩写：chip 上只显示这么多字符（hover 的气泡里给全文） */
const CHIP_CHARS = 14;

function abbrev(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > CHIP_CHARS ? oneLine.slice(0, CHIP_CHARS) + "…" : oneLine;
}

function buildChip(id: string, text: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = CHIP_CLASS;
  chip.contentEditable = "false";          // 原子元素：光标进不去，退格一次删整条
  chip.dataset.refId = id;
  chip.setAttribute("role", "img");
  chip.setAttribute("aria-label", `引用：${abbrev(text)}`);
  chip.innerHTML = QUOTE_SVG;              // 常量，不含任何用户内容
  const label = document.createElement("span");
  label.className = "max-w-[12rem] truncate";
  label.textContent = abbrev(text);
  chip.appendChild(label);
  return chip;
}

/**
 * 把编辑器里的 DOM 读回纯文本。
 *   text 节点  → 原样
 *   chip       → 被引用文字的**完整原文**（表在 refTexts 里）
 *   <br>       → "\n"
 *   块元素      → 换行（**关键**：浏览器按 Enter / 插 "\n" 时，往往会新起一个
 *                <div> 而不是插 <br>（Chromium 的默认行为，实测：
 *                "第一行" + Enter + "第二行" 的 DOM 是 `第一行<div>第二行</div>`）。
 *                只认 <br> 的话换行会被吃掉 —— 行尾那个由最后一行统一清掉。
 */
function serialize(root: HTMLElement, refTexts: Map<string, string>): string {
  let out = "";
  const isBlock = (el: HTMLElement) => el.tagName === "DIV" || el.tagName === "P";
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { out += child.textContent ?? ""; return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as HTMLElement;
      const refId = el.dataset?.refId;
      if (refId) { out += refTexts.get(refId) ?? ""; return; }
      if (el.tagName === "BR") { out += "\n"; return; }
      if (isBlock(el) && out && !out.endsWith("\n")) out += "\n";   // 块前：补一个换行
      walk(el);
      if (isBlock(el) && out && !out.endsWith("\n")) out += "\n";   // 块后：行尾的这份由下面清掉
    });
  };
  walk(root);
  // 行尾那个 <br> / 末块的行尾是光标占位、不是换行；零宽字符是历史残留，都清掉
  return out.replace(/\u200B/g, "").replace(/\n+$/, "");
}

export function ComposerInput({
  value, onChange, onKeyDown, onPasteFiles,
  placeholder, className, autoFocus, disabled, maxHeight = 220, ref,
}: ComposerInputProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  /** chip id → 被引用文字的完整原文（序列化时用它把 chip 展开） */
  const refTexts = useRef(new Map<string, string>());
  const seq = useRef(0);
  /** 光标最后一次停在编辑器里的位置 —— 用户点到消息列表里再回来时靠它 */
  const savedRange = useRef<Range | null>(null);
  const [isEmpty, setIsEmpty] = useState(value.length === 0);
  const [bubble, setBubble] = useState<{ text: string; left: number; top: number } | null>(null);
  const hoveredRef = useRef<{ id: string; left: number; top: number } | null>(null);

  // 回调放 ref：内部处理器只会挂在挂载时那一次上，读 current 才不会拿到旧闭包
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onKeyDownRef = useRef(onKeyDown); onKeyDownRef.current = onKeyDown;
  const onPasteFilesRef = useRef(onPasteFiles); onPasteFilesRef.current = onPasteFiles;

  // ── 高度：每轮先把 height 归零再按 scrollHeight 设回去（归零是为了删字也能缩回来）
  const grow = () => {
    const el = elRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, maxHeight) + "px";
  };
  useLayoutEffect(() => { grow(); }, [value]);

  // ── 外部值 → DOM（只在真的不一致时写；一致的写回会打断输入法/光标）
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (value === serialize(el, refTexts.current)) return;
    // 外部整块换掉了内容（斜杠命令替换 / 发送后清空 / 起始页重新挂载）：
    // 旧的 chip 原文表一起清，避免残留 id
    refTexts.current.clear();
    el.textContent = value;
    setIsEmpty(value.length === 0);
  }, [value]);

  useEffect(() => {
    if (!autoFocus) return;
    elRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      if (el.contains(r.commonAncestorContainer)) savedRange.current = r.cloneRange();
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, []);

  const emit = () => {
    const el = elRef.current;
    if (!el) return;
    const text = serialize(el, refTexts.current);
    setIsEmpty(text.length === 0);      // 占位符：DOM 空不空由序列化结果说了算
    setBubble(null);                    // 内容变了，之前 hover 的那条可能已经不在了
    hoveredRef.current = null;
    onChangeRef.current(text);
  };

  const applyRange = (r: Range) => {
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(r);
    savedRange.current = r.cloneRange();
  };

  /** 当前该往哪儿插：优先编辑器里的实时选区，其次上次记住的光标 */
  const caretRange = (el: HTMLElement): Range | null => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (el.contains(r.commonAncestorContainer)) return r;
    }
    const saved = savedRange.current;
    if (saved && el.contains(saved.commonAncestorContainer)) return saved.cloneRange();
    return null;
  };

  /** 光标放到某个节点之后 */
  const collapseAfter = (node: Node) => {
    const r = document.createRange();
    r.setStart(node, node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").length : node.childNodes.length);
    r.collapse(true);
    applyRange(r);
  };

  /**
   * 插入一段纯文本（粘贴、Shift+Enter 的换行都走它）。
   *
   * 优先 `document.execCommand("insertText")`：它**已废弃**，但到今天仍是唯一
   * 既能触发 input 事件、又能保住浏览器撤销栈（Cmd+Z）的插入方式；手动 Range
   * 插入 DOM 会把撤销栈断掉（撤销一步直接跳回上次的原点）。拿不到就退回手动插入 ——
   * 内容正确性优先，撤销栈的连续性次之。
   */
  const insertPlainText = (text: string) => {
    const el = elRef.current;
    if (!el || !text) return;
    el.focus();
    const live = caretRange(el);
    if (live) applyRange(live);
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch { ok = false; }
    if (!ok) {
      const r = caretRange(el);
      if (r) {
        const node = document.createTextNode(text);
        r.deleteContents();
        r.insertNode(node);
        collapseAfter(node);
      } else {
        el.appendChild(document.createTextNode(text));
      }
    }
    emit();
    grow();
  };

  /**
   * 「添加到评论」：把选中的原文作为一个 chip 插到**光标处**。
   *
   * 注意取值顺序：先算好插入点、再 focus()。反过来的话，focus 会把浏览器的
   * 选区重置到编辑器里（各引擎落点还不一样，多半是开头），插入位置就错了。
   */
  const insertReference = (text: string) => {
    const el = elRef.current;
    if (!el) return;
    const clean = text.replace(/\r\n/g, "\n");
    if (!clean.trim()) return;

    const id = `ref-${++seq.current}`;
    refTexts.current.set(id, clean);
    const chip = buildChip(id, clean);
    // 后面垫一个空格：光标落在 chip 右边、打字不会贴进 chip 里
    const space = document.createTextNode(" ");

    const range = caretRange(el);      // 见上面的注释：focus 之前取
    el.focus();
    if (range) {
      range.deleteContents();          // 选中了别的文字就先替换掉（和普通输入一致）
      // ⚠️ 必须**一次插进去一个片段**：分两次 insertNode 的话，第二次落在哪儿取决于
      //    引擎把 range 留在插入点之前还是之后（新旧 DOM 规范不一样，Chromium 实测
      //    是"之前"）—— 空格和 chip 的先后会翻过来，表现就是退格先删空格。片段一次插
      //    就没有这个歧义：顺序永远是我们排好的 [chip][空格]。
      const frag = document.createDocumentFragment();
      frag.appendChild(chip);
      frag.appendChild(space);
      range.insertNode(frag);
    } else {
      el.appendChild(chip);            // 从没在输入框里落过光标：接到末尾
      el.appendChild(space);
    }
    collapseAfter(space);
    emit();
    grow();
  };

  /**
   * 退格删掉光标左边那条引用 —— **整条删**，不留孤儿文字、也不留半个标记。
   * contenteditable=false 的元素浏览器本来就会整块删，这里再显式兜一道
   * （光标贴在 chip 右边缘时最容易出意外）。
   *
   * 两种情况都认：
   *   ① 光标紧贴 chip 右边
   *   ② 光标在「chip + 垫的空格」的空格后面 —— 那空格是插入 chip 时垫的，
   *      算这条引用的一部分，一起收回（否则第一次退格看着像没反应）
   */
  const removeChipBeforeCaret = (): boolean => {
    const sel = window.getSelection();
    const el = elRef.current;
    if (!el || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    let chip: HTMLElement | null = null;
    let trail: Text | null = null;      // 要跟着一起删的垫空格
    if (r.startContainer.nodeType === Node.TEXT_NODE) {
      const t = r.startContainer as Text;
      if (r.startOffset === 0) return false;                 // 交给浏览器
      const probe = document.createRange();
      probe.setStart(t, r.startOffset - 1);
      probe.setEnd(t, r.startOffset);
      chip = (probe.startContainer.parentElement?.closest("[data-ref-id]") as HTMLElement | null) ?? null;
      if (!chip && r.startOffset === 1 && t.data.startsWith(" ")) {
        const prev = t.previousSibling;
        const cand = prev instanceof HTMLElement ? (prev.closest("[data-ref-id]") as HTMLElement | null) : null;
        if (cand) { chip = cand; trail = t; }
      }
    } else if (r.startContainer.nodeType === Node.ELEMENT_NODE) {
      const before = r.startOffset > 0 ? r.startContainer.childNodes[r.startOffset - 1] : null;
      chip = before instanceof HTMLElement ? (before.closest("[data-ref-id]") as HTMLElement | null) : null;
      // chip 后面垫着空格时，光标也会停在「空格之后」，那时上一步拿到的是空格
      if (!chip && before instanceof Text && before.data === " ") {
        const prev2 = before.previousSibling;
        const cand = prev2 instanceof HTMLElement ? (prev2.closest("[data-ref-id]") as HTMLElement | null) : null;
        if (cand) { chip = cand; trail = before; }
      }
    }
    if (!chip || !el.contains(chip)) return false;
    const del = document.createRange();
    del.setStartBefore(chip);
    if (trail) del.setEnd(trail, 1); else del.setEndAfter(chip);
    del.deleteContents();               // 删完 range 自己塌在删除点上
    del.collapse(true);
    applyRange(del);
    emit();
    grow();
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // 输入法拼字中：Backspace 是删候选/拼字，不能当"删引用"处理；
    // Enter 是"确认候选词"，也不该被当成发送/换行（原来那个 textarea 也没挡，顺手补上）
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Backspace" && removeChipBeforeCaret()) {
      e.preventDefault();
      return;
    }
    // Shift+Enter = 换行。contenteditable 的默认行为会插一个 <div>/<br>（各家不一样），
    // 这里统一插一个 "\n" 文本 —— 和 whitespace-pre-wrap 对上，序列化就不用翻译块元素。
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      insertPlainText("\n");
      return;
    }
    onKeyDownRef.current?.(e);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      // 剪贴板里是文件（截图直接 Cmd+V、访达里拷的文件）→ 走上传通道，
      // 不往正文里粘一串路径/二进制垃圾
      e.preventDefault();
      onPasteFilesRef.current?.(files);
      return;
    }
    e.preventDefault();                     // 只收纯文本：HTML/样式一律不进正文
    insertPlainText(e.clipboardData?.getData("text/plain") ?? "");
  };

  const handleMouseOver = (e: React.MouseEvent<HTMLDivElement>) => {
    const chip = (e.target as HTMLElement).closest?.("[data-ref-id]") as HTMLElement | null;
    if (!chip) {
      if (hoveredRef.current) { hoveredRef.current = null; setBubble(null); }
      return;
    }
    const id = chip.dataset.refId ?? "";
    const r = chip.getBoundingClientRect();
    if (hoveredRef.current && hoveredRef.current.id === id
      && hoveredRef.current.left === r.left && hoveredRef.current.top === r.top) return;   // 同一个 chip：别每动一下就重渲染
    hoveredRef.current = { id, left: r.left, top: r.top };
    setBubble({
      text: refTexts.current.get(id) ?? "",
      left: Math.max(8, Math.min(r.left, window.innerWidth - 460)),
      top: r.top - 6,
    });
  };

  const handleMouseLeave = () => {
    if (!hoveredRef.current) return;
    hoveredRef.current = null;
    setBubble(null);
  };

  useImperativeHandle(ref, () => ({
    insertReference,
    focus: () => elRef.current?.focus(),
  }), []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={elRef}
        data-composer-input=""
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        onInput={emit}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onMouseOver={handleMouseOver}
        onMouseLeave={handleMouseLeave}
        className={cn(
          // 无边框（内边距归卡片）；默认两行高，内容多了往上长，到 max-height 内部滚动。
          // whitespace-pre-wrap 是关键：DOM 里的 "\n" 直接就是换行，序列化/反序列化
          // 不用在 <br> 和块元素之间来回翻译（粘贴进来的多行文本也照此上屏）。
          "min-h-[52px] max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words px-0 py-2 text-sm text-text-primary outline-none",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
      />
      {/* 占位符单放一层：放进去会变成正文（也就成了可删的"内容"） */}
      {isEmpty && placeholder && (
        <div className="pointer-events-none absolute left-0 top-2 select-none text-sm text-text-tertiary">
          {placeholder}
        </div>
      )}
      {/* hover 气泡：原文全文（chip 上只显示缩写）。fixed + translateY(-100%) 让它浮在 chip 上方 */}
      {bubble && (
        <div
          className="pointer-events-none fixed z-[300] max-h-[240px] max-w-[440px] -translate-y-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-surface-overlay px-2 py-1 text-2xs text-text-primary shadow-md"
          style={{ left: bubble.left, top: bubble.top }}
        >
          {bubble.text}
        </div>
      )}
    </div>
  );
}
