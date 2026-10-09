/**
 * SSE 工具：帧带 id: <seq>（断点续传）+ 心跳
 */
import type { ServerResponse } from "node:http";

export interface SseClient {
  id: string;
  threadId?: string;
  res: ServerResponse;
  lastSentSeq: number;
}

export class SseHub {
  #clients = new Map<string, SseClient>();
  #heartbeat: ReturnType<typeof setInterval>;

  constructor() {
    this.#heartbeat = setInterval(() => {
      for (const c of this.#clients.values()) {
        try { c.res.write(": ping\n\n"); } catch { /* ignore */ }
      }
    }, 15_000);
  }

  add(threadId: string | undefined, res: ServerResponse): SseClient {
    const id = Math.random().toString(36).slice(2);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const client: SseClient = { id, threadId, res, lastSentSeq: 0 };
    this.#clients.set(id, client);
    res.on("close", () => { this.#clients.delete(id); });
    return client;
  }

  send(client: SseClient, event: Record<string, unknown>, seq?: number): void {
    const payload = JSON.stringify(event);
    let frame = "";
    if (seq !== undefined) { frame += `id: ${seq}\n`; client.lastSentSeq = seq; }
    frame += `data: ${payload}\n\n`;
    try { client.res.write(frame); } catch { /* ignore */ }
  }

  /** 广播到某线程的所有订阅者 */
  broadcast(threadId: string, event: Record<string, unknown>, seq?: number): void {
    for (const c of this.#clients.values()) {
      if (c.threadId === threadId) this.send(c, event, seq);
    }
  }

  get size(): number { return this.#clients.size; }
  /** 所有订阅者（cron / heartbeat 这类「不属于某个线程」的事件要广播给全部） */
  allClients(): SseClient[] { return [...this.#clients.values()]; }
  close(): void { clearInterval(this.#heartbeat); for (const c of this.#clients.values()) { try { c.res.end(); } catch { /* ignore */ } } }
}
