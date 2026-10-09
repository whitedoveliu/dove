/**
 * 权限模式路由（从 routes-project.ts 抽出来，那边超 400 行了）
 *
 * 三档对齐 Codex 的 SandboxMode：
 *   full       完全访问 —— 任何操作都不审批
 *   workspace  工作区内修改 —— 默认；工作区内放行，越界才问
 *   readonly   仅可查看 —— 写类工具直接从工具表里裁掉
 *
 * 存在**线程 metadata** 里（不是全局设置）—— 权限是"这次对话能干多少"，
 * 换个任务可能就想放宽或收紧。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../bootstrap.ts";
import { json, readBody, portToProject } from "./server.ts";

/** 收新机值 + 旧别名（存量数据里还是 full/workspace/readonly，双读兼容） */
const MODES = new Set(["danger-full-access", "workspace-write", "read-only", "auto"]);
const ALIAS: Record<string, string> = { full: "danger-full-access", workspace: "workspace-write", readonly: "read-only" };

/**
 * 预设目录（B4）—— **主机下发，前端不再硬编码**。
 *
 * 参考 DSH 的 permission-presets catalog：加一档只改这里一处，
 * 前端只管渲染。`requiresConfirm` 让「完全权限要过确认闸」这件事
 * 由主机说了算，而不是各个界面各记一遍。
 */
const PRESETS = [
  {
    value: "read-only", label: "仅可查看", requiresConfirm: false, experimental: false,
    description: "只查不动：写文件、执行命令这些工具直接不给",
  },
  {
    value: "workspace-write", label: "工作区内修改", requiresConfirm: false, experimental: false,
    description: "工作区内直接改；越界（装依赖、访问工作区外）才问你",
  },
  {
    value: "danger-full-access", label: "完全权限", requiresConfirm: true, experimental: false,
    description: "任何操作都不再询问 —— 只在信任的任务上用",
  },
  {
    value: "auto", label: "Auto review", requiresConfirm: true, experimental: true,
    description: "无沙箱运行，但每次工具调用前由模型审一遍；审查拒绝的转你批准",
  },
] as const;

export async function handlePermissionRoutes(
  path: string, _url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  // ── GET /api/permission-presets（B4）───────────────
  if (path === "/api/permission-presets" && req.method === "GET") {
    json(res, 200, { success: true, default: "workspace-write", presets: PRESETS });
    return true;
  }

  const m = /^\/api\/projects\/([^/]+)\/permission$/.exec(path);
  if (!m || (req.method !== "GET" && req.method !== "POST")) return false;

  // 三键查找（端口 → 项目 id → 目录名），顺序和删除路由**完全一致**。
  // ⚠️ 只认端口不够：前端拿到的可能是 project.id，Number("pmuxxx") = NaN → 404 → 静默失败，
  //    表现出来就是「选了权限但没生效」。
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

  if (req.method === "POST") {
    const b = await readBody(req);
    const raw = String(b.mode ?? "");
    const mode = ALIAS[raw] ?? raw;            // 旧前端传 full 也认
    if (!MODES.has(mode)) {
      json(res, 400, { success: false, message: "mode 必须是 danger-full-access / workspace-write / read-only / auto" });
      return true;
    }
    // readOnly 是老布尔字段，一起写保持兼容（runtime 两处都认）
    svc.store.updateThread(thread.id, {
      metadata: { ...thread.metadata, permissionMode: mode, readOnly: mode === "read-only" },
    });
  }

  const cur = svc.store.getThread(thread.id)?.metadata ?? {};
  // 读的时候也过一遍映射：存量数据里可能是旧机值
  const mode = cur.readOnly === true
    ? "read-only"
    : (ALIAS[String(cur.permissionMode ?? "")] ?? cur.permissionMode ?? "workspace-write");
  json(res, 200, { success: true, mode });
  return true;
}
