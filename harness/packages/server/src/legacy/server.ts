/**
 * 面板兼容层（8008 端口）
 *
 * 背景：control-panel 写死了 `http://<host>:8008` 这个后端地址，
 * 消费的是这一套 API 与事件词表。为了不动界面，这套契约在内核上重新实现了一遍 ——
 * UI 一行都不动，背后就是内核本身。
 *
 * 老契约由本目录定义：HTTP 路由见各 routes-*.ts，SSE 事件词表见 sse-compat.ts。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { hostIsLoopback } from "../routes.ts";
import { inside, realOrNull } from "./path-guard.ts";

/**
 * /preview 的 Content-Type 表。
 * 扩展名集合与 control-panel/src/lib/file-kinds.ts 对齐：**面板认得的类型必须能直连渲染**，
 * 缺一个就退化成 octet-stream —— 实测表现为 `page.htm` 在 iframe 里变下载 / 空白，
 * `.aac` / `.mkv` 这类音视频直接「类型不对」拒绝播放。**改这里要同步那边**（两边用途不同：
 * 面板侧选渲染器、这里选 Content-Type，但扩展名必须一一对应）。
 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".mp4": "video/mp4", ".woff2": "font/woff2", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".map": "application/json", ".pdf": "application/pdf",
  // 面板的文件模块会直接在 <img>/<video>/<audio>/<iframe> 里加载这些（发不了自定义头，
  // 只能走这条查询串带令牌的 /preview 路由）—— 缺了 MIME 就变成 octet-stream，
  // 音频尤其会因为「类型不对」拒绝播放。
  ".htm": "text/html; charset=utf-8", ".xhtml": "text/html; charset=utf-8",
  ".avif": "image/avif", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac",
  ".aac": "audio/aac", ".opus": "audio/ogg", ".weba": "audio/webm",
  ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/x-m4v", ".ogv": "video/ogg",
  ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
  ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json", ".mjs": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8",
  ".xml": "application/xml", ".yml": "text/yaml; charset=utf-8", ".yaml": "text/yaml; charset=utf-8",
};
const mimeOf = (f: string): string => MIME[extname(f).toLowerCase()] ?? "application/octet-stream";

import type { Services } from "../bootstrap.ts";
// 「点段一律拒」的判据只有一份：8790 的 /api/preview/* 用的是同一个函数（见 preview-path.ts）
import { hasDotSegment, isRunnableDoc, PREVIEW_DOC_CSP } from "../preview-path.ts";
import { requestToken, tokenMatches } from "../local-token.ts";
import { handleChatRoutes } from "./routes-chat.ts";
import { handleCaptureRoutes } from "./routes-capture.ts";
import { handleProjectRoutes } from "./routes-project.ts";
import { handleProjectFileRoutes } from "./routes-project-files.ts";
import { handleLogRoutes } from "./routes-logs.ts";
import { handlePermissionRoutes } from "./routes-permission.ts";
import { handleGoalRoutes } from "./routes-goal.ts";
import { handleSubagentRoutes } from "./routes-subagents.ts";
import { handleSettingsRoutes } from "./routes-settings.ts";
import { handleOpenPathRoutes } from "./routes-open-path.ts";

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

/**
 * 401（令牌缺失 / 不对）—— **不带任何 CORS 头**。
 * 这样跨源页面连响应体都读不到（浏览器直接拦掉），这正是要的效果；
 * 面板自己带着令牌，走的是 json() 那条正常路径。
 */
function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
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

/**
 * 三键查找（端口 → 项目 id → 目录名）—— 权限 / 目标 / 插话等路由**共用同一份**。
 *
 * ⚠️ 只认端口不够：前端拿到的可能是 project.id，Number("pmuxxx") = NaN → 404 → 静默失败，
 *    表现出来就是「选了权限但没生效」「插话没反应」。目录名也要认（dir_name 不一定等于 id）。
 */
