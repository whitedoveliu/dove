/**
 * 目标（Goal）路由 —— 给面板的 /goal 用
 *
 * 模型侧走的是 CreateGoal / GetGoal / UpdateGoal 三个工具；这里是**人类的入口**：
 * 用户在输入框打 /goal <目标>，面板调这里建档/暂停/继续/完成。两边共用同一个 GoalStore，
 * 因此同一条乐观并发规则（revision）对人和模型都生效。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../bootstrap.ts";
import { json, readBody, portToProject } from "./server.ts";
import { GoalStore, GoalError, goalView, normalizeMaxRounds } from "../../../core/src/agents/goal-store.ts";

const ACTIONS = new Set(["create", "pause", "resume", "complete", "blocked", "clear"]);

function fail(res: ServerResponse, e: unknown): void {
  if (e instanceof GoalError) {
    const status = e.code === "GOAL_NOT_FOUND" ? 404 : e.code === "GOAL_ALREADY_EXISTS" ? 409 : 400;
    json(res, status, { success: false, code: e.code, message: e.message });
    return;
  }
  json(res, 500, { success: false, message: e instanceof Error ? e.message : String(e) });
}

export async function handleGoalRoutes(
  path: string, _url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  const m = /^\/api\/projects\/([^/]+)\/goal$/.exec(path);
  if (!m || (req.method !== "GET" && req.method !== "POST")) return false;

  // 三键查找（端口 → 项目 id → 目录名），和权限/删除路由完全一致：
  // 只认端口的话，前端拿到项目 id 时会 404，表现出来就是"设了没生效"。
  const key = decodeURIComponent(m[1]!);
  let proj = portToProject(svc, Number(key));
  if (!proj) {
    const hit = svc.projects.get(key)
      ?? svc.projects.list().find((p) => p.path.split("/").filter(Boolean).pop() === key);
    if (hit) proj = { id: hit.id, name: hit.name, path: hit.path, port: hit.port };
  }
  if (!proj) { json(res, 404, { success: false, message: "项目不存在（" + key + "）" }); return true; }
  const thread = svc.store.listThreads("project").find((t) => t.projectId === proj.id);
  if (!thread) { json(res, 404, { success: false, message: "项目线程不存在" }); return true; }

  const goals = new GoalStore(svc.db);
  try {
    if (req.method === "POST") {
      const b = await readBody(req);
      const action = String(b.action ?? "create");
      if (!ACTIONS.has(action)) {
        json(res, 400, { success: false, message: "action 必须是 " + [...ACTIONS].join(" / ") });
        return true;
      }
      if (action === "clear") {
        goals.clear(thread.id);
      } else if (action === "create") {
        goals.create(thread.id, {
          objective: String(b.objective ?? ""),
          ...(b.max_rounds !== undefined ? { maxRounds: normalizeMaxRounds(b.max_rounds) } : {}),
        });
      } else {
        const cur = goals.get(thread.id);
        if (!cur) { json(res, 404, { success: false, code: "GOAL_NOT_FOUND", message: "这个会话还没有目标。" }); return true; }
        goals.update(thread.id, {
          goalId: cur.id, revision: cur.revision,
          action: action as "pause" | "resume" | "complete" | "blocked",
          ...(b.blocked_reason !== undefined ? { blockedReason: String(b.blocked_reason) } : {}),
        });
      }
    }
    const cur = goals.get(thread.id);
    json(res, 200, { success: true, ...goalView(cur) });
    return true;
  } catch (e) { fail(res, e); return true; }
}
