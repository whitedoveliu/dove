/**
 * 老契约兼容层（8008 端口）
 *
 * 背景：control-panel 是已经调好的界面，**用户明确要求 UI 不要变**。
 * 它写死了 `http://<host>:8008` 这个后端地址，消费的是老 Python 后端那套 API 与事件词表。
 * 内核换成 TS 之后，我们不改界面，而是**在内核上重新实现这套契约** ——
 * 这样 UI 一行都不动，但背后已经是新内核。
 *
 * 老契约的权威来源：python/api_server.py（路由）与 python/agent_core.py（SSE 事件）。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".mp4": "video/mp4", ".woff2": "font/woff2", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".map": "application/json", ".pdf": "application/pdf",
};
const mimeOf = (f: string): string => MIME[extname(f).toLowerCase()] ?? "application/octet-stream";
import type { Services } from "../bootstrap.ts";
import { handleChatRoutes } from "./routes-chat.ts";
import { handleProjectRoutes } from "./routes-project.ts";
import { handleLogRoutes } from "./routes-logs.ts";
import { handlePermissionRoutes } from "./routes-permission.ts";
import { handleSubagentRoutes } from "./routes-subagents.ts";

export interface LegacyContext { svc: Services }

export function json(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
  });
  res.end(body);
}

export async function readBody(req: IncomingMessage, limit = 50 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

/**
 * 项目 id 映射：老契约用**端口号**当项目 ID（project_3000 那套）。
 * 新内核里 project 有自己的 id，但有 port 字段 —— 拿它对接。
 */
export function projectIdToPort(svc: Services, projectId: string): number | null {
  const raw = String(projectId ?? "").trim();
  const asNum = Number(raw.replace(/^project_/, ""));
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const p = svc.projects.get(raw);
  return p?.port ?? null;
}

export function portToProject(svc: Services, port: number): { id: string; name: string; path: string; port?: number } | null {
  const hit = svc.projects.list().find((p) => p.port === port);
  return hit ? { id: hit.id, name: hit.name, path: hit.path, port: hit.port } : null;
}

/** 老契约的 Project 形状（control-panel/src/lib/api.ts:361） */
export interface LegacyProject {
  port: string;
  name: string;
  display_name?: string;
  name_text?: string;
  project?: string | null;
  dir_name?: string;
  /**
   * **真实项目 id**（数据库主键）。
   *
   * 为什么必须暴露：导入/接入的项目**没有端口**（port 是 0），
   * 而 dir_name 只是目录名、和 id 不一定相同（实测 /tmp/noport-test 的
   * dir_name 是 noport-test，id 却是 pmuwyou7r）。
   * 所以 port 和 dir_name 都定位不到这类项目 —— 前端点删除会 404。
   * 用这个字段才能稳定定位。
   */
  id?: string;
  attached?: boolean;
  title?: string | null;
  updated_at?: number | null;
  messages?: number;
  last_user?: string | null;
  path: string;
}

export function toLegacyProject(svc: Services, p: { id: string; name: string; path: string; port?: number }): LegacyProject {
  const thread = svc.store.listThreads("project").find((t) => t.projectId === p.id);
  const msgs = thread ? svc.store.listMessages(thread.id, 500) : [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const lastUserText = lastUser
    ? lastUser.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join("").slice(0, 200)
    : null;
  const firstUser = msgs.find((m) => m.role === "user");
  const title = firstUser
    ? firstUser.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join("").slice(0, 60)
    : null;
  const dir = p.path.split("/").filter(Boolean).pop() ?? p.id;
  return {
    port: String(p.port ?? 0),
    name: p.name,
    display_name: p.name,
    name_text: p.name,
    project: null,
    dir_name: dir,
    id: p.id,
    attached: false,
    title,
    updated_at: thread?.updatedAt ?? null,
    messages: msgs.length,
    last_user: lastUserText,
    path: p.path,
  };
}

export async function handleLegacy(
  req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    res.end();
    return true;
  }

  // 健康检查（前端启动第一件事）
  if (path === "/api/health") {
    json(res, 200, { status: "ok", message: `Dove 内核（TS）· ${svc.tools.size} 个工具` });
    return true;
  }

  // 静态预览：/preview/{port}/{path}?version=N（前端 iframe 直接用它）
  const pv = /^\/preview\/([^/]+)(\/.*)?$/.exec(path);
  if (pv) {
    const proj = portToProject(svc, Number(pv[1]));
    if (!proj) { res.writeHead(404); res.end("项目不存在"); return true; }
    const rel = (pv[2] ?? "/").replace(/^\//, "") || "index.html";
    const file = join(proj.path, rel);
    if (existsSync(file) && statSync(file).isFile()) {
      const data = readFileSync(file);
      res.writeHead(200, { "Content-Type": mimeOf(file), "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      res.end(data);
    } else {
      const idx = join(proj.path, "index.html");
      if (existsSync(idx)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(readFileSync(idx));
      } else { res.writeHead(404); res.end("没有可预览的内容"); }
    }
    return true;
  }

  if (await handleChatRoutes(path, url, req, res, svc)) return true;
  if (await handleProjectRoutes(path, url, req, res, svc)) return true;
  if (await handleLogRoutes(path, url, req, res, svc)) return true;
  if (await handlePermissionRoutes(path, url, req, res, svc)) return true;
  if (await handleSubagentRoutes(path, url, req, res, svc)) return true;

  // 没实现的端点：明确 404（前端会看到，但不会白屏）
  json(res, 404, { success: false, message: `兼容层未实现：${req.method} ${path}` });
  return true;
}

export interface LegacyServerHandle { port: number; close(): void }

/** 起 8008 兼容服务；端口被占时返回 null（不抛） */
export async function startLegacyServer(svc: Services, port = 8008): Promise<LegacyServerHandle | null> {
  const server = createServer((req, res) => {
    handleLegacy(req, res, svc).catch((e) => {
      try {
        json(res, 500, { success: false, message: e instanceof Error ? e.message : String(e) });
      } catch { /* 已经发过响应了 */ }
    });
  });

  const ok = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!ok) return null;

  return {
    port,
    close: () => { try { server.close(); } catch { /* ignore */ } },
  };
}
