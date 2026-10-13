/**
 * 预览路由 —— 面板右侧「浏览器」标签的底座
 *
 *   ① GET /api/preview/proxy?url=…          外站同源代理（实现在 preview-proxy.ts）
 *   ② GET /api/preview/file?path=…          项目内单个文件（支持「目录 + index.html」）
 *   ③ GET /api/preview/file/<项目内相对路径>  ②的路径形态
 *   ④ GET /api/preview/project/<项目键>/<相对路径>  **项目作用域**的路径形态 —— 面板的 HTML 预览走它
 *   ⑤ GET /api/file/download?projectId=…&path=…    原始字节（「下载 / 另存」走它）
 *
 * ①②③④ 在**令牌闸门之外**（browser 端发不了自定义头，只能靠同源这一层信任，见 routes.ts 的
 * tokenExempt）—— 所以它们必须自己把点段挡掉（.env 不出口，见 preview-path.ts）。
 * ⑤ 反过来：它是**闸门之内**的路径（`/api/file/...` 不在 tokenExempt 里），面板带着
 * X-Dove-Token 取它 —— 那是「用户点下载 .env」这类**已鉴权**的读取，点文件照给。
 * 这个分工不是口味：把 ⑤ 放到 /api/preview/ 下 = 任何本机页面都能下载 .env；
 * 把 ①②③④ 挪到闸门内 = 相对子资源全军覆没（它们带不了头）。
 *
 * 为什么必须有 ④（而不是让 ③ 兼着干）：HTML 文档里的 `./style.css` 是**相对 URL**，
 * 它按文档 URL 的目录解析、**不会继承查询串**（RFC 3986：相对引用带 path 时 query 取引用自己的，
 * 基址的 query 被丢掉 —— `<base href="…?projectId=3000">` 也救不了，这是本路由踩过的坑）。
 * 8008 那条 /preview/{port}/… 上的令牌只能走查询串，于是子资源必然 401；
 * 而 ③ 没有项目信息，子资源要落到 `/api/preview/file/dir/style.css` 只能靠
 * 「工作区根 + 所有项目根逐个试」去猜（同名文件会**串项目**）。把项目键写进**路径**，
 * 相对子资源就自然解析回同一个项目：`/api/preview/project/3000/dir/style.css`。
 *
 * 这条路由**不需要令牌**（routes.ts 的 tokenExempt 把 /api/preview/* 排除在闸门外）：
 * <img>/<iframe> 发不了自定义头，而浏览器直连的请求只能靠「同源」这一层来信任。
 * 它自己带边界：Host 反 rebinding（routes.ts）→ 项目键 → resolve 判前缀 → realpath 复核 → 点段拒绝。
 * 面板侧的使用纪律：**只有 HTML 文档走这条**；没有相对子资源的图片 / 音视频 / PDF 走
 * 8008 的 `/preview/{port}/…?token=`（跨源，拿不到面板同源的任何权限）。
 *
 * 路径穿越防护：resolve 之后必须仍在项目根（或工作区根）内，并且 realpath 再复核一次
 * —— 软链接指到根外面同样拒绝。「点段一律拒」的判据与 8008 共用一个函数（preview-path.ts）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { Services } from "./bootstrap.ts";
import { hasDotSegment, isRunnableDoc, PREVIEW_DOC_CSP } from "./preview-path.ts";
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
  if (path === "/api/preview/file") {
    await handleFile(url, res, svc, json, { rel: null, projectKey: null, pathForm: false });
    return true;
  }
  if (path.startsWith("/api/preview/file/")) {
    await handleFile(url, res, svc, json, { rel: decodeSafe(path.slice("/api/preview/file/".length)), projectKey: null, pathForm: true });
    return true;
  }
  // ④ /api/preview/project/<项目键>[/<相对路径>] —— 项目作用域写在路径里（HTML 预览专用，见文件头）
  if (path === "/api/preview/project" || path.startsWith("/api/preview/project/")) {
    const rest = decodeSafe(path.slice("/api/preview/project".length).replace(/^\//, ""));
    const slash = rest.indexOf("/");
    const projectKey = (slash === -1 ? rest : rest.slice(0, slash)).trim();
    const rel = slash === -1 ? "" : rest.slice(slash + 1);
    if (!projectKey) {
      json(res, 400, { ok: false, error: "missing_project", message: "缺少项目键：/api/preview/project/<端口|id|目录名>/<相对路径>" });
      return true;
    }
    await handleFile(url, res, svc, json, { rel, projectKey, pathForm: true });
    return true;
  }
  // ⑤ /api/file/download?projectId=<键>&path=<相对路径> —— 「下载 / 另存」的原始字节。
  //    在令牌闸门之内（面板的 fetch 带 X-Dove-Token），所以点文件照给：这是用户自己点的下载，
  //    和预览路由「不许 .env 出门」不是一回事（那条是给**没有鉴权的浏览器标签**用的）。
  if (path === "/api/file/download") {
    await handleDownload(url, res, svc, json);
    return true;
  }
  return false;
}

/**
 * 下载一个项目内文件的**原始字节**。
 *
 * 为什么面板不能直接用 8008 的 `/preview/{port}/…?token=` 下载：那条路由去掉了
 * `Access-Control-Allow-Origin`（正是不想让任意网页读到项目文件），8790 → 8008 的
 * `fetch` 于是连响应体都读不到（`res.blob()` 拿不到），带令牌也白带。
 * 所以下载必须走**面板同源**，而「同源 + 能读 .env」只能靠令牌闸门：这条路在闸门之内。
 *
 * 边界与预览路由同一套：项目键 → resolve 判前缀 → realpath 复核（软链逃逸 403）。
 * Content-Length 是给面板用的内存闸门（>256MB 就劝退，别把 GB 级文件灌进面板进程）。
 */
