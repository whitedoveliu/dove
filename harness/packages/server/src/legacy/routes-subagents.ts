/**
 * 子代理路由（A3）
 *
 * 子代理被存成 `kind='subagent'` 的线程（见 agents/subagent-store.ts），
 * 所以这里只做两件事：**列出来** + **把它的过程按主对话的同一形状吐出去**。
 *
 * 过程复用 partsToEvents —— 和主对话的历史回放**完全同一条路径**，
 * 前端不用为子代理再写一套渲染。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../bootstrap.ts";
import { json, portToProject } from "./server.ts";
import { partsToEvents } from "./routes-project-parts.ts";

/** 三键查找：端口 → 项目 id → 目录名。顺序和删除路由**完全一致**，免得两个接口对同一个 key 给出不同结果 */
function findProject(svc: Services, key: string) {
  let proj = portToProject(svc, Number(key));
  if (!proj) {
    const hit = svc.projects.get(key)
      ?? svc.projects.list().find((p) => p.path.split("/").filter(Boolean).pop() === key);
    if (hit) proj = { id: hit.id, name: hit.name, path: hit.path, port: hit.port };
  }
  return proj ?? null;
}

export async function handleSubagentRoutes(
  path: string, _url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  // ── GET /api/projects/{port}/subagents ──────────────
  const listMatch = /^\/api\/projects\/([^/]+)\/subagents$/.exec(path);
  if (listMatch && req.method === "GET") {
    const proj = findProject(svc, decodeURIComponent(listMatch[1]!));
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }

    // 项目的工作线程 —— 子代理挂在它下面
    const parent = svc.store.listThreads("project").filter((t) => t.projectId === proj.id);
    const parentIds = new Set(parent.map((t) => t.id));

    const subs = svc.store.listThreads("subagent")
      .filter((t) => t.projectId === proj.id || parentIds.has(String(t.metadata?.parentThreadId ?? "")))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => ({
        id: t.id,
        label: String(t.metadata?.label ?? t.title ?? t.id),
        status: String(t.metadata?.status ?? "done"),
        background: t.metadata?.background === true,
        taskId: (t.metadata?.taskId as string | null) ?? null,
        parentId: String(t.metadata?.parentThreadId ?? ""),
        startedAt: t.createdAt,
        finishedAt: (t.metadata?.finishedAt as number | undefined) ?? null,
        parts: Number(t.metadata?.parts ?? 0),
      }));

    json(res, 200, { success: true, subagents: subs });
    return true;
  }

  // ── GET /api/threads/{threadId}/messages ────────────
  const msgMatch = /^\/api\/threads\/([^/]+)\/messages$/.exec(path);
  if (msgMatch && req.method === "GET") {
    const id = decodeURIComponent(msgMatch[1]!);
    const th = svc.store.getThread(id);
    if (!th) { json(res, 404, { success: false, message: "线程不存在（" + id + "）" }); return true; }

    // 和主对话同一个转换：parts → 前端认识的事件序列
    const messages = svc.store.listMessages(id).map((m) => ({
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      events: partsToEvents(m),
    }));

    json(res, 200, {
      success: true,
      threadId: id,
      kind: th.kind,
      title: th.title,
      metadata: th.metadata,
      messages,
    });
    return true;
  }

  return false;
}
