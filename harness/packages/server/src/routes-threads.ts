/**
 * 线程与消息路由（拆出来是因为 routes.ts 顶到 400 行上限）
 * 含 T8.2 的只读权威开关。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Services } from "./bootstrap.ts";
import { clearTurnFilesForThread } from "./legacy/turn-files-store.ts";

type Body = () => Promise<Record<string, unknown>>;
type Json = (res: ServerResponse, code: number, data: unknown) => void;

/** 返回 true 表示这个请求已被处理 */
export async function handleThreadRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse,
  svc: Services, json: Json, readBody: Body,
): Promise<boolean> {
  // ── 线程 ─────────────────────────────────────────
  if (path === "/api/threads" && req.method === "GET") {
    svc.store.getOrCreateHomeThread();
    json(res, 200, svc.store.listThreads());
    return true;
  }
  if (path === "/api/threads" && req.method === "POST") {
    const b = await readBody(req);
    const kind = (b.kind as string) === "home" ? "home" : "project";
    const th = kind === "home"
      ? svc.store.getOrCreateHomeThread()
      : svc.store.createThread({ id: `th_${randomUUID().slice(0, 8)}`, kind: "project", projectId: (b.projectId as string) ?? null, title: (b.title as string) ?? "新对话" });
    json(res, 200, th);
    return true;
  }
  const msgMatch = /^\/api\/threads\/([^/]+)\/messages$/.exec(path);
  if (msgMatch && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 200);
    json(res, 200, svc.store.listMessages(decodeURIComponent(msgMatch[1]!), limit));
    return true;
  }
  const thMatch = /^\/api\/threads\/([^/]+)$/.exec(path);
  if (thMatch && req.method === "DELETE") {
    const id = decodeURIComponent(thMatch[1]!);
    svc.store.deleteThread(id);
    // 每轮文件改动（legacy_turn_files）也跟着线程走：core 的 deleteThread 不知道这张表
    // （它在 legacy 层），漏了这一处就留下永远读不到的孤儿行 —— 这与项目删除 / 重置那两处同规矩。
    clearTurnFilesForThread(svc, id);
    json(res, 200, { ok: true });
    return true;
  }
  if (thMatch && req.method === "PATCH") {
    const b = await readBody(req);
    svc.store.updateThread(decodeURIComponent(thMatch[1]!), b as never);
    json(res, 200, { ok: true });
    return true;
  }

  // ── 撤销（append-only）──────────────────────────────
  // 语义：把最后 n「轮真实用户消息」及其之后标记为已撤销，`recentMessages` 不再返回它们。
  // **磁盘上什么都不删、什么都不改写** —— 日志里只追加一条 context.undo。
  // 撤销不了（轮数不够 / 没有真实用户消息）时不动作，并**说清差多少**，而不是静默成功。
  const undoMatch = /^\/api\/threads\/([^/]+)\/undo$/.exec(path);
  if (undoMatch && req.method === "POST") {
    const id = decodeURIComponent(undoMatch[1]!);
    if (!svc.store.getThread(id)) { json(res, 404, { error: "线程不存在" }); return true; }
    const b = await readBody(req);
    const asked = Number(b.turns);
    const n = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 1;
    const r = svc.store.undoTurns(id, n);
    json(res, r.undone > 0 ? 200 : 409, r);
    return true;
  }

  // 只读权威（T8.2）：用户显式要求「只看不改」时用这个开关做硬约束
  const roMatch = /^\/api\/threads\/([^/]+)\/readonly$/.exec(path);
  if (roMatch && req.method === "POST") {
    const id = decodeURIComponent(roMatch[1]!);
    const b = await readBody(req);
    const th = svc.store.getThread(id);
    if (!th) { json(res, 404, { error: "线程不存在" }); return true; }
    const readOnly = b.enabled !== false;
    svc.store.updateThread(id, { metadata: { ...th.metadata, readOnly } });
    json(res, 200, { ok: true, readOnly });
    return true;
  }
  return false;
}
