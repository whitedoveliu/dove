/**
 * parts → provider 历史消息（从 runtime.ts 拆出来）
 *
 * 这是一块独立且容易出错的逻辑，单独放一个文件有两个好处：
 * ① runtime.ts 守住 400 行上限；② 配对规则可以单独测。
 *
 * 铁律：**每个 tool_call 都必须有配对的 tool 消息**，否则 provider 直接拒绝请求。
 *       所以除 output-available 之外的状态一律补一条 error 结果。
 */
import type { ChatMessage } from "../providers/types.ts";
import type { Message, ToolPart } from "../session/types.ts";
import { isToolPart } from "../session/types.ts";
import { hydrateImages } from "../context/images.ts";

/** parts → provider 历史消息 */
export function toWireHistory(
  messages: Message[], repairNotice: string, threadId: string, supportsImages = true,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let first = true;
  for (const m of messages) {
    if (m.threadId !== threadId) continue;
    const text = m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    const toolParts = m.parts.filter((p): p is ToolPart => isToolPart(p));
    const imageRefs = m.parts.filter((p) => p.type === "image" || p.type === "file")
      .map((p) => String((p as { url?: string }).url ?? "")).filter(Boolean);
    if (m.role === "user") {
      const body = first && repairNotice ? repairNotice + "\n\n" + text : text;
      if (imageRefs.length > 0) {
        // 有图：组装成 content block（图片按需读成 data URL，引用本身留在库里）
        const h = hydrateImages(imageRefs, { supportsImages });
        const combined = [body, ...h.notes].filter(Boolean).join("\n");
        out.push({ role: "user", content: [{ type: "text", text: combined }, ...h.blocks] });
      } else {
        out.push({ role: "user", content: body });
      }
      first = false;
    } else if (m.role === "assistant") {
      const calls = toolParts.filter((p) => p.input !== undefined)
        .map((p) => ({ id: p.toolCallId, type: "function" as const, function: { name: p.toolName, arguments: JSON.stringify(p.input) } }));
      if (text || calls.length > 0) out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      // 每个 tool_call 都**必须**有配对的 tool 消息，否则 provider 会拒绝请求。
      // 所以除 output-available 之外的状态一律补一条 error 结果。
      for (const p of toolParts) {
        out.push({
          role: "tool", tool_call_id: p.toolCallId, name: p.toolName,
          content: p.state === "output-available"
            ? JSON.stringify(p.output ?? {})
            : JSON.stringify({ error: p.errorText ?? (p.state === "permission-denied" ? "用户拒绝了这次操作" : "该动作未完成，结果未知") }),
        });
      }
    }
  }
  return out;
}

