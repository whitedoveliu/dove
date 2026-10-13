/**
 * 老契约：项目**目录与文件**读路由（从 routes-project.ts 抽出来 —— 那边顶到 400 行上限了）。
 *
 * 三条的分工别混：
 *   · /files  列目录（懒加载的目录树用，一次一层）
 *   · /stat   单文件元信息（大小 / 修改时间）—— 不读正文，永不因「太大」被拒
 *   · /file   单文件正文 —— 默认 >512KB 拒；带 limit=N 时只读前 N 字节并标 truncated
 *
 * 三条的 `path`（相对项目根）都过**同一道硬闸**：resolve → 存在性 → realpath（见 path-guard.ts）。
 * 以前只做 `join(proj.path, sub)`，实测 `?path=../../../../../../etc/hosts` 直接 200 把整份
 * 系统文件吐了出来 —— 越界一律 403，且不告诉调用方目标在不在。
 *
 * ⚠️ 字段名逐字对齐 control-panel/src/lib/api.ts 的接口（readProjectFile / ProjectFileEntry）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { lstatSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, type Stats } from "node:fs";
import { extname, join, relative } from "node:path";
import type { Services } from "../bootstrap.ts";
import { json, portToProject } from "./server.ts";
import { LANG, HIDDEN } from "./routes-project-parts.ts";
import { guardInsideProject, normalizeSubPath, realOrNull, inside, type ProjectPathFail } from "./path-guard.ts";

/** 只读文件开头 N 字节（大文本的「只显示前 N KB」用它；整段 readFileSync 会把百兆日志吃进内存） */
function readHead(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** 三条路由的越界 / 不存在回包：403 的文案来自 path-guard，404 用各自的说法（老契约的原话） */
function failPath(res: ServerResponse, g: ProjectPathFail, notFound: string): void {
  json(res, g.status, { success: false, message: g.status === 404 ? notFound : g.message });
}

export async function handleProjectFileRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  // ── GET /api/projects/{port}/files?path= ───────────
  const filesMatch = /^\/api\/projects\/([^/]+)\/files$/.exec(path);
  if (filesMatch && req.method === "GET") {
    const proj = portToProject(svc, Number(filesMatch[1]));
    if (!proj) { json(res, 404, { success: false, message: `项目 ${filesMatch[1]} 不存在` }); return true; }
    const sub = normalizeSubPath(url.searchParams.get("path"));
    const g = guardInsideProject(svc, proj.id, sub);
    if (!g.ok) { failPath(res, g, `目录不存在: ${sub}`); return true; }
    const dir = g.abs;
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
    if (!isDir) { json(res, 404, { success: false, message: `目录不存在: ${sub}` }); return true; }
    try {
      const realRoot = realOrNull(proj.path) ?? proj.path;
      const names = readdirSync(dir).filter((n) => !HIDDEN.has(n) && !n.startsWith(".sb-"));
      const entries = names.flatMap((n) => {
        const abs = join(dir, n);
        const rel = relative(proj.path, abs).split("\\").join("/");
        let lst: Stats | null = null;
        try { lst = lstatSync(abs); } catch { return []; }
        // 软链先判：指向项目外的**不列**（它不是一个能点的入口 —— 点开就是 403）。
        // 判不了真实路径的坏软链不在这里丢，交给下面 stat 那条路降级成 size 0 的条目。
        if (lst.isSymbolicLink()) {
          const real = realOrNull(abs);
          if (real && !inside(realRoot, real)) return [];
        }
        // stat 失败（坏软链 / 列目录与 stat 之间被删）只让**这一条**降级：
        // 整个目录列表 500 才是真的事故（面板的目录树会整层变红），而一条坏链是常态。
        let st: Stats | null = null;
        try { st = statSync(abs); } catch { /* 见上：降级成 size 0 的文件条目 */ }
        if (st?.isDirectory()) {
          let hasChildren = false;
          try { hasChildren = readdirSync(abs).some((x) => !HIDDEN.has(x)); } catch { /* 读不动就当空目录 */ }
          return [{ name: n, path: rel, type: "dir" as const, has_children: hasChildren }];
        }
        return [{
          name: n, path: rel, type: "file" as const,
          size: st?.size ?? 0,                                     // 0 = 拿不到（坏软链），不是真空文件
          modified: st ? Math.floor(st.mtimeMs / 1000) : 0,
          language: LANG[extname(n).toLowerCase()] ?? null,
        }];
      });
      // 目录在前、文件在后，组内按名字小写升序（前端依赖这个顺序）
      entries.sort((a, b) => (a.type === b.type ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.type === "dir" ? -1 : 1));
      json(res, 200, { success: true, port: String(filesMatch[1]), path: sub, entries, truncated: entries.length > 2000 });
    } catch (e) {
      json(res, 500, { success: false, message: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // ── GET /api/projects/{port}/stat?path= ────────────
  //
  // 单文件元信息（大小 / 修改时间）—— 面板「文件模块」的两处需要：
  //   · 图片 / 音视频 / PDF / office 这类**不读正文**的类型，界面只要元信息 + 打开方式；
  //   · 文本先问大小再决定读多少（避免把超大日志整段塞进 DOM）。
  const statMatch = /^\/api\/projects\/([^/]+)\/stat$/.exec(path);
  if (statMatch && req.method === "GET") {
    const proj = portToProject(svc, Number(statMatch[1]));
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }
    const sub = normalizeSubPath(url.searchParams.get("path"));
    if (!sub) { json(res, 400, { success: false, message: "缺少 path" }); return true; }
    const g = guardInsideProject(svc, proj.id, sub);
    if (!g.ok) { failPath(res, g, `文件不存在: ${sub}`); return true; }
    try {
      const st = statSync(g.abs);
      json(res, 200, {
        success: true, path: sub, name: sub.split("/").pop() ?? sub,
        type: st.isDirectory() ? "dir" : "file",
        size: st.size,
        // 秒（与 /files 的 modified 同口径）—— 面板统一 ×1000 还原
        modified: Math.floor(st.mtimeMs / 1000),
        language: LANG[extname(sub).toLowerCase()] ?? null,
      });
    } catch (e) {
      json(res, 500, { success: false, message: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // ── GET /api/projects/{port}/file?path=[&limit=] ───
  const fileMatch = /^\/api\/projects\/([^/]+)\/file$/.exec(path);
  if (fileMatch && req.method === "GET") {
    const proj = portToProject(svc, Number(fileMatch[1]));
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }
    const sub = normalizeSubPath(url.searchParams.get("path"));
    if (!sub) { json(res, 400, { success: false, message: "缺少 path" }); return true; }
    const g = guardInsideProject(svc, proj.id, sub);
    if (!g.ok) { failPath(res, g, `文件不存在: ${sub}`); return true; }
    const abs = g.abs;
    const st = statSync(abs);
    const name = sub.split("/").pop() ?? sub;
    const language = LANG[extname(sub).toLowerCase()] ?? null;

    // 可选 limit=N（字节）：只看前 N 字节。不传 = 老行为（>512KB 拒）。
    // truncated=true 时 size 仍是**完整**大小 —— 界面据此提示「只显示前 N KB / 共多大」。
    const limitRaw = Number(url.searchParams.get("limit") ?? "0");
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 8 * 1024 * 1024) : 0;
    if (limit > 0) {
      json(res, 200, {
        success: true, path: sub, name, size: st.size, language,
        content: st.size > limit ? readHead(abs, limit) : readFileSync(abs, "utf8"),
        truncated: st.size > limit,
      });
      return true;
    }

    if (st.size > 512 * 1024) { json(res, 413, { success: false, message: "文件超过 512KB，不预览" }); return true; }
    json(res, 200, { success: true, path: sub, name, size: st.size, language, content: readFileSync(abs, "utf8") });
    return true;
  }

  return false;
}
