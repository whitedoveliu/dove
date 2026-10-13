/**
 * POST /api/open-path —— 「用系统默认应用打开」/「在文件管理器里显示」。
 *
 * body: { path: string, action: "default" | "reveal", project_id?: string }
 *   · path 可以是绝对路径，也可以是**项目内相对路径**（后者按项目根解析）
 *   · project_id 给了 → 该项目的目录是边界；没给 → 工作区根（DOVE_WORKSPACE）是边界
 * 返回: { ok: boolean, message: string }
 *
 * ── 安全边界（**不是提示词约束，是硬拒**）─────────────────────────────
 * 这个端点会真的在本机执行 `open`。面板是网页，任何能往 8008 发请求的东西都在它的射程内，
 * 所以三道闸一个都不能少：
 *   ① 令牌闸门（server.ts 的 /api/* 统一闸）—— 跨源页面拿不到令牌：请求**到得了**这里
 *      （简单请求不触发预检，OPTIONS 预检更是明确放行 204），但一律 401，
 *      而 401 响应一个 CORS 头都不带，页面连响应体都读不到；
 *   ② 路径必须在项目根 / 工作区根**之内**（先 resolve，再判前缀）—— 越界一律 403；
 *   ③ 存在性确认后 **realpath 再判一次** —— 防的是「工作区里放一个软链指向 ~/.ssh/id_rsa」
 *      这种逃逸：resolve 出来的字面路径在界内，真实路径不在。
 * 另外一律用 execFile（数组参数、不走 shell）—— 路径里带 `;` `$()` 也只是普通字符。
 *
 * 平台差异照实说：macOS 的 `open -R` 能选中文件；Linux 的 xdg-open 只能开到目录
 * （各家文件管理器没有统一的「选中某个文件」入口），所以 reveal 降级成「打开所在目录」。
 * 其它平台**明确不支持**，而不是悄悄执行一条可能不存在的命令。
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../bootstrap.ts";
import { json, readBody, findProjectByKey } from "./server.ts";
import { inside, realOrNull } from "./path-guard.ts";

/** 系统命令不该让 HTTP 请求悬着 —— 超时就当失败（用户能看到原因，也能自己去打开） */
const EXEC_TIMEOUT_MS = 5_000;

export async function handleOpenPathRoutes(
  path: string, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  if (path !== "/api/open-path" || req.method !== "POST") return false;

  const body = await readBody(req);
  const raw = String(body.path ?? "").trim();
  const action = String(body.action ?? "default").trim();
  // 只认 project_id：面板（control-panel/src/lib/api.ts 的 openProjectPath）与仓库里
  // 唯一的构建产物都只发这个字段，`body.port` 那条兜底没有消费者 —— 按「建好没接」的
  // 纪律删掉，别留一个没人测过的入口（端口作为**值**仍然认：findProjectByKey 三键查找）。
  const key = String(body.project_id ?? "").trim();

  if (!raw) { json(res, 400, { ok: false, message: "缺少 path" }); return true; }
  if (action !== "default" && action !== "reveal") {
    json(res, 400, { ok: false, message: `action 只认 default / reveal（收到 ${action || "空"}）` });
    return true;
  }

  // 边界：项目根优先（面板总是带着项目在操作），没给才退回工作区根
  const proj = key ? findProjectByKey(svc, key) : null;
  if (key && !proj) { json(res, 404, { ok: false, message: `项目不存在（${key}）` }); return true; }
  const root = proj?.path ?? svc.cfg.workspaceRoot;
  const rootAbs = resolve(root);

  const target = isAbsolute(raw) ? resolve(raw) : resolve(rootAbs, raw);

  // ② 字面路径判定：越界连「存不存在」都不告诉调用方
  if (!inside(rootAbs, target)) {
    json(res, 403, { ok: false, message: `拒绝：路径不在项目工作区内（${target}）` });
    return true;
  }
  if (!existsSync(target)) {
    json(res, 404, { ok: false, message: `文件不存在：${target}` });
    return true;
  }

  // ③ 软链逃逸：真实路径必须也落在界内
  const rootReal = realOrNull(rootAbs) ?? rootAbs;
  const targetReal = realOrNull(target);
  if (!targetReal || !inside(rootReal, targetReal)) {
    json(res, 403, { ok: false, message: `拒绝：真实路径不在项目工作区内（${targetReal ?? target}）` });
    return true;
  }

  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    json(res, 501, { ok: false, message: `当前平台（${platform}）不支持从面板打开系统应用` });
    return true;
  }

  // macOS: open / open -R（选中文件）；Linux: xdg-open（reveal 只能开到目录）
  let isDir = false;
  try { isDir = statSync(targetReal).isDirectory(); } catch { /* 已经 existsSync 过，这里只是拿目录判定 */ }
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = action === "reveal" ? ["-R", targetReal] : [targetReal];
  } else {
    cmd = "xdg-open";
    args = action === "reveal" && !isDir ? [dirname(targetReal)] : [targetReal];
  }

  const result = await new Promise<{ ok: boolean; message: string }>((done) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const why = String(stderr ?? "").trim() || err.message;
        done({ ok: false, message: `打开失败（${cmd}）：${why.slice(0, 300)}` });
        return;
      }
      const label = action === "reveal"
        ? (platform === "darwin" ? "已在文件管理器中显示" : "已打开所在目录")
        : "已交给系统默认应用";
      done({ ok: true, message: `${label}：${targetReal}` });
    });
  });

  json(res, result.ok ? 200 : 500, result);
  return true;
}
