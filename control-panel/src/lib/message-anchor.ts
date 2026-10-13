/**
 * 消息锚点 —— 「最右侧提示词刻度栏」（prompt-rail）与「点横线跳回那条消息」
 * （ChatPanel.jumpToMessage）共用同一套查找。
 *
 * 为什么不用 `querySelector('[data-message-id="…"]')`：id 是内核给的字符串，
 * 只要含引号 / 反斜杠就拼出非法选择器，`querySelector` 会**抛** DOMException ——
 * 而它跑在点击回调里，没有 error boundary 接得住，整条交互就断了。
 * 以前两处各写一份：rail 抽了 escapeAttr、ChatPanel 没抽，同一个坑只填了一半。
 * 这里改成按属性扫描 + `dataset` 精确比较，**彻底不吃转义**（顺带保证口径只有一份）。
 */
export const MESSAGE_ATTR = "data-message-id";

/** 在 `root` 里按 id 找消息元素；找不到返回 null（调用方负责给反馈） */
export function findMessageElement(
  root: ParentNode | null | undefined,
  id: string,
): HTMLElement | null {
  if (!root || !id) return null;
  const nodes = root.querySelectorAll<HTMLElement>(`[${MESSAGE_ATTR}]`);
  for (const node of nodes) {
    if (node.dataset.messageId === id) return node;
  }
  return null;
}