export function findProjectByKey(
  svc: Services, key: string,
): { id: string; name: string; path: string; port?: number } | null {
  const raw = String(key ?? "").trim();
  if (!raw) return null;
  const byPort = portToProject(svc, Number(raw));
  if (byPort) return byPort;
  const hit = svc.projects.get(raw)
    ?? svc.projects.list().find((p) => p.path.split("/").filter(Boolean).pop() === raw);
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
  // 只认 role:"user" 会把**宿主注入**（如每轮的 swarm 模式提醒）当成用户说的话：
  // 第一个注入当了标题、最后一个注入当了 last_user，项目列表里显示的就成了提醒正文。
  const said = msgs.filter((m) => m.role === "user" && m.origin !== "injection");
  const lastUser = [...said].reverse()[0];
  const lastUserText = lastUser
    ? lastUser.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join("").slice(0, 200)
    : null;
  const firstUser = said[0];
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
  req: IncomingMessage, res: ServerResponse, svc: Services, token: string,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const gated = path.startsWith("/api/") || path.startsWith("/preview/");

  // ── Host 反 rebinding（/api/* 与 /preview/* 都要过）──────
  // 判据只有一份定义：routes.ts 的 hostIsLoopback（8790 用的是同一个）—— 两边的口径必须一致。
  // 为什么必须有：rebinding 时页面以为自己**同源**（地址栏 evil.example、DNS 指向 127.0.0.1），
  // 浏览器就此把它当同源读取，连 CORS 都不查 —— Host 是这里唯一可信的判据。
  // 缺 Host 放行的理由也照抄那边：HTTP/1.0 与进程内测试客户端不带这个头。
  if (gated && !hostIsLoopback(req.headers.host)) {
    json(res, 403, { success: false, message: "Host 不是本机地址，已拒绝（防 DNS rebinding）" });
    return true;
  }

  // CORS 预检。**预检不过令牌闸门**：浏览器替我们发预检时既不带自定义头、也不带凭证，
  // 这里要了令牌，面板自己的请求连发都发不出去。跨源页面确实能拿到这个 204，
  // 但它从中读不到任何数据 —— 真正的门是下面的令牌闸门。
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    res.end();
    return true;
  }

  // 健康检查（前端启动第一件事）—— 不过闸：面板靠它判断内核在不在
  if (path === "/api/health") {
    json(res, 200, { status: "ok", message: `Dove 内核（TS）· ${svc.tools.size} 个工具` });
    return true;
  }

  // ── 令牌闸门 ─────────────────────────────────────────
  // /api/*（除 /api/health）与 /preview/* 都要令牌：X-Dove-Token 头（面板的 fetch）或 ?token=。
  // 为什么必须有：这条 8008 绑在 127.0.0.1 上，但「本机」不等于「自己人」—— 用户开着的任意网页
  // 都能往这里发请求，没有闸门就能改模型 base URL / API key、开回合（见 local-token.ts）。
  // /preview/* 由「不过闸」改成「要 ?token=」：它服务的是项目目录里的**任意文件**（含 .env），
  // 而 <img>/<video>/<iframe> 发不了自定义头 —— 所以令牌走查询串（面板拼 projectAssetUrl 时带上；
  // HTML 文档不走这条，见下面 /preview 的说明）。
  if (gated && !tokenMatches(token, requestToken(req, url))) {
    unauthorized(res);
    return true;
  }

  // 静态预览：/preview/{port}/{path}?token=…&version=N
  //
  // 谁在用（面板侧接线见 control-panel/src/lib/preview-url.ts 顶部的表，改这里要看那边）：
  //   · <img>/<video>/<audio>/pdf 这类**没有相对子资源**的标签 —— 只有它们能走这里；
  //   · **HTML 文档不走这里**：它里面的 ./style.css 是相对 URL，不会继承 `?token=`（必然 401），
  //     所以那份文档由面板同源的 /api/preview/project/{port}/… 出（服务端自己带边界读盘，不用令牌）。
  //   · 本机脚本 / curl 想直连也可以（读 <DOVE_CONFIG>/api-token 自己拼查询串）。
  const pv = /^\/preview\/([^/]+)(\/.*)?$/.exec(path);
  if (pv) {
    const proj = portToProject(svc, Number(pv[1]));
    if (!proj) { res.writeHead(404); res.end("项目不存在"); return true; }
    const rel = (pv[2] ?? "/").replace(/^\//, "") || "index.html";
    // 点文件一律不服务：项目里的 .env / .git/config / .ssh 一个都不该经这条路由出门
    // （面板要读文本走带令牌的 /api/projects/{port}/file，那条路由有自己的一套边界）
    if (hasDotSegment(rel)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("拒绝：预览不服务点文件 / 点目录（.env、.git/…）");
      return true;
    }
    const file = join(proj.path, rel);
    let isFile = false;
    try { isFile = statSync(file).isFile(); } catch { /* 不存在 / 坏软链 → 走下面的 index 兜底 */ }
    if (isFile) {
      // 软链逃逸：真实路径也必须落在项目根内（与 /api/projects/*/file 同一道闸，见 path-guard.ts）
      const real = realOrNull(file);
      const realRoot = realOrNull(proj.path) ?? proj.path;
      if (!real || !inside(realRoot, real)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("拒绝：真实路径不在项目工作区内");
        return true;
      }
      // **不带** Access-Control-Allow-Origin：这些字节只给面板（令牌）看，
      // 跨源页面连读都读不到（以前那个 `*` 等于把项目文件开放给任意网页）。
      // html / svg / xml 还要进沙箱：这条 URL 里的令牌是**明文查询串**，顶层打开时文档能读到它 ——
      // 不加沙箱就是「拿到令牌的同源文档」。判据与理由见 preview-path.ts 的 PREVIEW_DOC_CSP。
      const type = mimeOf(file);
      const head: Record<string, string> = { "Content-Type": type, "Cache-Control": "no-store" };
      if (isRunnableDoc(type)) head["Content-Security-Policy"] = PREVIEW_DOC_CSP;
      res.writeHead(200, head);
      res.end(readFileSync(file));
      return true;
    }
    // 找不到文件就退回 index.html（老行为：整站预览的入口）—— 它同样要过 realpath 那道
    const idx = join(proj.path, "index.html");
    const realIdx = realOrNull(idx);
    if (realIdx && inside(realOrNull(proj.path) ?? proj.path, realIdx)) {
      // index 兜底同样是「能在浏览器里跑的文档」→ 同一份沙箱（为什么：preview-path.ts）
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PREVIEW_DOC_CSP });
      res.end(readFileSync(idx));
    } else { res.writeHead(404); res.end("没有可预览的内容"); }
    return true;
  }

  if (await handleChatRoutes(path, url, req, res, svc)) return true;
  if (await handleCaptureRoutes(path, req, res)) return true;
  if (await handleProjectFileRoutes(path, url, req, res, svc)) return true;
  if (await handleProjectRoutes(path, url, req, res, svc)) return true;
  if (await handleLogRoutes(path, url, req, res, svc)) return true;
  if (await handlePermissionRoutes(path, url, req, res, svc)) return true;
  if (await handleGoalRoutes(path, url, req, res, svc)) return true;
  if (await handleSubagentRoutes(path, url, req, res, svc)) return true;
  if (await handleSettingsRoutes(path, req, res, svc)) return true;
  if (await handleOpenPathRoutes(path, req, res, svc)) return true;

  // 没实现的端点：明确 404（前端会看到，但不会白屏）
  json(res, 404, { success: false, message: `兼容层未实现：${req.method} ${path}` });
  return true;
}

export interface LegacyServerHandle { port: number; close(): void }

/**
 * 起 8008 兼容服务；端口被占时返回 null（不抛）。
 *
 * `token` 是**必需**的 —— 少了它兼容层就没有闸门（等于把门焊死在打开状态），
 * 所以这里直接抛，宁可起不来也不静默裸奔。令牌由 main.ts 从 <DOVE_CONFIG>/api-token 取（见 local-token.ts）。
 */
export async function startLegacyServer(svc: Services, port = 8008, token?: string): Promise<LegacyServerHandle | null> {
  if (!token) throw new Error("startLegacyServer 需要本地令牌：见 local-token.ts（<DOVE_CONFIG>/api-token）");

  const server = createServer((req, res) => {
    handleLegacy(req, res, svc, token).catch((e) => {
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

  // port 传 0 时（测试）要让调用方知道内核真的听到了哪个端口
  const addr = server.address();
  const actualPort = addr && typeof addr === "object" ? addr.port : port;

  return {
    port: actualPort,
    close: () => { try { server.close(); } catch { /* ignore */ } },
  };
}
