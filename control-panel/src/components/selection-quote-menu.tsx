import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { MessageSquareQuote } from "lucide-react";

/**
 * 消息里的文字 → 右键「添加到评论」。
 *
 * 用途：读到 AI 的某段回答，想针对它说点什么。选中 → 右键 → 添加到评论 →
 * 那段原文作为一个「引用 chip」插进输入框（显示成缩写，hover 出全文，
 * 发出去的消息里是**完整原文**）。
 *
 * 三条纪律：
 *   · **只在自己这一块**抑制系统右键菜单（没选中文字时不拦 —— 用户想用
 *     系统菜单复制/检查元素的时候就该给系统菜单）。
 *   · 选区必须落在容器里：别的地方选中文字右键，与这里无关。
 *   · 菜单用 fixed 定位 + 视口夹取，贴边右键也不会被切掉。
 */
export function useSelectionQuoteMenu(onAdd?: (text: string) => void) {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const onContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    if (!onAdd) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || !sel || sel.rangeCount === 0) return;      // 没选中：交回系统菜单
    const node = sel.anchorNode;
    if (!node || !e.currentTarget.contains(node)) return;   // 选区不在这里：同样不管
    e.preventDefault();
    setMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 190)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 52)),
      text,
    });
  };

  // 点别处 / 滚 / Esc / 失焦都关掉。mousedown 落在菜单自己身上时不关 ——
  // 否则还没等到 click，菜单就先没了。
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const menuNode = menu ? (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[400] min-w-[172px] rounded-[10px] border border-border-strong bg-surface-overlay p-1 shadow-[0_12px_32px_rgba(18,20,26,0.18)]"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        type="button"
        role="menuitem"
        // 按下时不让默认行为发生：一按选区就没了（菜单项自己不吃这次 mousedown 就够了）
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          onAdd?.(menu.text);
          setMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-text-primary transition-colors duration-fast hover:bg-surface-hover"
      >
        <MessageSquareQuote className="size-3.5 shrink-0 text-text-tertiary" />
        添加到评论
      </button>
    </div>
  ) : null;

  return { onContextMenu, menuNode };
}
