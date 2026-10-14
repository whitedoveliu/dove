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

/**
 * 一个线程最近一回合的帧缓冲，用来回答「我刚才切走了，回来还能看到那段推理吗」。
 *
 * 为什么要它：`/api/chat` 的 SSE 是**绑在这次 POST 连接上**的 —— 面板切到别的任务、
 * 或把标签页切到后台再回来，那段连接就没了，**推理过程没有任何地方可以补看**
 * （历史只在回合结束才落库）。这里把最近一回合的帧留一份，配合 `GET /api/stream`
 * 让晚到的客户端也能拿到「跑到哪了」。
 *
 * 边界（故意的）：只留最近一回合、上限 4000 帧、**只在内存**。判据是：
 *  - 只留最近一回合：更早的回合已经落进消息历史，面板读历史就有，重复发只会打架；
 *  - 只在内存：内核重启后那轮本来就已经中断（没有 running 可挂），历史才是事实来源。
 */
const REPLAY_MAX_FRAMES = 4_000;

interface ReplayFrame {
  seq: number;
  event: Record<string, unknown>;
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

  // ── 最近一回合的帧缓冲（见文件里 ReplayFrame 的注释）─────────────
  #replay = new Map<string, ReplayFrame[]>();
  /**
   * 每线程的**帧序号**（1 起，`beginTurn` 归零）。
   *
   * 为什么不用 `eventLog.seq` 当帧 id（这里真栽过）：那个序号只在**写日志**时前进，
   * 一轮里连着发好几帧 thinking/delta 时它不动 —— 多帧共享同一个 id，客户端「已看到哪」
   * 的指针和重放的 `seq > after` 过滤当场失效（冒烟 smoke-stream 抓到的）。
   * 帧 id 就该由**流自己**分配：每线程单调、每轮从 1 开始，够用且不会和日志的语义打架。
   */
  #frameSeq = new Map<string, number>();

  /** 记一帧并分配帧序号（返回它，调用方拿同一个去广播） */
  remember(threadId: string, event: Record<string, unknown>): number {
    const seq = (this.#frameSeq.get(threadId) ?? 0) + 1;
    this.#frameSeq.set(threadId, seq);
    const frames = this.#replay.get(threadId) ?? [];
    frames.push({ seq, event });
    if (frames.length > REPLAY_MAX_FRAMES) frames.splice(0, frames.length - REPLAY_MAX_FRAMES);
    this.#replay.set(threadId, frames);
    return seq;
  }

  /** 开新一回合：丢掉上一回合的帧、帧序号归零（历史已经有它了，重放只会和面板打架） */
  beginTurn(threadId: string): void {
    this.#replay.delete(threadId);
    this.#frameSeq.set(threadId, 0);
  }

  /**
   * 晚到的订阅者要补的帧：`seq > after` 的那些。
   * `after` 是客户端已经处理过的最后一个 seq（首次挂上给 0 = 全要）。
   */
  replay(threadId: string, after: number): ReplayFrame[] {
    return (this.#replay.get(threadId) ?? []).filter((frame) => frame.seq > after);
  }

  /** 该线程最近一回合的最后一帧 seq（没有就给 0）——「你是不是已经跑完了」的判据之一 */
  lastSeqOf(threadId: string): number {
    const frames = this.#replay.get(threadId);
    return frames === undefined || frames.length === 0 ? 0 : frames[frames.length - 1]!.seq;
  }

  close(): void { clearInterval(this.#heartbeat); for (const c of this.#clients.values()) { try { c.res.end(); } catch { /* ignore */ } } }
}
