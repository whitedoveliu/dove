/**
 * HTTP 路由（对面板的唯一契约）
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { Services } from "./bootstrap.ts";
import { answerWithText } from "../../core/src/tools/builtin/ask-user.ts";
import { SseHub } from "./sse.ts";
import { handleServiceRoutes } from "./routes-services.ts";
import { handlePreviewRoutes } from "./routes-preview.ts";
import { handleThreadRoutes } from "./routes-threads.ts";
import { handleToolRoutes } from "./routes-tools.ts";
import { readRuntimeLog, listRuntimeFiles } from "../../core/src/session/runtime-log.ts";
import { requestToken, tokenMatches } from "./local-token.ts";
import { panelOrigin } from "./panel-origin.ts";

/**
 * Host 必须是 loopback 字面量 —— 防 DNS rebinding。
 *
 * 为什么需要：rebinding 时页面以为自己**同源**（地址栏是 http://evil.example，
 * DNS 把 evil.example 解析到 127.0.0.1），于是浏览器认为
 * `GET http://evil.example:8790/api/local-token` 是**同源读取**、不做 CORS 检查，
 * 令牌就被页面拿走了 —— 只看 Origin 的判据（panel-origin.ts）拦不住这一步。
 * 浏览器永远会把「它访问的主机名」填进 Host，所以 Host 是这里唯一可信的判据。
 *
 * 缺 Host 时放行：HTTP/1.0 与进程内测试客户端可能不带该头，而带不出 Host 的
 * 浏览器页面对应不了「一个恶意网页」这个威胁（它一定会带）。
 */
export function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return true;
  const bare = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "127.0.0.1" || bare === "localhost" || bare === "::1";
}

/** 这些路径不走 API 令牌闸门（各有各的理由，见下面的闸门注释） */
function tokenExempt(path: string): boolean {
  return path === "/api/local-token"        // 面板自举入口，必须能取到令牌
    || path.startsWith("/api/tools/")       // PTC 自带 session+token 闸门（另一把锁，见 routes-tools.ts）
    || path.startsWith("/api/preview/");    // 浏览器内嵌资源（img/iframe 发不了自定义头）
}


