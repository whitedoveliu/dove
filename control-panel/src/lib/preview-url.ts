/**
 * 预览地址栏的纯逻辑 —— 输入归一化 / 外站是否走代理 / 项目文件 URL 拼装。
 *
 * 不依赖 React（只吃一个 ctx），方便直接用 node 喂字符串验证；
 * `getPanelOrigin()` 只在调用方没给 ctx.origin 时兜底（例如文件模块里没有 ctx）。
 *
 * 归一化规则表（输入 → 结果）：
 *   https://a.com/x        → 原样（http / https 才认）
 *   //a.com/x              → https://a.com/x（协议相对写法按 https 处理）
 *   localhost:3000         → http://localhost:3000/
 *   127.0.0.1:5173/x       → http://127.0.0.1:5173/x
 *   3000 / 3000/x / :3000  → http://<面板主机>:3000/…（纯端口 = 本机 http 服务）
 *   example.com            → http://example.com/（裸域名，无 scheme 默认 http）
 *   example.com:8080/x     → http://example.com:8080/x
 *   /foo、outputs/a.html    → 当前项目预览源（dev server / 老静态预览 / 项目文件路由）
 *   空                     → 报错（调用方按「清空」处理）
 *   file:///etc/passwd     → 报错：不支持的协议
 *   含空格 / 控制字符        → 报错
 *
 * 项目内文件有两份 URL，各管一段（为什么不能合成一份，见 projectFileUrl / projectAssetUrl）：
 *   · project 形 `/api/preview/project/<键>/<rel>`（面板同源）→ **HTML 文档**：相对子资源要靠它；
 *   · 8008 `/preview/<port>/<rel>?token=`（跨源）→ 图片 / 音视频 / PDF：没有相对子资源。
 * 下载（读响应体）走第三条：同源、令牌走头的 `/api/file/download`（见 lib/file-actions.ts）。
 */
import { getPanelOrigin } from "@/lib/api";
export interface PreviewContext {
  /** 当前项目（面板里就是端口号字符串） */
  projectId?: string | null;
  /** 当前正在显示的 URL —— 相对路径按它的源解析 */
  currentUrl?: string;
  /** 热更新端口（有的话相对路径优先落到它上面） */
  devServerPort?: string | null;
  /** 面板页面自己的 origin（同源 API 前缀），如 http://127.0.0.1:8790 */
  origin: string;
  /** 面板页面的 hostname，用于「纯端口」输入 */
  panelHost: string;
}

export type PreviewInput =
  | { ok: true; url: string; kind: "external" | "local" | "file" }
  | { ok: false; message: string };

/** 裸词尾段命中它 → 按「本地文件路径」而不是「域名」解释（report.html 不是域名） */
const FILE_EXT = new Set([
  "html", "htm", "xhtml", "css", "js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "jsonl", "map",
  "md", "markdown", "txt", "csv", "tsv", "xml", "yml", "yaml", "toml", "ini", "log", "env", "lock",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "pdf", "zip", "tar", "gz",
  "mp4", "mov", "webm", "mp3", "wav", "woff", "woff2", "ttf", "otf", "wasm",
  "sh", "py", "rb", "go", "rs", "java", "c", "h", "cpp",
]);

