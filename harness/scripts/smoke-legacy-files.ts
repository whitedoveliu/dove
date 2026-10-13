#!/usr/bin/env node
/**
 * 兼容层「文件面」自测：路径越界 / /preview 的令牌·点文件·MIME / limit 截断 / Host 反 rebinding
 * 运行：cd harness && node --no-warnings scripts/smoke-legacy-files.ts
 *
 * 为什么要有这个脚本：`/api/projects/{port}/{file,stat,files}`、`/preview/*` 这几条**一条测试都没有**，
 * 而其中三条以前能读整台机器的任意文件（`?path=../../../../etc/hosts` 实测 200 直接吐内容），
 * `/preview` 连 Host 都不判、还回 `Access-Control-Allow-Origin: *`、点文件照发。
 * 这里把「必须继续拒绝的东西」钉成断言 —— 下次重构放开哪一道，这个脚本会先红。
 *
 * 起的是**进程内**兼容层（临时库 + 临时端口 8882），不碰用户正在跑的内核（8790 / 8008）。
 * ⚠️ 验不了什么：面板的渲染；`/api/open-path` 真的调起系统应用（那条要人看，且会弹窗）——
 * 它这里只被间接覆盖（同一份 path-guard 的 inside/realOrNull）。
 */
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库与配置指到临时目录，别碰生产库
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, bootstrap, type Services } from "../packages/server/src/bootstrap.ts";
import { startLegacyServer, type LegacyServerHandle } from "../packages/server/src/legacy/server.ts";
import { loadOrMintToken } from "../packages/server/src/local-token.ts";
import { finish } from "./_lifecycle.ts";

/** 8882：与 verify.sh 第 0 步的端口占用检查一致（那里点名了这个端口） */
const PORT = 8882;

// 工作区**强制**指到临时目录：本脚本要造「工作区之外」的文件来验越界，
// 落到真实工作区（~/DoveProjects）就会在用户的项目目录旁边留垃圾。
// 库与配置沿用 _isolate.ts 的决定（调用方显式给了 DOVE_DB 就尊重它 —— 那是既有约定）。
const ROOT = mkdtempSync(join(tmpdir(), "dove-legacy-files-"));
process.env.DOVE_WORKSPACE = join(ROOT, "ws");
process.env.DOVE_DB = process.env.DOVE_DB ?? join(ROOT, "dove.db");
process.env.DOVE_CONFIG = process.env.DOVE_CONFIG ?? join(ROOT, "cfg");
mkdirSync(process.env.DOVE_WORKSPACE, { recursive: true });
mkdirSync(process.env.DOVE_CONFIG, { recursive: true });

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};
const section = (t: string): void => { console.log("\n=== " + t + " ==="); };

interface Raw { status: number; body: string; headers: Record<string, string | string[] | undefined> }

/** 用 node:http 而不是 fetch —— 要能**自己指定 Host**（fetch 把 Host 当禁改头），这是 rebinding 的判据 */
function raw(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: PORT, path, method: opts.method ?? "GET", headers: opts.headers ?? {} },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(new Error("超时")); });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const jsonOf = (r: Raw): Record<string, unknown> => {
  try { return JSON.parse(r.body) as Record<string, unknown>; } catch { return {}; }
};

let svc: Services | null = null;
let legacy: LegacyServerHandle | null = null;