function json(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<Record<string, unknown>> {
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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

export interface RouteDeps {
  svc: Services;
  hub: SseHub;
  /** 产品界面：control-panel 的构建产物 */
  controlPanelDir: string;
  running: Map<string, AbortController>;
  /**
   * 本机令牌（见 local-token.ts）—— 面板从 /api/local-token 取它，再去过 8008 的闸门。
   * 可缺省：进程内起测试服务的脚本不经过这条路；缺省时空串会让面板明确报「没有令牌」，不会静默。
   */
  token?: string;
}

export async function handle(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const { svc, hub, running } = deps;

  // 静态资源：/ → control-panel（产品界面）
  if (!path.startsWith("/api/")) {
    if (path === "/" || path.startsWith("/assets/") || path === "/dove-icon.png" || path === "/favicon.ico") {
      if (await serveStatic(path, res, deps.controlPanelDir)) return true;
    }
    return serveStatic(path, res, deps.controlPanelDir);
  }

  // ── Host 反 rebinding（所有 /api/* 都要过）────────────
  if (!hostIsLoopback(req.headers.host)) {
    json(res, 403, { error: "Host 不是本机地址，已拒绝（防 DNS rebinding）" });
    return true;
  }

  // ── 健康检查 ─────────────────────────────────────
  if (path === "/api/health") {
    json(res, 200, {
      ok: true, version: "0.1.0", model: svc.cfg.model,
      threads: svc.store.listThreads().length, tools: svc.tools.size,
      memory: !!svc.memory, projects: svc.projects.list().length,
    });
    return true;
  }

  // ── 本地令牌（面板取用 8008 的唯一入口）──────────────
  // 面板由内核自己托管（同源）→ 这条**不带任何 CORS 头**它也读得到；
  // 跨源页面（含 DNS rebinding 的 https://evil.example）响应里一个 CORS 头都没有 → 读不到。
  // 谁算「自己人」（同源 + 开发端口白名单）与为什么不再对任意 loopback 端口放开：panel-origin.ts。
  if (path === "/api/local-token" && req.method === "GET") {
    const origin = panelOrigin(req);
    const head: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "Origin",
    };
    if (origin) head["Access-Control-Allow-Origin"] = origin;
    res.writeHead(200, head);
    res.end(JSON.stringify({ token: deps.token ?? "" }));
    return true;
  }

  // ── API 令牌闸门（与 8008 同一把锁）──────────────────
  // 为什么 8790 也要上锁：令牌的威胁模型（见 local-token.ts）是「用户开着的任意网页」。
  // 8008 早就上了锁，但 8790 的 /api/chat、/api/steer、/api/approve 一直裸着 ——
  // 跨源页面确实**读不到** /api/local-token 的响应（那条不带 CORS 头），
  // 但它根本不需要读：一个 text/plain 的 POST 不触发预检，浏览器照样发出去，
  // 于是任意网页都能开回合、批准工具调用、改模型设置 —— 和当初 8008 的病是同一个。
  // deps.token 为空 = 进程内起的测试服务（smoke 脚本就是这么用的），按既有约定跳过闸门。
  if (deps.token && !tokenExempt(path) && !tokenMatches(deps.token, requestToken(req, url))) {
    json(res, 401, { error: "缺少或错误的本地令牌（X-Dove-Token / ?token=）：见 <DOVE_CONFIG>/api-token" });
    return true;
  }

  // ── 线程与消息（含 T8.2 只读开关）—— 拆到 routes-threads.ts
  if (await handleThreadRoutes(path, url, req, res, svc, json, () => readBody(req))) return true;


  // ── 对话（SSE） ───────────────────────────────────
  if (path === "/api/chat" && req.method === "POST") {
    const b = await readBody(req);
    const threadId = String(b.threadId ?? "");
    // 面板发的是超集 { threadId, message, content, projectId }，两者取其一
    const message = String(b.message ?? b.content ?? "");
    const projectId = b.projectId ? String(b.projectId) : null;
    if (!threadId || !message) { json(res, 400, { error: "threadId 与 message 必填" }); return true; }

    const client = hub.add(threadId, res);
    const controller = new AbortController();
    running.set(threadId, controller);

    try {
      const result = await svc.runtime.run({
        threadId, userText: message, projectId,
        model: b.model ? String(b.model) : undefined,
        signal: controller.signal,
        // SSE 帧带 id: <seq> → 浏览器断线重连时可以用 Last-Event-ID 续传
        sink: (e) => hub.send(client, e, svc.eventLog.seq),
      });
      hub.send(client, { type: "done", assistantMessageId: result.assistantMessageId, endReason: result.endReason });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      hub.send(client, { type: "error", content: msg });
      hub.send(client, { type: "done" });
    } finally {
      running.delete(threadId);
      try { res.end(); } catch { /* ignore */ }
    }
    return true;
  }

  if (path === "/api/stop" && req.method === "POST") {
    const b = await readBody(req);
    const threadId = String(b.threadId ?? "");
    const c = running.get(threadId);
    if (c) { c.abort("user"); json(res, 200, { ok: true, stopped: true }); }
    else json(res, 200, { ok: true, stopped: false });
    return true;
  }

  // ── 插话（steering） ─────────────────────────────
  if (path === "/api/steer" && req.method === "POST") {
    const b = await readBody(req);
    svc.steering.push(String(b.threadId ?? ""), String(b.message ?? ""));
    json(res, 200, { ok: true });
    return true;
  }

  // ── 审批 / 回答 ───────────────────────────────────
  if (path === "/api/approve" && req.method === "POST") {
    const b = await readBody(req);
    const ok = svc.pending.resolveApproval(String(b.toolCallId ?? ""), !!b.approved, b.reason ? String(b.reason) : undefined, b.remember === true);
    json(res, 200, { ok });
    return true;
  }
  if (path === "/api/answer" && req.method === "POST") {
    const b = await readBody(req);
    const qid = String(b.questionId ?? "");
    const text = String(b.answer ?? "");
    // 先走 AskUserQuestion 自己的待答表（它按 toolCallId 索引），再兜底老的 registry
    let ok = answerWithText(qid, text);
    if (!ok) ok = svc.pending.answer(qid, text);
    json(res, 200, { ok });
    return true;
  }
  if (path === "/api/pending" && req.method === "GET") {
    json(res, 200, svc.pending.listPendingApprovals());
    return true;
  }

  // ── 项目 ─────────────────────────────────────────
  if (path === "/api/projects" && req.method === "GET") { json(res, 200, svc.projects.list()); return true; }
  if (path === "/api/projects" && req.method === "POST") {
    const b = await readBody(req);
    const name = String(b.name ?? "新项目");
    const p = svc.projects.create({ id: b.id ? String(b.id) : undefined, name });
    json(res, 200, p);
    return true;
  }
  const projMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (projMatch && req.method === "DELETE") {
    const id = decodeURIComponent(projMatch[1]!);
    svc.preview.stop(id);
    json(res, 200, { ok: svc.projects.remove(id) });
    return true;
  }
  const treeMatch = /^\/api\/projects\/([^/]+)\/tree$/.exec(path);
  if (treeMatch) { json(res, 200, svc.projects.tree(decodeURIComponent(treeMatch[1]!))); return true; }

  // 兼容面板的 /api/files/:projectId（等价于 tree）
  const filesMatch = /^\/api\/files\/([^/]+)$/.exec(path);
  if (filesMatch) { json(res, 200, svc.projects.tree(decodeURIComponent(filesMatch[1]!))); return true; }

  // 读单个文件内容（面板的 file peek）
  if (path === "/api/file" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId") ?? "";
    const rel = url.searchParams.get("path") ?? "";
    const abs = svc.projects.resolveInside(projectId, rel);
    if (!abs || !existsSync(abs)) { json(res, 404, { error: "文件不存在" }); return true; }
    try {
      const content = await readFile(abs, "utf8");
      json(res, 200, { path: rel, content: content.slice(0, 200_000), truncated: content.length > 200_000 });
    } catch (e) { json(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }
  // ── 预览：外站同源代理 + 项目内静态文件（面板「浏览器」标签）—— 拆到 routes-preview.ts
  //    必须排在下面那条老路由前面：/api/preview/file 与 /api/preview/proxy 也会命中那个正则
  if (await handlePreviewRoutes(path, url, req, res, svc, json)) return true;

  const previewMatch = /^\/api\/preview\/([^/]+)$/.exec(path);
  if (previewMatch) {
    const id = decodeURIComponent(previewMatch[1]!);
    try { json(res, 200, await svc.projects.ops(id).preview()); }
    catch (e) { json(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }
  if (path === "/api/build" && req.method === "POST") {
    const b = await readBody(req);
    try {
      const r = await svc.projects.ops(String(b.projectId ?? "")).build();
      json(res, 200, r);
    } catch (e) { json(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }
  const verMatch = /^\/api\/projects\/([^/]+)\/versions$/.exec(path);
  if (verMatch) { json(res, 200, await svc.projects.versions(decodeURIComponent(verMatch[1]!))); return true; }

  // ── 记忆 ─────────────────────────────────────────
  if (path === "/api/memory" && req.method === "GET") {
    const scope = url.searchParams.get("scope") ?? undefined;
    const list = svc.memory ? await svc.memory.listForApi(scope ?? undefined) : [];
    json(res, 200, list);
    return true;
  }
  if (path === "/api/memory/sleep" && req.method === "POST") {
    const r = svc.memory ? await svc.memory.runSleep() : { skipped: true };
    json(res, 200, r);
    return true;
  }

  // ── M6 服务路由（情绪 / 疲劳 / 定时 / 心跳）—— 拆到 routes-services.ts
  if (await handleServiceRoutes(path, url, req, res, svc, json, () => readBody(req))) return true;

  // ── 工具控制面（PTC）：RunScript 脚本里的 doveTool / listTools 打这里 —— 拆到 routes-tools.ts
  if (await handleToolRoutes(path, url, req, res, svc, json, () => readBody(req))) return true;

  // ── 日志与配置 ─────────────────────────────────────
  // 运行时日志（console 输出）—— 和 /api/logs 的「结构化事件」是两回事
  if (path === "/api/logs/runtime" && req.method === "GET") {
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 300), 2000);
    const level = url.searchParams.get("level") ?? undefined;
    const lines = readRuntimeLog(after, limit, level as never);
    json(res, 200, {
      lines,
      count: lines.length,
      lastSeq: lines.length ? lines[lines.length - 1]!.seq : after,
      files: listRuntimeFiles(svc.cfg.configDir),
    });
    return true;
  }

  if (path === "/api/logs" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const sessions = await listSessions(svc.cfg.configDir);
    const latest = sessions[0];
    const records = latest ? await readSession(svc.cfg.configDir, latest, limit) : [];
    json(res, 200, { sessions, records });
    return true;
  }
  if (path === "/api/config" && req.method === "GET") {
    json(res, 200, {
      model: svc.cfg.model, toolModel: svc.cfg.toolModel,
      workspaceRoot: svc.cfg.workspaceRoot, configDir: svc.cfg.configDir,
      configFiles: ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"],
    });
    return true;
  }
  const cfgFile = /^\/api\/config\/file$/.exec(path);
  if (cfgFile && req.method === "GET") {
    const name = url.searchParams.get("name") ?? "SOUL.md";
    const file = join(svc.cfg.configDir, name.replace(/[^A-Za-z0-9._\-]/g, ""));
    const content = existsSync(file) ? await readFile(file, "utf8") : "";
    json(res, 200, { name, content });
    return true;
  }
  if (cfgFile && req.method === "POST") {
    const b = await readBody(req);
    const name = String(b.name ?? "").replace(/[^A-Za-z0-9._\-]/g, "");
    if (svc.memory && name) await svc.memory.writeFile(name, String(b.content ?? ""));
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: "not found", path });
  return true;
}

async function serveStatic(path: string, res: ServerResponse, dir: string): Promise<boolean> {
  if (!existsSync(dir)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>Dove Harness 已启动</h1><p>界面还没构建。请运行 <code>cd control-panel && npm install && npm run build</code>。</p>");
    return true;
  }
  const rel = path === "/" ? "index.html" : path.replace(/^\//, "");
  const file = join(dir, rel);
  const target = existsSync(file) ? file : join(dir, "index.html");
  try {
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
  return true;
}

async function listSessions(configDir: string): Promise<string[]> {
  const dir = join(configDir, "logs");
  if (!existsSync(dir)) return [];
  const { readdirSync } = await import("node:fs");
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
}

async function readSession(configDir: string, file: string, limit: number): Promise<unknown[]> {
  const p = join(configDir, "logs", file);
  const txt = await readFile(p, "utf8");
  const lines = txt.split("\n").filter(Boolean);
  const out: unknown[] = [];
  for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
    try { out.push(JSON.parse(lines[i]!)); } catch { /* skip */ }
  }
  return out;
}