/** 是不是「host[:port]」的样子（不校验可达性） */
export function looksLikeHost(part: string): boolean {
  const host = String(part ?? "").replace(/:\d+$/, "");
  if (!host) return false;
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true;                       // [::1]
  if (/^localhost$/i.test(host) || /\.localhost$/i.test(host)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;                  // IPv4
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return false;
  const tld = host.slice(host.lastIndexOf(".") + 1).toLowerCase();
  return tld.length >= 2 && !FILE_EXT.has(tld);                            // 尾段像文件扩展名就不是域名
}

export type HostKind = "loopback" | "private" | "public";

/** 本机 / 内网 / 公网 —— 决定「直连还是走代理」 */
export function hostKind(hostname: string): HostKind {
  const h = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!h) return "loopback";
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::" || h === "0.0.0.0") return "loopback";
  if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal")) return "private";
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if ((a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "private";
    return "public";
  }
  return "public";
}

/** 面板同源的「项目文件」路由前缀 */
const FILE_PREFIX = "/api/preview/file/";
/** 面板同源的「项目作用域」路由前缀（项目键在路径里 —— HTML 预览专用） */
const PROJECT_PREFIX = "/api/preview/project/";
const PROXY_PREFIX = "/api/preview/proxy";

function tryUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

/** 每段单独 encode，保留 "/" 分隔（后端按路径分段解） */
export function encodeRelPath(rel: string): string {
  const s = String(rel ?? "").replace(/\\/g, "/");
  const tail = s.endsWith("/") ? "/" : "";
  return s.split("/").filter(Boolean).map(encodeURIComponent).join("/") + tail;
}

/** 拼「项目内文件」预览 URL（面板同源，不走代理） */
export function filePreviewUrl(rel: string, ctx: PreviewContext): string {
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
  const suffix = ctx.projectId ? "?projectId=" + encodeURIComponent(ctx.projectId) : "";
  return ctx.origin + FILE_PREFIX + encodeRelPath(clean) + suffix;
}

/**
 * 项目内文件的 URL —— **项目作用域写在路径里**（`/api/preview/project/<项目键>/<相对路径>`），
 * 面板同源，且**不需要令牌**（8790 的 /api/preview/* 在闸门之外，因为浏览器标签发不了自定义头）。
 *
 * 谁必须用它：**HTML 文档**（右侧「浏览器」标签的项目预览、文件模块里的 html、新窗口打开的 html）。
 * 为什么不能像图片那样走 8008 的 `/preview/{port}/…?token=`：HTML 里的 `./style.css`、
 * `<img src="img/x.png">` 是**相对 URL**，按文档 URL 的目录解析，**不会继承查询串** ——
 * 顶层那份文档带着令牌也没用，子资源照样 401（整页无样式、无脚本）。
 * 走同源之后子资源自然解析回同一个项目（`…/project/3000/dir/style.css`），
 * 由服务端按同一套边界（项目键 → resolve 判前缀 → realpath 复核 → 点段 403）自己读盘。
 *
 * 反过来的纪律：**没有相对子资源的东西不要走这里**（图片 / 音视频 / PDF 走 projectAssetUrl），
 * 它们走 8008 是跨源，拿不到面板同源的任何权限（DOM / localStorage / 免令牌的 API）。
 */
export function projectFileUrl(port: string, rel: string, ctx?: Pick<PreviewContext, "origin">): string {
  const origin = ctx?.origin || getPanelOrigin();
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
  return origin + PROJECT_PREFIX + encodeURIComponent(port) + "/" + encodeRelPath(clean);
}

/**
 * 项目内文件的**资源 URL**（给 <img> / <video> / <audio> / pdf 的 <iframe> 直接加载用）：
 * 8008 的 `/preview/{port}/{rel}?token=…`。
 *
 * 为什么是它而不是面板同源的 `/api/preview/project/…`：这些标签**发不了自定义头**，
 * 8008 的闸门只认 `X-Dove-Token` 或 `?token=`；而这条路径下的东西（图片 / 音视频 / PDF）
 * **没有相对子资源**，查询串带令牌就够 —— 于是让它们留在 8008（跨源）更安全：
 * 拿不到面板同源的 DOM / localStorage / 免令牌 API。HTML 文档不行，见 projectFileUrl。
 *
 * 令牌是**同步**取来的（`getLocalTokenCached()`）：渲染里不能发请求。还没取到就拼个不带令牌的
 * URL —— 那条请求 401，App 的提示条已经在说「没取到令牌」（不是静默失败）。
 * 闸门口径以 `legacy/server.ts` 为准（要令牌 / 不给 CORS `*` / 点文件 403 / Host 反 rebinding），
 * 面板这边的三种消费者分别是：① 本函数（顶层标签，查询串带令牌）；
 * ② HTML 文档的子资源（走 projectFileUrl，不经过这里）；
 * ③ 「下载 / 另存」的跨源 fetch（改走面板同源的 filePreviewUrl —— 没有 CORS 读不到响应体）。
 */
export function projectAssetUrl(port: string, rel: string, token = ""): string {
  const host = typeof window !== "undefined" ? window.location.hostname : "127.0.0.1";
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
  const suffix = token ? "?token=" + encodeURIComponent(token) : "";
  return `http://${host}:8008/preview/${encodeURIComponent(port)}/${encodeRelPath(clean)}${suffix}`;
}

/**
 * 同源文件 URL → 项目内相对路径；不是就返回 null。
 * 认两种形态：`/api/preview/file/<rel>?projectId=`（query 形）与
 * `/api/preview/project/<键>/<rel>`（项目路径形）。项目根（rel 为空）显示成 "/"。
 */
export function fileRelOf(target: string, ctx: PreviewContext): string | null {
  if (!target) return null;
  let u: URL;
  try { u = new URL(target, ctx.origin); } catch { return null; }
  if (u.origin !== ctx.origin) return null;
  const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
  if (u.pathname.startsWith(FILE_PREFIX)) return decode(u.pathname.slice(FILE_PREFIX.length));
  if (u.pathname.startsWith(PROJECT_PREFIX)) {
    const rest = decode(u.pathname.slice(PROJECT_PREFIX.length));
    const slash = rest.indexOf("/");
    const rel = slash === -1 ? "" : rest.slice(slash + 1);
    return rel || "/";
  }
  return null;
}

/** 外站 → 同源代理 URL；本机 / 内网 / 面板同源 → 原样直连 */
export function frameSrcFor(target: string, ctx: PreviewContext): string {
  if (!target) return "";
  let u: URL;
  try { u = new URL(target, ctx.origin); } catch { return target; }
  if (u.origin === ctx.origin) return target;
  if (u.protocol !== "http:" && u.protocol !== "https:") return target;
  if (hostKind(u.hostname) !== "public") return target;
  return ctx.origin + PROXY_PREFIX + "?url=" + encodeURIComponent(u.href);
}

/** 这个地址是不是走了代理 */
export function isProxied(target: string, ctx: PreviewContext): boolean {
  const src = frameSrcFor(target, ctx);
  return src !== target && src.includes(PROXY_PREFIX);
}

/** 地址栏里显示什么：项目文件显示相对路径，老预览剥掉 /preview/{port}，外站原样 */
export function addressOf(target: string, ctx: PreviewContext): string {
  if (!target) return "";
  const fileRel = fileRelOf(target, ctx);
  if (fileRel !== null) return fileRel;
  let u: URL;
  try { u = new URL(target, ctx.origin); } catch { return target; }
  if (u.origin === ctx.origin) return (u.pathname || "/") + u.search;
  const legacy = /^\/preview\/[^/]+(\/.*)?$/.exec(u.pathname);
  if (legacy && u.port === "8008") return legacy[1] || "/";
  if (u.hostname === ctx.panelHost) return (u.port ? ":" + u.port : "") + (u.pathname || "/") + u.search;
  return u.href;
}

/** 文件路径是不是能当网页渲染 */
export function isHtmlPath(p: string): boolean {
  const clean = String(p ?? "").split(/[?#]/)[0]!.replace(/\\/g, "/").toLowerCase();
  return /\.(html?|xhtml)$/.test(clean);
}

/** 「当前项目预览源」—— 有 dev server / 老静态预览时，相对路径落到它上面 */
function projectSourceBase(ctx: PreviewContext): string | null {
  const cur = ctx.currentUrl ?? "";
  if (cur) {
    try {
      const u = new URL(cur, ctx.origin);
      if (u.origin !== ctx.origin && hostKind(u.hostname) !== "public") {
        const legacy = /^\/preview\/([^/]+)\//.exec(u.pathname);
        if (legacy) return u.origin + "/preview/" + legacy[1] + "/";
        return u.origin + (u.pathname.endsWith("/") ? u.pathname : u.pathname.replace(/[^/]*$/, ""));
      }
    } catch { /* 当前地址不是合法 URL —— 往下走文件路由 */ }
  }
  if (ctx.devServerPort) return "http://" + ctx.panelHost + ":" + ctx.devServerPort + "/";
  return null;
}

/** 相对路径 → 完整 URL */
function resolveRelative(raw: string, ctx: PreviewContext): PreviewInput {
  const cleaned = raw.replace(/\\/g, "/");
  const base = projectSourceBase(ctx);
  if (base) {
    try {
      const u = new URL(cleaned.replace(/^\/+/, ""), base);
      return { ok: true, url: u.href, kind: "local" };
    } catch {
      return { ok: false, message: "路径不合法：" + raw };
    }
  }
  if (!ctx.projectId) {
    return { ok: false, message: "还没有打开项目，请输入完整网址（例如 http://127.0.0.1:3000）" };
  }
  // 项目文件路由：以 / 开头 = 项目根；否则相对当前预览文件所在目录
  const current = fileRelOf(ctx.currentUrl ?? "", ctx);
  let rel = cleaned;
  if (!cleaned.startsWith("/") && current) {
    rel = current.replace(/[^/]*$/, "") + cleaned;
  } else {
    rel = cleaned.replace(/^\/+/, "");
  }
  // 项目键写进路径（project 形）：页面里再点相对链接 / 加载相对子资源都还落在同一个项目里
  // （query 形会把这些子请求变成「无项目的相对路径」，只能靠逐个根去猜，见 routes-preview.ts 文件头）。
  return { ok: true, url: projectFileUrl(ctx.projectId, rel, ctx), kind: "file" };
}

export function normalizePreviewInput(input: string, ctx: PreviewContext): PreviewInput {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, message: "请输入网址或路径" };
  if (/\s/.test(raw)) return { ok: false, message: "网址里不能有空格：" + raw };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, message: "网址里有控制字符" };

  // ① scheme://authority
  const scoped = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  if (scoped) {
    const proto = scoped[1]!.toLowerCase();
    if (proto !== "http" && proto !== "https") return { ok: false, message: "不支持的协议 " + proto + ":（只认 http / https）" };
    const u = tryUrl(raw);
    if (!u || !u.hostname) return { ok: false, message: "不是合法的网址：" + raw };
    return { ok: true, url: u.href, kind: hostKind(u.hostname) === "public" ? "external" : "local" };
  }

  // ② 其它 scheme（file: / data: / javascript: / mailto: …）；host:port 不算
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z0-9-]+(\.[a-z0-9-]+)*:\d+([/?#]|$)/i.test(raw)) {
    const proto = raw.slice(0, raw.indexOf(":")).toLowerCase();
    return { ok: false, message: "不支持的协议 " + proto + ":（只认 http / https）" };
  }

  // ③ 协议相对 //host/path → 按 https
  if (raw.startsWith("//")) {
    const u = tryUrl("https:" + raw);
    if (!u || !u.hostname) return { ok: false, message: "不是合法的网址：" + raw };
    return { ok: true, url: u.href, kind: hostKind(u.hostname) === "public" ? "external" : "local" };
  }

  // ④ 纯端口（3000 / 3000/x / :3000）
  const portOnly = /^:?(\d{1,5})([/?#].*)?$/.exec(raw);
  if (portOnly) {
    const port = Number(portOnly[1]);
    if (port > 0 && port <= 65535) {
      return { ok: true, url: "http://" + ctx.panelHost + ":" + port + (portOnly[2] ?? "/"), kind: "local" };
    }
    return { ok: false, message: "端口号超出范围：" + raw };
  }

  // ⑤ host[:port][/path]
  const firstSeg = raw.split(/[/?#]/)[0] ?? "";
  if (looksLikeHost(firstSeg)) {
    const u = tryUrl("http://" + raw);
    if (!u || !u.hostname) return { ok: false, message: "不是合法的网址：" + raw };
    return { ok: true, url: u.href, kind: hostKind(u.hostname) === "public" ? "external" : "local" };
  }

  // ⑥ 相对路径 → 当前项目预览源
  return resolveRelative(raw, ctx);
}