try {
  svc = await bootstrap(loadConfig());
  const token = loadOrMintToken(svc.cfg.configDir);
  legacy = await startLegacyServer(svc, PORT, token);
  if (!legacy) throw new Error(`端口 ${PORT} 被占用（另一次 verify.sh 还在跑？）`);

  // ── 夹具：一个项目 + 工作区外的机密文件 + 出界软链 + 坏软链 ──────────────
  const ws = svc.cfg.workspaceRoot;
  const proj = svc.projects.create({ name: "smoke-legacy-files" });
  const P = String(proj.port ?? 0);
  const F = (rel: string): string => `/api/projects/${P}/${rel}`;
  const outside = join(dirname(ws), "outside-smoke-secret.txt");
  writeFileSync(outside, "OUTSIDE-SECRET");
  writeFileSync(join(proj.path, "in-workspace.txt"), "hello-in-workspace");
  writeFileSync(join(proj.path, "big.txt"), "0123456789abcdefghij");   // 20 字节：limit=5 的靶子
  writeFileSync(join(proj.path, ".env"), "DOVE_SECRET=1");
  writeFileSync(join(proj.path, "page.htm"), "<h1>hi</h1>");
  writeFileSync(join(proj.path, "page.xhtml"), "<h1>hi</h1>");
  for (const n of ["a.aac", "a.opus", "a.weba", "v.avi", "v.mkv"]) writeFileSync(join(proj.path, n), "x");
  mkdirSync(join(proj.path, ".hidden"), { recursive: true });
  writeFileSync(join(proj.path, ".hidden", "secret.txt"), "HIDDEN");
  symlinkSync(outside, join(proj.path, "escape-link"));               // 软链逃逸的靶子
  symlinkSync(join(proj.path, "no-such-target"), join(proj.path, "broken-link"));   // 坏软链

  const AUTH = { "X-Dove-Token": token };
  const TQ = "?token=" + encodeURIComponent(token);

  // ── 1. 路径越界：三条路由 + 软链 + 反斜杠 ─────────────────────────
  section("1. 路径越界（以前能读到整份 /etc/hosts）");
  const hosts = await raw(F("file") + "?path=../../../../../../etc/hosts", { headers: AUTH });
  check("/file?path=../../…/etc/hosts → 403", hosts.status === 403, "status=" + hosts.status + " " + String(jsonOf(hosts).message ?? "").slice(0, 60));

  const statEsc = await raw(F("stat") + "?path=../../../../../../etc/hosts", { headers: AUTH });
  check("/stat?path=../../…/etc/hosts → 403", statEsc.status === 403, "status=" + statEsc.status);

  const filesEsc = await raw(F("files") + "?path=../../../..", { headers: AUTH });
  check("/files?path=../../.. → 403", filesEsc.status === 403, "status=" + filesEsc.status);

  // 这个目标**真实存在**（工作区外一层），403 只能来自边界闸而不是「找不到」
  const outsideReal = await raw(F("file") + "?path=../outside-smoke-secret.txt", { headers: AUTH });
  check("工作区外真实存在的文件（../outside-…）→ 403（不是 404）", outsideReal.status === 403 && !outsideReal.body.includes("OUTSIDE-SECRET"), "status=" + outsideReal.status);

  const backslash = await raw(F("file") + "?path=..%5C..%5C..%5C..%5Cetc%5Chosts", { headers: AUTH });
  check("反斜杠写法（..\\..\\etc\\hosts）→ 403", backslash.status === 403, "status=" + backslash.status);

  const escapeLink = await raw(F("file") + "?path=escape-link", { headers: AUTH });
  check("软链指向工作区外 → 403（realpath 那道）", escapeLink.status === 403, "status=" + escapeLink.status);

  const okFile = await raw(F("file") + "?path=in-workspace.txt", { headers: AUTH });
  check("工作区内正常文件 → 200（对照：闸放行的那一侧）", okFile.status === 200 && okFile.body.includes("hello-in-workspace"), "status=" + okFile.status);

  const noTok = await raw(F("file") + "?path=in-workspace.txt");
  check("不带令牌 → 401（闸还在）", noTok.status === 401, "status=" + noTok.status);

  // ── 2. /files：坏软链不炸整层，出界软链不列 ──────────────────────
  section("2. /files 的坏软链 / 出界软链");
  const list = await raw(F("files"), { headers: AUTH });
  const entries = Array.isArray(jsonOf(list).entries) ? (jsonOf(list).entries as { name: string; size?: number }[]) : [];
  const names = entries.map((e) => e.name);
  check("目录里有坏软链也照样 200（不是 500）", list.status === 200, "status=" + list.status);
  check("好文件仍在列表里", names.includes("in-workspace.txt"));
  check("坏软链降级成 size 0 的条目", names.includes("broken-link") && entries.find((e) => e.name === "broken-link")?.size === 0);
  check("指向工作区外的软链**不列**", !names.includes("escape-link"));

  // ── 3. /file?limit=N：truncated 与 size 的口径 ────────────────────
  section("3. /file?limit=N");
  const limited = await raw(F("file") + "?path=big.txt&limit=5", { headers: AUTH });
  const lj = jsonOf(limited);
  check("limit=5 → truncated:true 且内容只剩 5 字节", limited.status === 200 && lj.truncated === true && String(lj.content ?? "").length === 5, "len=" + String(lj.content ?? "").length);
  check("size 仍是**完整**大小（20）", lj.size === 20, "size=" + String(lj.size));

  // ── 4. /preview：令牌 / 点文件 / MIME / 软链 / CORS ───────────────
  section("4. /preview/{port}/{path}");
  const pv = (rel: string, tail = ""): string => `/preview/${P}/${rel}${tail}`;

  const pvNoTok = await raw(pv(".env"));
  check("点文件 + 无令牌 → 401（不是 200）", pvNoTok.status === 401, "status=" + pvNoTok.status);

  const pvEnv = await raw(pv(".env", TQ));
  check(".env（点文件）→ 403，且不回内容", pvEnv.status === 403 && !pvEnv.body.includes("DOVE_SECRET"), "status=" + pvEnv.status);

  const pvNested = await raw(pv(".hidden/secret.txt", TQ));
  check("点目录里的文件（.hidden/…）→ 403", pvNested.status === 403, "status=" + pvNested.status);

  // 编码写法：URL 解析器会把 `%2e%2e`（以及 `.%2e`）当成 `..` 在**进 handler 之前**消掉，
  // 于是它根本到不了这条路由（404 项目不存在）；但 `%2e%2e%2f`（编码的斜杠）会原样留下 ——
  // hasDotSegment 的解码那一遍就是为它准备的。两条都钉，别让任何一种读出去。
  const pvEncoded = await raw(pv("%2e%2e%2foutside-smoke-secret.txt", TQ));
  check("编码的点段（%2e%2e%2f…）→ 403", pvEncoded.status === 403, "status=" + pvEncoded.status);

  const pvDotDot = await raw("/preview/" + P + "/%2e%2e/outside-smoke-secret.txt" + TQ);
  check("明文 %2e%2e 段 → 读不到（URL 解析器先消掉了，404/403 都可，绝不是 200）",
    pvDotDot.status !== 200 && !pvDotDot.body.includes("OUTSIDE-SECRET"), "status=" + pvDotDot.status);

  const pvLink = await raw(pv("escape-link", TQ));
  check("软链指向工作区外 → 403（realpath 那道）", pvLink.status === 403, "status=" + pvLink.status);

  const pvOk = await raw(pv("in-workspace.txt", TQ));
  check("正常文件 + 令牌 → 200，内容对", pvOk.status === 200 && pvOk.body === "hello-in-workspace", "status=" + pvOk.status);
  check("响应**不带** Access-Control-Allow-Origin（跨源页面读不到）", pvOk.headers["access-control-allow-origin"] === undefined);
  check("响应带 Cache-Control: no-store", pvOk.headers["cache-control"] === "no-store");

  // MIME：面板的 file-kinds.ts 认得这些扩展名，缺一个就退化成 octet-stream（下载 / 空白 / 不播）
  const mimes: [string, string][] = [
    ["page.htm", "text/html; charset=utf-8"],
    ["page.xhtml", "text/html; charset=utf-8"],
    ["a.aac", "audio/aac"],
    ["a.opus", "audio/ogg"],
    ["a.weba", "audio/webm"],
    ["v.avi", "video/x-msvideo"],
    ["v.mkv", "video/x-matroska"],
  ];
  for (const [file, expect] of mimes) {
    const r = await raw(pv(file, TQ));
    const ct = String(r.headers["content-type"] ?? "");
    check(`${file} 的 content-type = ${expect}`, r.status === 200 && ct === expect, "status=" + r.status + " ct=" + ct);
  }

  // 能在浏览器里跑起来的文档（html / xhtml / svg）一律带 CSP 沙箱：这条 URL 的令牌是**明文查询串**，
  // 顶层打开时文档自己就能读到它 —— 不给沙箱就等于「拿着令牌的同源文档」。定义在 preview-path.ts。
  const pvHtml = await raw(pv("page.htm", TQ));
  const pvCsp = String(pvHtml.headers["content-security-policy"] ?? "");
  check("html 预览带 CSP sandbox 且无 allow-same-origin",
    pvHtml.status === 200 && pvCsp.includes("sandbox") && !pvCsp.includes("allow-same-origin"),
    "status=" + pvHtml.status + " csp=" + pvCsp);

  // ── 5. Host 反 rebinding（8008 这一层也要判）──────────────────────
  section("5. Host 反 rebinding");
  const evilApi = await raw("/api/projects", { headers: { Host: "evil.example", ...AUTH } });
  check("Host=evil.example + 对令牌 → 403", evilApi.status === 403, "status=" + evilApi.status);

  const evilHealth = await raw("/api/health", { headers: { Host: "evil.example" } });
  check("Host=evil.example 连 /api/health 也 403（判在豁免之前）", evilHealth.status === 403, "status=" + evilHealth.status);

  const evilPreview = await raw(pv("in-workspace.txt", TQ), { headers: { Host: "evil.example" } });
  check("Host=evil.example 的 /preview → 403", evilPreview.status === 403, "status=" + evilPreview.status);

  const hostLocal = await raw("/api/projects", { headers: { Host: "localhost:" + PORT, ...AUTH } });
  check("Host=localhost:PORT 放行（对照）", hostLocal.status === 200, "status=" + hostLocal.status);

  const hostLoop = await raw(F("file") + "?path=in-workspace.txt", { headers: { Host: "127.0.0.1:" + PORT, ...AUTH } });
  check("Host=127.0.0.1:PORT 放行（对照）", hostLoop.status === 200, "status=" + hostLoop.status);
} catch (e) {
  failed++;
  console.log("  ❌ 冒烟脚本自己抛了：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  try { legacy?.close(); } catch { /* ignore */ }
}

section("结果");
console.log("  通过 " + passed + " / 失败 " + failed);
console.log(failed === 0 ? "✅ 兼容层文件面（越界 / 预览 / MIME / Host）全部通过" : "❌ 有失败项，见上面");
finish(svc, failed === 0 ? 0 : 1);
