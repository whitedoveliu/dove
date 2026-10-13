/**
 * 外站代理（面板右侧「浏览器」标签用）—— 同源 GET /api/preview/proxy?url=…
 *
 * 为什么需要：外站几乎都带 X-Frame-Options / CSP frame-ancestors，
 * 直接把 URL 塞进 iframe 必然白屏。这里由服务端取回页面、剥掉「不许被 frame」
 * 的响应头、注入 <base>，页面就能显示，而且子资源仍然直接打到源站
 * （子资源不受 frame 限制）。
 *
 * 安全线（SSRF）：只放行 http/https；目标主机解析出来的每个 IP 命中回环 / 内网 /
 * 链路本地 / 保留段一律拒绝。DOVE_PREVIEW_PROXY_ALLOW_PRIVATE=1 可关掉（局域网调试）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { isRunnableDoc, PREVIEW_DOC_CSP } from "./preview-path.ts";

export type JsonResponder = (res: ServerResponse, code: number, data: unknown) => void;

/** 代理：超时 / 单响应体积上限 / 最大跳转次数 */
const TIMEOUT_MS = Number(process.env.DOVE_PREVIEW_TIMEOUT_MS ?? 20_000);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const ALLOW_PRIVATE = process.env.DOVE_PREVIEW_PROXY_ALLOW_PRIVATE === "1";
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * 回传时**必须丢掉**的响应头：
 *   x-frame-options / content-security-policy(_report_only) —— 就是它们让 iframe 白屏
 *   content-encoding / content-length / transfer-encoding   —— body 已被 Node 解压并可能改写
 *   set-cookie                                              —— 别把源站 Cookie 带进面板上下文
 */
const DROP_HEADERS = new Set([
  "x-frame-options", "content-security-policy", "content-security-policy-report-only",
  "content-encoding", "content-length", "transfer-encoding", "connection",
  "set-cookie", "set-cookie2", "strict-transport-security", "report-to", "nel",
]);

type Failure = { ok: false; code: number; error: string; message: string };

export function msgOf(e: unknown): string {
  if (e instanceof Error) return (e.cause instanceof Error ? e.cause.message : e.message) || e.name;
  return String(e);
}

export function parseHttpUrl(raw: string): { ok: true; url: URL } | Failure {
  let candidate = String(raw ?? "").trim();
  if (!candidate) {
    return { ok: false, code: 400, error: "missing_url", message: "缺少 url 参数：/api/preview/proxy?url=https%3A%2F%2Fexample.com" };
  }
  // 容错：后端也接受裸域名（面板正常会补好 scheme）
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = "http://" + candidate;
  let u: URL;
  try { u = new URL(candidate); }
  catch { return { ok: false, code: 400, error: "bad_url", message: "不是合法的 URL：" + raw }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    const shown = u.protocol.replace(/:$/, "");
    return { ok: false, code: 400, error: "bad_scheme", message: "只支持 http / https，收到 " + shown + ":（" + raw + "）" };
  }
  if (!u.hostname) return { ok: false, code: 400, error: "bad_url", message: "URL 里没有主机名：" + raw };
  return { ok: true, url: u };
}

/** 命中就返回中文原因；公开地址返回 null */
export function blockedIpReason(ip: string): string | null {
  const v = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (v === "::1") return "IPv6 回环";
  if (v === "::" || v === "0.0.0.0") return "通配地址";
  const v4 = v.startsWith("::ffff:") ? v.slice(7) : v;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0) return "保留段 0.0.0.0/8";
    if (a === 10) return "内网 10.0.0.0/8";
    if (a === 127) return "本机回环 127.0.0.0/8";
    if (a === 169 && b === 254) return "链路本地 169.254.0.0/16";
    if (a === 172 && b >= 16 && b <= 31) return "内网 172.16.0.0/12";
    if (a === 192 && b === 168) return "内网 192.168.0.0/16";
    if (a === 100 && b >= 64 && b <= 127) return "运营商内网 100.64.0.0/10";
    if (a === 198 && (b === 18 || b === 19)) return "基准测试段 198.18.0.0/15";
    if (a >= 224) return "组播 / 保留段";
    return null;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(v)) return "IPv6 唯一本地地址 fc00::/7";
  if (/^fe[89ab][0-9a-f]:/.test(v)) return "IPv6 链路本地 fe80::/10";
  return null;
}

