/**
 * 静态文件服务回退（预览用：项目没有 dev 脚本时直接当静态站点发）
 *
 * 为什么需要：不是每个项目都有 dev 脚本（纯静态站点、PPT 产物目录、生成的报告…）。
 * 没有 dev 脚本时不该报「预览失败」，而应该直接把这些文件服务起来。
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, resolve, relative } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".pdf": "application/pdf",
};

export interface StaticServerHandle { url: string; port: number; stop(): void }

/** 起一个只读静态服务；只允许访问 root 内的文件 */
export async function startStaticServer(root: string, port: number, host = "127.0.0.1"): Promise<StaticServerHandle> {
  const rootAbs = resolve(root);
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const abs = normalize(join(rootAbs, rel));
      // 路径逃逸防护
      const r = relative(rootAbs, abs);
      if (r.startsWith("..") || resolve(abs) === resolve("/")) { res.writeHead(403); res.end("forbidden"); return; }

      let target = abs;
      let st;
      try { st = await stat(target); } catch { st = null; }
      if (st?.isDirectory()) { target = join(target, "index.html"); try { st = await stat(target); } catch { st = null; } }
      if (!st?.isFile()) {
        // 目录列表（方便看产物目录里有啥）
        const { readdir } = await import("node:fs/promises");
        const dir = st?.isDirectory() ? abs : rootAbs;
        const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const list = items.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? "/" : ""}">${e.name}${e.isDirectory() ? "/" : ""}</a></li>`).join("");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><meta charset="utf-8"><title>Dove 预览</title><body style="font:14px -apple-system,sans-serif;padding:24px"><h3>预览：${rel}</h3><ul>${list}</ul></body>`);
        return;
      }
      const data = await readFile(target);
      res.writeHead(200, { "Content-Type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => res());
  });

  return {
    url: `http://${host}:${port}`,
    port,
    stop: () => { try { server.close(); } catch { /* ignore */ } },
  };
}
