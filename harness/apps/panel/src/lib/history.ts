/** 历史消息（内核 parts 模型）→ 渲染模型 */
import type { Part, RawMessage, TextPart, ToolPart, UIMessage, UIPart } from "../types.ts";

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: string }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

function partFromRaw(p: Part, index: number): UIPart | null {
  const id = p.id ?? "h" + index;
  if (p.type === "text" || p.type === "reasoning") {
    return { kind: p.type, id, text: (p as TextPart).text ?? "", done: true };
  }
  if (p.type.startsWith("tool-")) {
    const t = p as ToolPart;
    return {
      kind: "tool",
      id,
      toolCallId: t.toolCallId ?? id,
      name: t.toolName ?? p.type.slice(5),
      input: t.input,
      output: t.output,
      errorText: t.errorText,
      spillPath: t.spillPath,
      state: t.state ?? "output-available",
      startedAt: t.startedAt ?? 0,
      finishedAt: t.finishedAt,
    };
  }
  if (p.type === "file" || p.type === "image") {
    const f = p as { url?: string; filename?: string };
    return { kind: "text", id, text: "[附件] " + (f.filename ?? f.url ?? ""), done: true };
  }
  return null;
}

export function fromRawMessages(raw: RawMessage[]): UIMessage[] {
  return raw.map((m, i) => {
    const role = m.role === "user" || m.role === "system" ? m.role : "assistant";
    let parts: UIPart[] = [];
    if (Array.isArray(m.parts) && m.parts.length) {
      parts = m.parts.map(partFromRaw).filter((p): p is UIPart => p !== null);
    } else {
      const text = typeof m.content === "string" ? m.content : (m.text ?? contentToText(m.content));
      if (text) parts = [{ kind: "text", id: "h" + i, text, done: true }];
    }
    return { id: m.id ?? "h-" + i, role, parts, createdAt: m.createdAt ?? 0, usage: m.usage };
  });
}
