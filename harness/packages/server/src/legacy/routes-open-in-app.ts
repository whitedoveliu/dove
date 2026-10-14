/**
 * `/api/open-in-app` —— 面板右上角「打开方式」**分体按钮**的后端。三条：
 *
 *   GET  /api/open-in-app/apps      已装 App 清单 `{ apps: [{id,name}], platform }`
 *   GET  /api/open-in-app/icon?id=  App 图标 PNG（抽不到 404，面板退回通用图标）
 *   POST /api/open-in-app           `{ appId, path, project_id? }` → 用这个 App 打开这个路径
 *
 * 交互与清单口径参考 DSH（DeepSeek Harness）的 open-in-app：清单是数据表、探测只认
 * 已知 Applications 目录、菜单里标「（默认）」、底部固定「显示文件位置」。
 * 面板侧的对应实现见 control-panel/src/components/open-in-app-button.tsx。
 *
 * ── 安全边界（**不是提示词约束，是硬拒**）─────────────────────────────
 * 这个端点会真的在本机执行 `open`，所以：
 *   ① 令牌闸门（server.ts 的 /api/* 统一闸）：跨源页面拿不到令牌，401 响应也不带 CORS 头；
 *   ② path 走**与 /api/open-path 完全相同的那一份**守卫（path-guard.ts 的 guardOpenTarget）——
 *      字面路径越界 403、不存在 404、realpath 逃逸（软链指到工作区外）再 403，
 *      三条口径与 /api/open-path 一字不差（写两份必然漂移，漂移一次就是一条任意文件读取/打开的路）；
 *   ③ **请求体只认 `appId`**：可执行文件与 bundle 路径一律来自内核自己的清单表 + 真实探测结果
 *      （buildLaunchInvocation 的入参），**用户输入永远进不了 `open -a` 的参数位** ——
 *      否则 `appId` 就成了「让内核替我执行任意命令」的入口；
 *   ④ 一律 execFile（数组参数、不走 shell）：路径里带 `;` `$()` 也只是普通字符；
 *   ⑤ 平台差异照实说：这套「Applications 目录 + bundle 名」只有 macOS 有，别的平台**明确 501**，
 *      不猜命令、不假装支持（清单接口则回空清单，面板据此退回原来的菜单）。
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../bootstrap.ts";
import { json, readBody, findProjectByKey } from "./server.ts";
import { guardOpenTarget } from "./path-guard.ts";
import {
  buildLaunchInvocation, findInstalledApp, probeInstalledApps, type InstalledApp,
} from "./open-in-app.ts";
import { appIconPng } from "./open-in-app-icons.ts";

/** 系统命令不该让 HTTP 请求悬着 —— 超时就当失败（用户能看到原因，也能自己去打开） */
const EXEC_TIMEOUT_MS = 5_000;

/**
 * 启动器（可注入：默认真的 `execFile` 一条 `open`，冒烟/测试里换成记录器 ——
 * 测试**绝不**真开窗口，见 harness/scripts/smoke-legacy-files.ts 的第 6 节）。
 */
export type AppLauncher = (
  cmd: string, args: string[], timeoutMs: number,
) => Promise<{ ok: boolean; message: string }>;

export const defaultAppLauncher: AppLauncher = (cmd, args, timeoutMs) =>
  new Promise((done) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const why = String(stderr ?? "").trim() || err.message;
        done({ ok: false, message: `打开失败（${cmd}）：${why.slice(0, 300)}` });
        return;
      }
      done({ ok: true, message: "" });
    });
  });

/** 注入点：平台、探测、启动、抽图标各一个（生产走默认值，测试全换掉） */
export interface OpenInAppDeps {
  platform?: NodeJS.Platform;
  probe?: () => InstalledApp[];
  launcher?: AppLauncher;
  icon?: (bundle: string) => Promise<Buffer | null>;
}

export async function handleOpenInAppRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
  deps: OpenInAppDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const runProbe = deps.probe ?? (() => probeInstalledApps({ platform }));

  // ── GET /api/open-in-app/apps ────────────────────────────────
  if (path === "/api/open-in-app/apps" && req.method === "GET") {
    json(res, 200, {
      // 只回 id + 名字 + 「打开还是显示位置」：面板不需要知道 bundle 路径，也就不该拿到它。
      // action 是给界面说实话用的（访达那行的动作是**显示位置**，不是「用访达打开」）。
      apps: runProbe().map((app) => ({
        id: app.id,
        name: app.name,
        action: app.launch === "reveal" ? "reveal" as const : "open" as const,
      })),
      platform,
    });
    return true;
  }

  // ── GET /api/open-in-app/icon?id= ────────────────────────────
  if (path === "/api/open-in-app/icon" && req.method === "GET") {
    const id = String(url.searchParams.get("id") ?? "").trim();
    const app = findInstalledApp(runProbe(), id);
    const png = app ? await (deps.icon ?? appIconPng)(app.bundle) : null;
    if (!png) {
      json(res, 404, { ok: false, message: `没有 ${id || "?"} 的图标（App 不在清单/没装/抽图标失败）` });
      return true;
    }
    // 图标是静态的（只跟 bundle 走）：给一小时缓存，面板侧还有一层 blob 缓存
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": String(png.length),
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(png);
    return true;
  }

  // ── POST /api/open-in-app ────────────────────────────────────
  if (path === "/api/open-in-app" && req.method === "POST") {
    const body = await readBody(req);
    const appId = String(body.appId ?? "").trim();
    const raw = String(body.path ?? "").trim();
    const key = String(body.project_id ?? "").trim();

    if (!raw) { json(res, 400, { ok: false, message: "缺少 path" }); return true; }
    if (!appId) { json(res, 400, { ok: false, message: "缺少 appId" }); return true; }
    if (platform !== "darwin") {
      json(res, 501, { ok: false, message: `当前平台（${platform}）不支持用指定 App 打开（清单为空）` });
      return true;
    }

    // 边界：项目根优先，没给才退回工作区根（与 /api/open-path 同口径）
    const proj = key ? findProjectByKey(svc, key) : null;
    if (key && !proj) { json(res, 404, { ok: false, message: `项目不存在（${key}）` }); return true; }
    const rootAbs = resolve(proj?.path ?? svc.cfg.workspaceRoot);

    const verdict = guardOpenTarget(rootAbs, raw);
    if (!verdict.ok) { json(res, verdict.status, { ok: false, message: verdict.message }); return true; }

    // appId 必须命中**探测结果**里的 id：没装 / 拼错的 id 一律 400，不去猜一个相近的
    const apps = runProbe();
    const app = findInstalledApp(apps, appId);
    if (!app) {
      json(res, 400, { ok: false, message: `清单里没有这个 App（或本机没装）：${appId}` });
      return true;
    }

    const { cmd, args } = buildLaunchInvocation(app, app.bundle, { path: verdict.abs, isDir: verdict.isDir });
    const result = await (deps.launcher ?? defaultAppLauncher)(cmd, args, EXEC_TIMEOUT_MS);
    json(res, result.ok ? 200 : 500, {
      ok: result.ok,
      message: result.ok ? `已用 ${app.name} 打开：${verdict.abs}` : result.message,
    });
    return true;
  }

  return false;
}
