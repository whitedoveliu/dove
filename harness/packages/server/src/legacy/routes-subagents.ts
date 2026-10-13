/**
 * 子代理路由（A3）
 *
 * 子代理被存成 `kind='subagent'` 的线程（见 agents/subagent-store.ts），
 * 所以这里只做两件事：**列出来** + **把它的过程按主对话的同一形状吐出去**。
 *
 * 第三件小事：列表里**顺带带出 token 用量**（按 metadata.taskId 反查 TaskRegistry）。
 * 面板的「这个子代理烧了多少 token」只从这里读 —— 见下面 usageOf。
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

/**
 * 子线程 metadata.taskId → 后台任务记录里的 token 用量。
 * 没 taskId（前台子代理 / 老数据）或任务已不在表里 → null（面板显示「未上报」）。
 */
function usageOf(svc: Services, taskId: unknown): { inputTokens: number; outputTokens: number } | null {
  if (typeof taskId !== "string" || !taskId) return null;
  try {
    const rec = svc.tasks.get(taskId);
    return rec?.usage ? { inputTokens: rec.usage.inputTokens, outputTokens: rec.usage.outputTokens } : null;
  } catch { return null; }   // 任务表异常不该把整张子代理列表打挂
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
        /**
         * token 用量（后台任务才有：它在 TaskRegistry 里留档，见 core/agents/task-registry.ts）。
         * 按子线程 metadata.taskId 反查 —— 面板的「用量」一栏就读它。
         * provider 没报时是 null（不是 0）：0 会被读成「没花 token」，
         * 0 与「未上报」在界面上必须是两句话（见 task-registry.ts:finish）。
         */
        usage: usageOf(svc, t.metadata?.taskId),
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