/** 目标是否可以被代理（防 SSRF）。字面 IP 直接判，域名把解析结果全判一遍。 */
export async function assertProxyable(u: URL): Promise<{ ok: true } | Failure> {
  if (ALLOW_PRIVATE) return { ok: true };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    const reason = blockedIpReason(host);
    return reason
      ? { ok: false, code: 403, error: "blocked_target", message: "拒绝代理本机 / 内网地址 " + host + "（" + reason + "）" }
      : { ok: true };
  }
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); }
  catch (e) {
    return { ok: false, code: 502, error: "dns_failed", message: "域名解析失败 " + host + "：" + msgOf(e) };
  }
  if (addrs.length === 0) {
    return { ok: false, code: 502, error: "dns_failed", message: "域名解析失败 " + host + "：没有返回任何地址" };
  }
  for (const a of addrs) {
    const reason = blockedIpReason(a.address);
    if (reason) {
      return { ok: false, code: 403, error: "blocked_target", message: host + " 解析到 " + a.address + "（" + reason + "），代理已拒绝" };
    }
  }
  return { ok: true };
}

async function cancelBody(r: Response): Promise<void> {
  try { await r.body?.cancel(); } catch { /* 已经读完 / 已关闭 */ }
}

function upstreamHeaders(req: IncomingMessage): Record<string, string> {
  // 不转发 cookie / authorization：面板的凭据是给 Dove 自己的，不该流到外站
  return {
    "user-agent": String(req.headers["user-agent"] ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) DovePreview/1.0 Safari/537.36"),
    accept: String(req.headers["accept"] ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
    "accept-language": String(req.headers["accept-language"] ?? "zh-CN,zh;q=0.9,en;q=0.8"),
  };
}

function passthroughHeaders(upstream: Response, contentType: string): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (DROP_HEADERS.has(key.toLowerCase())) return;
    out[key] = value;
  });
  out["content-type"] = contentType;
  out["cache-control"] = "no-store";
  return out;
}

/** 原始 URL 所在目录（根路径就是 origin）—— 页面里的相对链接按它解析 */
export function baseHrefOf(u: URL): string {
  try { return new URL(".", u).href; } catch { return u.origin + "/"; }
}

