/**
 * SSE 解析（照 control-panel/src/lib/api.ts 的字段解析：只认 `data:` 行）
 *
 * 为什么忽略 `id:` 行：内核的帧带 `id: <seq>` 是为了让**浏览器**用 Last-Event-ID 断线续传，
 * CLI 是一次性前台进程，断了就是断了，没有续传的必要。
 * 注释帧（`: ping`）是心跳，同样只用来判断连接还活着。
 */

export interface SseEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * 把一个 SSE 响应体读成事件流。
 *
 * 关键在 finally 里的 `reader.cancel()`：不主动取消的话，这条 keep-alive 连接会一直被
 * undici 的连接池持着，`dove run` 做完事之后进程退不掉
 * （历史同款 bug 见 scripts/smoke-cli-exit.mjs：任务 13s 做完、进程挂了 4000s）。
 */
export async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";        // 最后一行可能是半截，留到下一块
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const ev = JSON.parse(payload) as SseEvent;
          if (ev && typeof ev.type === "string") yield ev;
        } catch { /* 半截 JSON：丢掉，下一帧还会来 */ }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已经断了就算了 */ }
  }
}