async function handleDownload(url: URL, res: ServerResponse, svc: Services, json: JsonResponder): Promise<void> {
  const projectKey = url.searchParams.get("projectId") ?? url.searchParams.get("port") ?? null;
  const rel = normalizeRelPath(url.searchParams.get("path") ?? "");
  if (!rel.trim()) {
    json(res, 400, { ok: false, error: "missing_path", message: "缺少 path 参数：/api/file/download?projectId=3000&path=outputs/a.png" });
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
    const st = await stat(abs).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      json(res, 400, { ok: false, error: "is_directory", message: "这是一个目录，不能下载：" + rel });
      return;
    }
    const real = await realpath(abs).catch(() => null);
    if (real) {
      const realRoot = await realpath(root).catch(() => root);
      if (!inside(realRoot, real) && !inside(root, real)) { escaped = true; continue; }
    }
    const data = await readFile(abs).catch(() => null);
    if (!data) continue;
    const type = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
    const head: Record<string, string> = {
      // Content-Type 与预览同一张表（浏览器直接打开这条 URL 时别变成下载不了的乱码）
      "Content-Type": type,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "no-store",
    };
    // 下载口也能被顶层打开（?token= 明文），html / svg 照样要进沙箱（见 preview-path.ts）
    if (isRunnableDoc(type)) head["Content-Security-Policy"] = PREVIEW_DOC_CSP;
    res.writeHead(200, head);
    res.end(data);
    return;
  }
  if (escaped) {
    json(res, 403, { ok: false, error: "forbidden", message: "路径越界：只允许访问项目目录内的文件（" + rel + "）" });
    return;
  }
  json(res, 404, { ok: false, error: "not_found", message: "文件不存在：" + rel });
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
 * 一次「项目内文件」请求的三种入口形态（见文件头的 ②③④）：
 *   query 形：rel 从 ?path= 取，项目键从 ?projectId= / ?port= 取
 *   path 形（③）：rel 从路径取，项目键**可选**（从查询串取；没有就只能靠「全根逐个试」）
 *   project 形（④）：项目键从路径第一段取，rel 是剩下的部分（相对子资源顺着它解析）
 */
interface FileRequest {
  /** query 形传 null（真值在 ?path=） */
  rel: string | null;
  /** path 形可以为空 —— 空 = 按「工作区根 + 所有项目根」逐个试（老行为） */
  projectKey: string | null;
  /** false = query 形（要注入 base）；true = 路径形（相对资源自己顺着 URL 走） */
  pathForm: boolean;
}

async function handleFile(
  url: URL, res: ServerResponse, svc: Services, json: JsonResponder, req: FileRequest,
): Promise<void> {
  const rel = normalizeRelPath(req.pathForm ? req.rel ?? "" : (url.searchParams.get("path") ?? ""));
  const projectKey = req.projectKey ?? url.searchParams.get("projectId") ?? url.searchParams.get("port") ?? null;

  if (!req.pathForm && !rel.trim()) {
    json(res, 400, { ok: false, error: "missing_path", message: "缺少 path 参数：/api/preview/file?path=outputs/demo/index.html" });
    return;
  }
  if (rel.includes("\0")) {
    json(res, 400, { ok: false, error: "bad_path", message: "路径里有非法字符" });
    return;
  }
  // 点文件 / 点目录一律不服务 —— 与 8008 的 /preview 同一份判据（preview-path.ts）。
  // 没有这道闸，面板同源这条路就成了「.env 的读取口」：8008 那边刚把 .env 挡在门外，
  // 而 /api/preview/* 是为「浏览器标签发不了自定义头」准备的、**不过令牌闸门**，
  // 于是这里必须自己把同一件事再做一遍（文本读取该走带令牌的 /api/projects/{port}/file）。
  if (hasDotSegment(rel)) {
    json(res, 403, { ok: false, error: "forbidden", message: "拒绝：预览不服务点文件 / 点目录（" + rel + "）" });
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
    // 能跑脚本的文档（html / svg / xml）一律进沙箱 —— 这条路由是**面板同源**且不过令牌闸门，
    // 不隔离的话，模型产出的 HTML 就是面板的同源文档（能读走令牌）。见 preview-path.ts。
    if (isRunnableDoc(type)) headers["Content-Security-Policy"] = PREVIEW_DOC_CSP;
    if (!req.pathForm && type.startsWith("text/html")) {
      // query 形态的 URL 里没有目录信息 —— 注入 <base> 指回「路径形态」，相对资源才找得到。
      // ⚠️ 基址里的 **query 不会被相对子资源继承**（RFC 3986；`<base href="…?projectId=3000">` 实测白写），
      // 所以有项目键时必须指到**项目作用域的路径形**（④）：项目跟着路径走，子资源才落对项目。
      // 这里必须用**没 realpath 过**的 file 算目录：real 可能带 /private 前缀，
      // relative 会算出 ".."（浏览器解析 base 时会把 ".." 吃掉，反而 404）。
      const dir = relative(resolve(root), file).split(/[\\/]/).slice(0, -1).join("/");
      const base = projectKey
        ? "/api/preview/project/" + encodeRel(projectKey) + "/" + (dir ? encodeRel(dir) + "/" : "")
        : "/api/preview/file/" + (dir ? encodeRel(dir) + "/" : "");
      headers["Content-Type"] = "text/html; charset=utf-8";
      res.writeHead(200, headers);
      res.end(injectBase(data.toString("utf8"), base));
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
