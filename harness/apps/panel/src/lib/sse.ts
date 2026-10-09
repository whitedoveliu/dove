/** SSE：POST /api/chat，逐事件回调（fetch + ReadableStream，按空行切块） */
import { API_BASE } from "./api.ts";
import type { SSEEvent } from "../types.ts";

export interface ChatRequest {
  threadId: string;
  message: string;
  projectId?: string | null;
}

export interface StreamOptions {
  signal?: AbortSignal;
  onEvent: (ev: SSEEvent) => void;
}

/** 解析单个事件块：支持多行 data:、注释、CRLF；id:/event:/retry: 面板不需要 */
export function parseEventBlock(block: string): SSEEvent | null {
  let data = "";
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data += (data ? "\n" : "") + value;
  }
  if (!data.trim()) return null;
  try {
    const parsed = JSON.parse(data) as SSEEvent | string | number;
    if (typeof parsed === "string") return { type: "text", content: parsed };
    if (!parsed || typeof parsed !== "object") return null;
    return { ...parsed, type: parsed.type ?? "unknown" };
  } catch {
    // 非 JSON 负载按纯文本增量处理
    return { type: "text", content: data };
  }
}

function findSeparator(buf: string): { index: number; length: number } | null {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1 && b === -1) return null;
  if (b !== -1 && (a === -1 || b < a)) return { index: b, length: 4 };
  return { index: a, length: 2 };
}

/** 发起对话；内核若返回一次性 JSON 也会折算成等价事件 */
export async function streamChat(req: ChatRequest, opts: StreamOptions): Promise<void> {
  const res = await fetch(API_BASE + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      threadId: req.threadId,
      message: req.message,
      content: req.message,
      projectId: req.projectId ?? undefined,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("对话请求失败 HTTP " + res.status + " " + detail.slice(0, 200));
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (!res.body || ctype.includes("application/json")) {
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const text =
      typeof data?.content === "string" ? data.content : typeof data?.text === "string" ? data.text : "";
    if (text) opts.onEvent({ type: "text", content: text });
    opts.onEvent({ type: "done" });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let cut = findSeparator(buffer); cut; cut = findSeparator(buffer)) {
      const block = buffer.slice(0, cut.index);
      buffer = buffer.slice(cut.index + cut.length);
      const ev = parseEventBlock(block);
      if (ev) opts.onEvent(ev);
    }
  }
  buffer += decoder.decode();
  const tail = parseEventBlock(buffer);
  if (tail) opts.onEvent(tail);
}
