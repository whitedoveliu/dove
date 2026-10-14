/**
 * 「重新挂上正在跑的回合」—— `GET /api/stream?threadId=<id>&after=<seq>`（SSE）。
 *
 * 没有这条：SSE 只活在 `POST /api/chat` 那次连接上，面板一切走（换任务、标签页切到后台再回来）
 * 那轮推理就再也看不到了 —— 消息历史要等回合结束才落库，中间那段 thinking/delta 没有地方补看。
 * 用户报的就是这个：「切到其他的页面，返回来就 bug 了」。
 *
 * 三条契约（面板侧按这个接，见 control-panel 的 streamFrom）：
 *   ① 先发一帧 `{type:"attach", threadId, running, lastSeq}` —— running 说明这轮还在不在跑；
 *      **它故意不带 seq**：attach 不是那一轮的帧，带 seq 会把客户端「已看到哪」的指针往前跳，
 *      把下面的重放整个跳过去（踩过）。
 *   ② 再补 `after < seq` 的最近一回合的帧（`hub.replay`）—— 客户端给 after=0 = 全要。
 *   ③ 之后跟着 hub 的**广播**走：`/api/chat` 的 sink 已经改成 broadcast（不再只发给那次 POST 的
 *      客户端），所以晚挂上来的连接能看到后续增量。
 *
 * 判据与边界（为什么只留最近一回合、只在内存）：见 `sse.ts` 里 ReplayFrame 的注释。
 * 拆成单独文件：`routes.ts` 有 400 行硬上限，而且「重放 + 广播」自成一块语义。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SseHub } from "./sse.ts";

export function handleStreamRoutes(
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  hub: SseHub,
  running: Map<string, AbortController>,
  json: (res: ServerResponse, code: number, data: unknown) => void,
): boolean {
  if (path !== "/api/stream" || req.method !== "GET") return false;
  const threadId = String(url.searchParams.get("threadId") ?? "");
  if (!threadId) {
    json(res, 400, { error: "缺少 threadId" });
    return true;
  }
  const afterRaw = Number(url.searchParams.get("after") ?? 0);
  const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0;
  const client = hub.add(threadId, res);
  hub.send(client, {
    type: "attach",
    threadId,
    running: running.has(threadId),
    lastSeq: hub.lastSeqOf(threadId),
  });
  for (const frame of hub.replay(threadId, after)) hub.send(client, frame.event, frame.seq);
  return true;
}