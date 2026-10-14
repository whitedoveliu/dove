/**
 * 子代理路由（A3；「后台 Agent」列表 + 过程 于 A7 补齐）
 *
 * 子代理被存成 `kind='subagent'` 的线程（见 agents/subagent-store.ts），
 * 所以这里只做两件事：**列出来** + **把它的过程按主对话的同一形状吐出去**。
 *
 * 第三条（A7）：列表要按状态页签过滤（最近 / 进行中 / 已完成 / 失败 / 全部），
 * 每行要带面板卡片要的信息（标题 / 项目路径 / 模型 / 起止 / 耗时 / 用量），
 * 另外多一条**取单个子代理的过程条目**（思考 / 正文 / 工具调用 + 结果，带顺序）。
 *
 * 第四件小事：列表里**顺带带出 token 用量**（按 metadata.taskId 反查 TaskRegistry）。
 * 面板的「这个子代理烧了多少 token」只从这里读 —— 见下面 usageOf。
 *
 * 过程复用 partsToEvents —— 和主对话的历史回放**完全同一条路径**，
 * 前端不用为子代理再写一套渲染。
 *
 * 读侧都是 agents/subagent-report.ts 里的纯函数（可在 core 的单测里直接验），
 * 这里只负责「找项目 / 取数据 / 定状态码」。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../bootstrap.ts";
import { json, portToProject } from "./server.ts";
import { partsToEvents } from "./routes-project-parts.ts";
import { toolInfoLine } from "./sse-compat.ts";
import {
  filterSubagentItems, subagentEntries, subagentItem, type SubagentStatusFilter,
} from "../../../core/src/agents/subagent-report.ts";

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

/** 状态页签的取值 —— 认不出的值按「全部」处理（老面板不带这个参数，行为不变） */
const FILTERS: readonly SubagentStatusFilter[] = ["recent", "running", "done", "failed", "all"];

function readFilter(url: URL): SubagentStatusFilter {
  const raw = url.searchParams.get("status") ?? "";
  return (FILTERS as readonly string[]).includes(raw) ? raw as SubagentStatusFilter : "all";
}

/** 项目下的全部子代理线程（升序 = 旧面板看到的顺序，不能改） */
function projectSubagentThreads(svc: Services, projId: string) {
  const parent = svc.store.listThreads("project").filter((t) => t.projectId === projId);
  const parentIds = new Set(parent.map((t) => t.id));
  return svc.store.listThreads("subagent")
    .filter((t) => t.projectId === projId || parentIds.has(String(t.metadata?.parentThreadId ?? "")))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function handleSubagentRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  // ── GET /api/projects/{port}/subagents[?status=recent|running|done|failed|all] ──
  const listMatch = /^\/api\/projects\/([^/]+)\/subagents$/.exec(path);
  if (listMatch && req.method === "GET") {
    const proj = findProject(svc, decodeURIComponent(listMatch[1]!));
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }

    const filter = readFilter(url);
    const items = projectSubagentThreads(svc, proj.id).map((t) => subagentItem(t, {
      // token 用量（后台任务才有：它在 TaskRegistry 里留档，见 core/agents/task-registry.ts）。
      // provider 没报时是 null（不是 0）：0 会被读成「没花 token」，两句话必须分开
      // （见 task-registry.ts:finish）。
      usage: usageOf(svc, t.metadata?.taskId),
      // 卡片上那一行仓库路径（项目根，面板会自己截断）
      projectPath: proj.path,
      // 核验「它真的还在跑」：记录属于**别的进程** → 那次运行已经随它结束了（见 subagentItem）
      ownerPid: process.pid,
    }));
    const subagents = filterSubagentItems(items, filter);

    json(res, 200, { success: true, filter, subagents });
    return true;
  }

  // ── GET /api/projects/{port}/subagents/{id} —— 元信息 + 过程条目 ──
  const oneMatch = /^\/api\/projects\/([^/]+)\/subagents\/([^/]+)$/.exec(path);
  if (oneMatch && req.method === "GET") {
    const proj = findProject(svc, decodeURIComponent(oneMatch[1]!));
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }

    const id = decodeURIComponent(oneMatch[2]!);
    // ⚠️ 归属校验：只认**这个项目**的子代理。别人家的 id 猜到了也取不出来
    //    （和 resolveAgent 的口径一致：跨线程读别人的过程同样是越权）。
    const th = projectSubagentThreads(svc, proj.id).find((t) => t.id === id);
    if (!th) { json(res, 404, { success: false, message: "子代理不存在（" + id + "）" }); return true; }

    const meta = subagentItem(th, {
      usage: usageOf(svc, th.metadata?.taskId), projectPath: proj.path, ownerPid: process.pid,
    });
    const entries = subagentEntries(svc.store, th.id).map((e) => (
      e.kind === "tool"
        // info = 参数摘要，和实时流（sse-compat 的 subagent_tool）**同一个函数**：
        // 两条路上的同一件事必须长一样，否则刷新一次文案就变了
        ? { ...e, info: toolInfoLine(e.args ?? {}) }
        : e
    ));

    json(res, 200, {
      success: true,
      subagent: meta,
      /** 过程条目（思考 / 正文 / 工具调用 + 结果，顺序 = 发生顺序） */
      entries,
      /**
       * 还在跑：落盘的 parts 要等它结束才有（见 subagent-store.ts:finish），
       * 所以运行中这里多半是空的 —— 实时过程走 SSE 的 subagent 事件那条流，面板自己拼。
       */
      running: meta.status === "running",
    });
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
