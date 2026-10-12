/**
 * 预览路由 —— 面板右侧「浏览器」标签的底座
 *
 *   ① GET /api/preview/proxy?url=…          外站同源代理（实现在 preview-proxy.ts）
 *   ② GET /api/preview/file?path=…          项目内单个文件（支持「目录 + index.html」）
 *   ③ GET /api/preview/file/<项目内相对路径>  ②的路径形态 —— 页面里的相对资源
 *      （./style.css）顺着 URL 就能落到同一个项目目录里，不必依赖注入的 base
 *
 * 路径穿越防护：resolve 之后必须仍在项目根（或工作区根）内，并且 realpath 再复核一次
 * —— 软链接指到根外面同样拒绝。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { Services } from "./bootstrap.ts";
import { handleProxy, injectBase, respondError, type JsonResponder } from "./preview-proxy.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".pdf": "application/pdf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
};

export async function handlePreviewRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse,
  svc: Services, json: JsonResponder,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (path === "/api/preview/proxy") { await handleProxy(url, req, res, json); return true; }
  if (path === "/api/preview/file") { await handleFile(url, res, svc, json, null, true); return true; }
  if (path.startsWith("/api/preview/file/")) {
    await handleFile(url, res, svc, json, decodeSafe(path.slice("/api/preview/file/".length)), false);
    return true;
  }
  return false;
}

/** 项目键 → 项目根：认内核 id、端口号（面板传的就是它）、目录名 */
function rootsFor(svc: Services, key: string | null): string[] {
  const list = svc.projects.list();
  if (key) {
    const hit = svc.projects.get(key)
      ?? list.find((p) => String(p.port ?? "") === key)
      ?? list.find((p) => basename(p.path) === key);
    return hit ? [hit.path] : [];
  }
  // 没给项目：先工作区根，再所有项目根（agent 产出的 outputs/xxx 通常在项目里）
  const out = [svc.cfg.workspaceRoot, ...list.map((p) => p.path)];
  return [...new Set(out.filter(Boolean))];
}

/** resolve 之后还在根里才算数 */
function inside(root: string, abs: string): boolean {
  if (resolve(abs) === resolve("/")) return false;
  const rel = relative(resolve(root), resolve(abs));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 目录 → 目录里的 index.html；不存在 / 不是普通文件返回 null */
async function pickFile(abs: string): Promise<string | null> {
  try {
    const st = await stat(abs);
    if (st.isDirectory()) {
      const idx = resolve(abs, "index.html");
      const ist = await stat(idx).catch(() => null);
      return ist?.isFile() ? idx : null;
    }
    return st.isFile() ? abs : null;
  } catch { return null; }
}

function encodeRel(p: string): string {
  return p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 只保留项目内相对路径的形状：去 query / hash / 反斜杠 / 开头的一个 "./" 或 "/" */
export function normalizeRelPath(raw: string): string {
  return String(raw ?? "").split("?")[0]!.split("#")[0]!.replace(/\\/g, "/").replace(/^\.?\//, "");
}

/**
 * @param pathRel 路径形态（③）传来的相对路径；query 形态传 null
 */
async function handleFile(
  url: URL, res: ServerResponse, svc: Services, json: JsonResponder,
  pathRel: string | null, queryForm: boolean,
): Promise<void> {
  const rel = normalizeRelPath(queryForm ? (url.searchParams.get("path") ?? "") : pathRel ?? "");
  const projectKey = url.searchParams.get("projectId") ?? url.searchParams.get("port") ?? null;

  if (queryForm && !rel.trim()) {
    json(res, 400, { ok: false, error: "missing_path", message: "缺少 path 参数：/api/preview/file?path=outputs/demo/index.html" });
    return;
  }
  if (rel.includes("\0")) {
    json(res, 400, { ok: false, error: "bad_path", message: "路径里有非法字符" });
    return;
  }

  const roots = rootsFor(svc, projectKey);
  if (projectKey && roots.length === 0) {
    json(res, 404, { ok: false, error: "project_not_found", message: "找不到项目 " + projectKey });
    return;
  }

  let escaped = false;
  for (const root of roots) {
    const abs = resolve(root, rel);
    if (!inside(root, abs)) { escaped = true; continue; }
    const file = await pickFile(abs);
    if (!file) continue;
    // symlink 复核：realpath 之后还得在根里。
    // 注意根自己也要 realpath —— macOS 上 /tmp 是 /private/tmp 的软链，
    // 只 realpath 文件会把本来合法的路径误判成越界。
    const real = await realpath(file).catch(() => null);
    if (real) {
      const realRoot = await realpath(root).catch(() => root);
      if (!inside(realRoot, real) && !inside(root, real)) { escaped = true; continue; }
    }
    const data = await readFile(real ?? file).catch(() => null);
    if (!data) continue;

    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type, "Cache-Control": "no-store" };
    if (queryForm && type.startsWith("text/html")) {
      // query 形态的 URL 里没有目录信息 —— 注入 <base> 指回「路径形态」，相对资源才找得到。
      // 这里必须用**没 realpath 过**的 file 算目录：real 可能带 /private 前缀，
      // relative 会算出 ".."（浏览器解析 base 时会把 ".." 吃掉，反而 404）。
      const dir = relative(resolve(root), file).split(/[\\/]/).slice(0, -1).join("/");
      const suffix = projectKey ? "?projectId=" + encodeURIComponent(projectKey) : "";
      headers["Content-Type"] = "text/html; charset=utf-8";
      res.writeHead(200, headers);
      res.end(injectBase(data.toString("utf8"), "/api/preview/file/" + (dir ? encodeRel(dir) + "/" : "") + suffix));
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
    return;
  }

  if (escaped) {
    json(res, 403, { ok: false, error: "forbidden", message: "路径越界：只允许访问项目目录内的文件（" + rel + "）" });
    return;
  }
  json(res, 404, { ok: false, error: "not_found", message: "文件不存在：" + rel });
}

/** 让 routes.ts 少写一行 import 的别名（保持两处 json 签名一致） */
export type { JsonResponder };
