/**
 * 老契约：项目 / 历史 / 版本 路由
 *
 * 字段名严格对齐 control-panel/src/lib/api.ts 的 interface（逐字提取）。
 * ⚠️ 最容易写错的三处（写错界面就废，但不会报错）：
 *  ① /api/history 的 is_modified —— **前端版本号的唯一来源**
 *  ② /api/history 的 commit_hash —— 没有它版本条是灰的、点不动
 *  ③ 时间格式必须是 "YYYY-MM-DD HH:MM:SS"（非 ISO）
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join, extname, relative, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type { Services } from "../bootstrap.ts";

import { json, readBody, toLegacyProject, projectIdToPort, portToProject } from "./server.ts";
import { LANG, HIDDEN, localTime, partsToEvents, didModify } from "./routes-project-parts.ts";


export async function handleProjectRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  // ── GET /api/projects ──────────────────────────────
  if (path === "/api/projects" && req.method === "GET") {
    json(res, 200, { projects: svc.projects.list().map((p) => toLegacyProject(svc, p)) });
    return true;
  }

  // ── GET /api/projects/{port}/exists ────────────────
  const existsMatch = /^\/api\/projects\/([^/]+)\/exists$/.exec(path);
  if (existsMatch && req.method === "GET") {
    const port = Number(existsMatch[1]);
    const proj = portToProject(svc, port);
    json(res, 200, {
      exists: !!proj, port: String(port), running: false, actual_port: null,
      requested_port_in_use: false, requested_port_owned: false,
    });
    return true;
  }

  // ── POST /api/projects/{port}/start | stop | restart ──
  // ⚠️ pagehide 时前端用 sendBeacon(path, "{}")，Content-Type 是 text/plain，
  //    所以这里**不能强制解析 JSON body**。
  const lifeMatch = /^\/api\/projects\/([^/]+)\/(start|stop|restart)$/.exec(path);
  if (lifeMatch && req.method === "POST") {
    const port = Number(lifeMatch[1]);
    const proj = portToProject(svc, port);
    if (!proj) { json(res, 404, { success: false, message: `项目 ${lifeMatch[1]} 不存在` }); return true; }
    const op = lifeMatch[2]!;
    try {
      if (op === "stop") {
        svc.projects.stopPreview(proj.id);
        json(res, 200, { success: true, message: "已停止开发服务器", actual_port: null });
      } else {
        if (op === "restart") svc.projects.stopPreview(proj.id);
        const r = await svc.projects.startPreview(proj.id);
        json(res, 200, {
          success: true,
          message: r ? `开发服务器已启动：${r.url}` : "项目还没有可启动的预览",
          actual_port: r ? String(r.port) : null,
          requested_port_conflict: false,
        });
      }
    } catch (e) {
      json(res, 500, { success: false, message: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // ── GET /api/projects/{port}/files?path= ───────────
  const filesMatch = /^\/api\/projects\/([^/]+)\/files$/.exec(path);
  if (filesMatch && req.method === "GET") {
    const proj = portToProject(svc, Number(filesMatch[1]));
    if (!proj) { json(res, 404, { success: false, message: `项目 ${filesMatch[1]} 不存在` }); return true; }
    const sub = url.searchParams.get("path") ?? "";
    const dir = sub ? join(proj.path, sub) : proj.path;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      json(res, 404, { success: false, message: `目录不存在: ${sub}` });
      return true;
    }
    try {
      const names = readdirSync(dir).filter((n) => !HIDDEN.has(n) && !n.startsWith(".sb-"));
      const entries = names.map((n) => {
        const abs = join(dir, n);
        const st = statSync(abs);
        const rel = relative(proj.path, abs).split("\\").join("/");
        return st.isDirectory()
          ? { name: n, path: rel, type: "dir" as const, has_children: readdirSync(abs).some((x) => !HIDDEN.has(x)) }
          : { name: n, path: rel, type: "file" as const, size: st.size, modified: Math.floor(st.mtimeMs / 1000), language: LANG[extname(n).toLowerCase()] ?? null };
      });
      // 目录在前、文件在后，组内按名字小写升序（前端依赖这个顺序）
      entries.sort((a, b) => (a.type === b.type ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.type === "dir" ? -1 : 1));
      json(res, 200, { success: true, port: String(filesMatch[1]), path: sub, entries, truncated: entries.length > 2000 });
    } catch (e) {
      json(res, 500, { success: false, message: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // ── GET /api/projects/{port}/file?path= ────────────
  const fileMatch = /^\/api\/projects\/([^/]+)\/file$/.exec(path);
  if (fileMatch && req.method === "GET") {
    const proj = portToProject(svc, Number(fileMatch[1]));
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }
    const sub = url.searchParams.get("path") ?? "";
    if (!sub) { json(res, 400, { success: false, message: "缺少 path" }); return true; }
    const abs = join(proj.path, sub);
    if (!existsSync(abs)) { json(res, 404, { success: false, message: `文件不存在: ${sub}` }); return true; }
    const st = statSync(abs);
    if (st.size > 512 * 1024) { json(res, 413, { success: false, message: "文件超过 512KB，不预览" }); return true; }
    json(res, 200, {
      success: true, path: sub, name: sub.split("/").pop() ?? sub, size: st.size,
      language: LANG[extname(sub).toLowerCase()] ?? null,
      content: readFileSync(abs, "utf8"),
    });
    return true;
  }

  // ── POST /api/projects/{port}/delete ───────────────
  //
  // **彻底删除**：项目目录（含 .git 版本、.logs、.spill）+ 数据库记录。
  //
  // ⚠️ 这是不可逆操作。所以有两道保护：
  //    ① 路径必须在 workspaceRoot **之内**，且是它的直接子目录 ——
  //       否则一个配置写错就可能 rm -rf 到别处去。做不到就**拒绝删**，
  //       只清数据库（宁可留垃圾也不能误删）。
  //    ② 前端有二次确认，文案写明不可恢复。
  //
  // 刻意**不删** memories / activity_* —— 那些是跨项目的全局数据
  // （用户的长期记忆、屏幕历史），删一个任务不该连带清掉。
  const delMatch = /^\/api\/projects\/([^/]+)\/delete$/.exec(path);
  if (delMatch && req.method === "POST") {
    const key = decodeURIComponent(delMatch[1]!);
    // ⚠️ 三种 key 依次尝试：端口 → 项目 id → 目录名。
    // 导入/接入的项目**没有端口**（port 是 0），只按端口找必然 404 ——
    // 用户点删除会看到「删除失败 HTTP 404」。实测踩过。
    // 目录名是最后兜底：它和 id 不一定相同，但至少能覆盖老前端。
    let proj = portToProject(svc, Number(key));
    if (!proj) {
      const hit = svc.projects.get(key)
        ?? svc.projects.list().find((p) => p.path.split("/").filter(Boolean).pop() === key);
      if (hit) proj = { id: hit.id, name: hit.name, path: hit.path, port: hit.port };
    }
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }

    try { svc.preview?.stop?.(proj.id); } catch { /* 端口占着也要继续 */ }

    // 数据库：threads（连带 messages）+ projects
    let threads = 0;
    try {
      const ids = svc.db.all("SELECT id FROM threads WHERE project_id = ?", proj.id);
      for (const r of ids) { svc.store.deleteThread(String(r.id)); threads++; }
    } catch { /* ignore */ }

    // 文件系统：先校验再删
    const root = resolve(svc.cfg.workspaceRoot);
    const target = resolve(proj.path);
    const safe = target.startsWith(root + "/") && dirname(target) === root && basename(target).length > 0;
    let removedDir = false;
    let dirError = "";
    if (!safe) {
      dirError = `路径不在工作区内，已跳过文件删除（${target}）`;
      console.warn(`[delete] ${dirError}`);
    } else if (existsSync(target)) {
      try { rmSync(target, { recursive: true, force: true }); removedDir = true; }
      catch (e) { dirError = `删目录失败：${String(e).slice(0, 120)}`; }
    }

    const ok = svc.projects.remove(proj.id);
    // ⚠️ 破坏性操作**必须留痕**。
    // 之前只在不安全路径时打 warn，成功删除**一条日志都没有** ——
    // 后来发现任务少了却查不出是谁删的、什么时候删的。
    // 现在无论成败都记一条，进 runtime 日志，可回溯。
    console.log(
      `[delete] 任务「${proj.name}」(port=${proj.port}) 已删除 —— ` +
      `文件:${removedDir ? "已删 " + target : "未删" + (dirError ? "（" + dirError + "）" : "")}, ` +
      `会话:${threads} 个`,
    );
    json(res, ok ? 200 : 404, {
      success: ok,
      message: ok
        ? `「${proj.name}」已彻底删除（${threads} 个会话 + ${removedDir ? "项目文件" : "（文件未删：" + dirError + "）"}）`
        : "删除失败",
      port: String(proj.port),
      files_deleted: removedDir,
      threads_deleted: threads,
      ...(dirError ? { warning: dirError } : {}),
    });
    return true;
  }

  // ── POST /api/projects/create ──────────────────────
  if (path === "/api/projects/create" && req.method === "POST") {
    const b = await readBody(req);
    const name = String(b.name ?? b.project ?? "新任务");
    const wantPort = b.port !== undefined ? Number(b.port) : null;
    const p = svc.projects.create({ name });
    if (wantPort && Number.isFinite(wantPort)) svc.db.run("UPDATE projects SET port = ? WHERE id = ?", wantPort, p.id);
    const fresh = svc.projects.get(p.id)!;
    svc.store.getOrCreateProjectThread(fresh.id, fresh.name);
    json(res, 200, {
      success: true,
      message: wantPort ? `项目 ${wantPort} 创建成功` : `任务「${name}」创建成功`,
      project: { port: String(fresh.port ?? 0), path: fresh.path, name: fresh.name, project: null },
    });
    return true;
  }

  // ── POST /api/projects/attach ──────────────────────
  if (path === "/api/projects/attach" && req.method === "POST") {
    const b = await readBody(req);
    const raw = String(b.path ?? "").trim();
    if (!raw) { json(res, 400, { success: false, message: "缺少 path" }); return true; }
    const abs = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
    if (!existsSync(abs)) { json(res, 400, { success: false, message: `目录不存在：${abs}` }); return true; }
    const name = String(b.name ?? abs.split("/").filter(Boolean).pop() ?? "接入目录");
    const existing = svc.projects.list().find((x) => x.path === abs);
    let p = existing;
    if (!p) {
      const created = svc.projects.create({ name });
      svc.db.run("UPDATE projects SET path = ? WHERE id = ?", abs, created.id);
      p = svc.projects.get(created.id)!;
    }
    svc.store.getOrCreateProjectThread(p.id, p.name);
    json(res, 200, { success: true, message: `已接入「${p.name}」`, project: { port: String(p.port ?? 0), path: p.path, name: p.name, project: null } });
    return true;
  }

  // ── POST /api/import-project ───────────────────────
  if (path === "/api/import-project" && req.method === "POST") {
    const b = await readBody(req);
    const p = svc.projects.create({ name: String(b.name ?? "导入任务") });
    svc.store.getOrCreateProjectThread(p.id, p.name);
    json(res, 200, { success: true, message: "已导入", project_path: p.path, version_id: String(b.version_id ?? "") });
    return true;
  }

  // ── GET /api/project-info?project_id= ──────────────
  if (path === "/api/project-info" && req.method === "GET") {
    const port = projectIdToPort(svc, url.searchParams.get("project_id") ?? "");
    const proj = port !== null ? portToProject(svc, port) : null;
    if (!proj) { json(res, 404, { error: "项目不存在" }); return true; }
    let files = 0;
    try { files = readdirSync(proj.path).length; } catch { /* ignore */ }
    json(res, 200, { file_count: files, current_version: 0, react_app_path: proj.path, project_id: String(port) });
    return true;
  }

  // ── POST /api/project-status ───────────────────────
  if (path === "/api/project-status" && (req.method === "POST" || req.method === "GET")) {
    const pid = req.method === "GET" ? (url.searchParams.get("project_id") ?? "") : String((await readBody(req)).project_id ?? "");
    const port = projectIdToPort(svc, pid);
    json(res, 200, { success: true, is_generating: false, project_id: String(port ?? pid) });
    return true;
  }

  // ── GET /api/history?project_id= ★关键 ─────────────
  if (path === "/api/history" && req.method === "GET") {
    const port = projectIdToPort(svc, url.searchParams.get("project_id") ?? "");
    const proj = port !== null ? portToProject(svc, port) : null;
    if (!proj) { json(res, 200, { history: [] }); return true; }
    const thread = svc.store.getOrCreateProjectThread(proj.id, proj.name);
    const msgs = svc.store.listMessages(thread.id, 1000);

    // commit_hash 要和版本号对上：
    // 每改一次文件 routes-chat 就 snapshot 一次，所以「第 k 次修改」=「版本 k」。
    let versionByNumber = new Map<number, string>();
    try {
      const list = await svc.projects.versions(proj.id);
      versionByNumber = new Map(list.map((v, i) => [list.length - i, v.version]));
    } catch { /* 没版本也继续，只是 commit_hash 为空 */ }

    const history: Record<string, unknown>[] = [];
    let cur: Record<string, unknown> | null = null;
    let modCount = 0;
    for (const m of msgs) {
      if (m.role === "user") {
        const text = m.parts.filter((x) => (x as { type: string }).type === "text").map((x) => (x as { text: string }).text).join("");
        cur = {
          id: m.id,
          start_time: localTime(m.createdAt),
          end_time: localTime(m.createdAt),
          user: text,
          events: [],
          is_modified: false,
        };
        history.push(cur);
      } else if (m.role === "assistant" && cur) {
        (cur.events as Record<string, unknown>[]).push(...partsToEvents(m as unknown as { parts: unknown[] }));
        cur.end_time = localTime(m.createdAt);
        // ★ is_modified 决定前端版本号；commit_hash 决定版本条能不能点
        if (didModify(m as unknown as { parts: unknown[] })) {
          cur.is_modified = true;
          modCount += 1;
          const hash = versionByNumber.get(modCount);
          if (hash) cur.commit_hash = hash;
        }
      }
    }
    json(res, 200, { history });
    return true;
  }

  // ── GET /api/versions ──────────────────────────────
  if (path === "/api/versions" && req.method === "GET") {
    const port = projectIdToPort(svc, url.searchParams.get("project_id") ?? "");
    const proj = port !== null ? portToProject(svc, port) : null;
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }
    const limit = Number(url.searchParams.get("limit") ?? 20);
    let list: { version: string; message?: string; createdAt?: number }[] = [];
    try { list = await svc.projects.versions(proj.id); } catch { /* ignore */ }
    const versions = list.slice(0, limit).map((v, i) => ({
      version_number: list.length - i,
      commit_hash: v.version,
      timestamp: localTime(v.createdAt ?? Date.now()),
      summary: v.message ?? "",
      skipped: false,
    }));
    json(res, 200, { success: true, versions, total_count: list.length, current_version: list.length });
    return true;
  }

  // ── 版本切换 ───────────────────────────────────────
  if ((path === "/api/switch-version" || path === "/api/switch-to-latest") && req.method === "POST") {
    const b = await readBody(req);
    const port = projectIdToPort(svc, String(b.project_id ?? ""));
    const proj = port !== null ? portToProject(svc, port) : null;
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }
    if (path === "/api/switch-version" && b.commit_hash) {
      const r = await svc.projects.restore(proj.id, String(b.commit_hash));
      json(res, 200, { success: r.ok, message: r.message });
    } else {
      json(res, 200, { success: true, message: "已切回最新版本" });
    }
    return true;
  }

  // 注意：参数在 query，POST 无 body
  if (path === "/api/set-preview-version" && req.method === "POST") {
    const ver = url.searchParams.get("version");
    json(res, 200, { success: true, message: ver ? `已切换到版本 ${ver}` : "已切换到最新版本", version: ver ? Number(ver) : null });
    return true;
  }

  // ── POST /api/reset-project ────────────────────────
  if (path === "/api/reset-project" && req.method === "POST") {
    const b = await readBody(req);
    const port = projectIdToPort(svc, String(b.project_id ?? ""));
    const proj = port !== null ? portToProject(svc, port) : null;
    if (proj) {
      const th = svc.store.getOrCreateProjectThread(proj.id, proj.name);
      svc.store.deleteThread(th.id);
      json(res, 200, { success: true, message: `项目 ${port} 重置成功`, project_path: proj.path });
    } else json(res, 500, { success: false, message: "项目不存在" });
    return true;
  }

  // ── POST /api/upload-file ──────────────────────────
  if (path === "/api/upload-file" && req.method === "POST") {
    const b = await readBody(req);
    const port = projectIdToPort(svc, String(b.project_id ?? ""));
    const proj = port !== null ? portToProject(svc, port) : null;
    if (!proj) { json(res, 404, { error: "项目不存在" }); return true; }
    const filename = String(b.filename ?? `upload_${Date.now()}`).replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
    const dir = join(proj.path, "uploads");
    mkdirSync(dir, { recursive: true });
    const raw = String(b.content_base64 ?? b.data ?? "");
    const b64 = raw.includes(",") ? raw.split(",")[1]! : raw;
    const buf = Buffer.from(b64, "base64");
    if (buf.length > 20 * 1024 * 1024) { json(res, 400, { error: "文件大小超过限制（最大 20MB）" }); return true; }
    try {
      const target = join(dir, filename);
      writeFileSync(target, buf);
      json(res, 200, {
        success: true,
        file_id: `${port}_${Date.now().toString(16)}`,
        filename, mime_type: String(b.mime_type ?? "application/octet-stream"), size: buf.length,
      });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // ── POST /api/dialog/choose-folder ─────────────────
  if (path === "/api/dialog/choose-folder" && req.method === "POST") {
    json(res, 200, { success: false, cancelled: true, message: "当前运行形态没有原生文件夹选择器，请手动填写路径" });
    return true;
  }

  if (path === "/api/clear-dove-cloud" && req.method === "POST") {
    await readBody(req);
    json(res, 200, { success: true, message: "没有可清理的 Dove Cloud 资源", tables_deleted: [], functions_deleted: [] });
    return true;
  }

  return false;
}