/** 在 <head> 里塞 <base>；页面自己已经有 base 就尊重它 */
export function injectBase(html: string, baseHref: string): string {
  if (!baseHref) return html;
  if (/<base[\s>/]/i.test(html)) return html;
  const tag = '<base href="' + baseHref.replace(/"/g, "&quot;") + '">';
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

/** 浏览器直接导航（Accept 带 text/html）看可读的错误页；面板探针拿结构化 JSON */
export function respondError(
  res: ServerResponse, req: IncomingMessage, json: JsonResponder,
  code: number, error: string, message: string, target: string,
): void {
  const accept = String(req.headers["accept"] ?? "");
  if (!accept.includes("text/html")) {
    json(res, code, { ok: false, error, message });
    return;
  }
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    '<!DOCTYPE html><meta charset="utf-8"><title>预览代理 ' + code + "</title>" +
    "<body style=\"margin:0;font:14px/1.7 -apple-system,'PingFang SC',sans-serif;background:#0f1115;color:#e6e8ee\">" +
    "<div style=\"max-width:640px;margin:12vh auto;padding:24px\">" +
    "<div style=\"font-size:13px;color:#8b93a7\">Dove 预览代理</div>" +
    "<h1 style=\"font-size:20px;margin:8px 0 4px\">打不开这个页面（HTTP " + code + "）</h1>" +
    "<p style=\"color:#c3c9d8;margin:12px 0\">" + escapeHtml(message) + "</p>" +
    "<p style=\"font-family:ui-monospace,monospace;font-size:12px;color:#8b93a7;word-break:break-all;margin:12px 0\">" + escapeHtml(target) + "</p>" +
    "<p style=\"font-size:12px;color:#6f7789\">错误码 " + escapeHtml(error) + " —— 检查网址是否正确、目标站点是否可访问。</p>" +
    "</div></body>",
  );
}

/** GET /api/preview/proxy?url=…&probe=1 */
export async function handleProxy(url: URL, req: IncomingMessage, res: ServerResponse, json: JsonResponder): Promise<void> {
  const raw = url.searchParams.get("url") ?? "";
  const probe = url.searchParams.get("probe") === "1";
  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) { respondError(res, req, json, parsed.code, parsed.error, parsed.message, raw); return; }

  let target = parsed.url;
  let upstream: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guard = await assertProxyable(target);
    if (!guard.ok) { respondError(res, req, json, guard.code, guard.error, guard.message, target.href); return; }

    let r: Response;
    try {
      r = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: upstreamHeaders(req),
      });
    } catch (e) {
      respondError(res, req, json, 502, "target_unreachable", "无法访问 " + target.origin + "：" + msgOf(e), target.href);
      return;
    }

    if (REDIRECT_CODES.has(r.status)) {
      const location = r.headers.get("location");
      await cancelBody(r);
      if (!location) {
        respondError(res, req, json, 502, "bad_redirect", target.href + " 返回 " + r.status + " 但没有 Location", target.href);
        return;
      }
      let next: URL;
      try { next = new URL(location, target); }
      catch { respondError(res, req, json, 502, "bad_redirect", "重定向目标不合法：" + location, target.href); return; }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        respondError(res, req, json, 400, "bad_redirect_scheme", "重定向到了不支持的协议 " + next.protocol, target.href);
        return;
      }
      target = next;
      continue;
    }
    upstream = r;
    break;
  }

  if (!upstream) {
    respondError(res, req, json, 502, "too_many_redirects", "重定向超过 " + MAX_REDIRECTS + " 次，已放弃", target.href);
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";

  // 探针 / HEAD：只为了拿「能不能打开」的结论，不下载 body
  if (probe || req.method === "HEAD") {
    await cancelBody(upstream);
    if (probe) json(res, 200, { ok: true, status: upstream.status, contentType, finalUrl: target.href });
    else { res.writeHead(upstream.status, passthroughHeaders(upstream, contentType)); res.end(); }
    return;
  }

  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await cancelBody(upstream);
    respondError(res, req, json, 502, "too_large", "目标响应太大（" + declared + " 字节，上限 " + MAX_BYTES + "）", target.href);
    return;
  }

  let body: Buffer;
  try { body = Buffer.from(await upstream.arrayBuffer()); }
  catch (e) {
    respondError(res, req, json, 502, "body_failed", "读取目标响应失败：" + msgOf(e), target.href);
    return;
  }
  if (body.byteLength > MAX_BYTES) {
    respondError(res, req, json, 502, "too_large", "目标响应太大（" + body.byteLength + " 字节）", target.href);
    return;
  }

  const headers = passthroughHeaders(upstream, contentType);
  // 外站文档同样是「不可信内容」，而且**它跑在面板同源**（代理就是为了绕过 frame 限制才同源的）——
  // 不加沙箱的话，用户随手打开的任何公网页面都能 `fetch('/api/local-token')` 读走令牌。
  // 判据与理由见 preview-path.ts 的 PREVIEW_DOC_CSP（面板里 8790 的两条预览路由用的是同一个常量）。
  if (isRunnableDoc(contentType)) headers["content-security-policy"] = PREVIEW_DOC_CSP;
  const isHtml = /^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType);
  if (isHtml) {
    headers["content-type"] = contentType.replace(/;\s*charset=[^;]*/i, "") + "; charset=utf-8";
    res.writeHead(upstream.status, headers);
    res.end(injectBase(body.toString("utf8"), baseHrefOf(target)));
    return;
  }
  res.writeHead(upstream.status, headers);
  res.end(body);
}
