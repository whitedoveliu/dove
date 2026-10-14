#!/usr/bin/env node
/**
 * 兼容层「打开方式（用哪个 App 打开）」自测：
 *   清单探测 / 拼命令（纯函数）/ 路径边界 / 令牌闸门 / 图标
 * 运行：cd harness && node --no-warnings scripts/smoke-legacy-open-in-app.ts
 *
 * 为什么要有这个脚本：`/api/open-in-app` 的三条路由会**真的在本机执行 `open`** ——
 * 点一下就在用户眼前弹出一个编辑器窗口。这类代码最怕两件事，这里各钉一组断言：
 *   ① 命令拼错了（路径没走到 realpath、终端类没换成所在目录、reveal 类没加 -R）；
 *   ② 边界松了（越界路径 / 软链逃逸 / 请求体里的 `appId` 变成一条任意命令）。
 * 所以**启动器是注入的**：断言「到底拼了什么 argv」，而跑一遍冒烟不会弹出任何窗口。
 *
 * 起的是**进程内**兼容层（临时库 + 临时端口 8884），不碰用户正在跑的内核（8790 / 8008）。
 * ⚠️ 验不了什么：面板的渲染（分体按钮长什么样要人看）；真机装了什么 App（探测注入的用例
 * 覆盖了逻辑，真机那一组只断言系统自带的 finder / terminal，与用户装没装编辑器无关）。
 */
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库与配置指到临时目录，别碰生产库
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, bootstrap, type Services } from "../packages/server/src/bootstrap.ts";
import { startLegacyServer, type LegacyServerHandle } from "../packages/server/src/legacy/server.ts";
import { loadOrMintToken } from "../packages/server/src/local-token.ts";
import {
  APP_TABLE, bundleCandidates, buildLaunchInvocation, probeInstalledApps,
  type AppRow, type InstalledApp,
} from "../packages/server/src/legacy/open-in-app.ts";
import { handleOpenInAppRoutes } from "../packages/server/src/legacy/routes-open-in-app.ts";
import { finish } from "./_lifecycle.ts";

/** 8884：与 verify.sh 第 0 步的端口占用检查一致（那里点名了这个端口） */
const PORT = 8884;

// 工作区**强制**指到临时目录：本节要造「工作区之外」的文件来验越界，
// 落到真实工作区（~/DoveProjects）就会在用户的项目目录旁边留垃圾。
const ROOT = mkdtempSync(join(tmpdir(), "dove-open-in-app-"));
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

/**
 * 假的 req / res —— 给「直接调路由 handler」的断言用。
 *
 * 为什么要绕开真 HTTP：真 HTTP 那条路注入不进 launcher（`startLegacyServer` 只拿到 svc 与 token），
 * 而这里必须断言「到底拼了哪条命令」又不能真开窗口。req 要能 `for await`
 * （readBody 是流式读的），所以做成 async generator。
 */
function makeFakeReq(body?: string, method = "POST"): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body, "utf8")];
  const stream = (async function* () { yield* chunks; })();
  return Object.assign(stream, { method, url: "/api/open-in-app", headers: {} }) as unknown as IncomingMessage;
}

function makeFakeRes(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
  let code = 0;
  let payload = "";
  const headers: Record<string, string> = {};
  const res = {
    writeHead(next: number, extra?: Record<string, string>) { code = next; Object.assign(headers, extra ?? {}); return res; },
    setHeader(name: string, value: string) { headers[name] = value; },
    end(chunk?: unknown) {
      if (typeof chunk === "string") payload = chunk;
      else if (Buffer.isBuffer(chunk)) payload = chunk.toString("utf8");
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => code,
    json: () => { try { return JSON.parse(payload) as Record<string, unknown>; } catch { return {}; } },
  };
}

let svc: Services | null = null;
let legacy: LegacyServerHandle | null = null;
/** 记录器：所有「拼出来的命令」都落在这里，**没有一条会被真的执行** */
const launched: { cmd: string; args: string[] }[] = [];

try {
  svc = await bootstrap(loadConfig());
  const token = loadOrMintToken(svc.cfg.configDir);
  legacy = await startLegacyServer(svc, PORT, token);
  if (!legacy) throw new Error(`端口 ${PORT} 被占用（另一次 verify.sh 还在跑？）`);
  const services = svc;   // 收窄成 Services，好给闭包用

  // ── 夹具：一个项目 + 工作区内的文件 + 工作区外的机密 + 出界软链 ──────
  const ws = svc.cfg.workspaceRoot;
  const proj = svc.projects.create({ name: "smoke-open-in-app" });
  const P = String(proj.port ?? 0);
  const outside = join(dirname(ws), "outside-smoke-secret.txt");
  writeFileSync(outside, "OUTSIDE-SECRET");
  writeFileSync(join(proj.path, "in-workspace.txt"), "hello-in-workspace");
  symlinkSync(outside, join(proj.path, "escape-link"));
  const fileReal = realpathSync(join(proj.path, "in-workspace.txt"));
  const projReal = realpathSync(proj.path);

  const AUTH = { "X-Dove-Token": token };
  const MAC = process.platform === "darwin";

  // ── 1. 清单与探测（注入 roots / exists：结果与跑测试的机器无关）─────
  section("1. 清单与探测");
  const injected = probeInstalledApps({
    platform: "darwin",
    roots: ["/Applications", "/Users/x/Applications"],
    exists: (p) => p === "/Applications/Cursor.app",
  });
  check("注入式探测：只有真实存在的 bundle 进清单",
    injected.length === 1 && injected[0].id === "cursor" && injected[0].bundle === "/Applications/Cursor.app",
    JSON.stringify(injected));
  check("非 darwin → 空清单（面板据此退回原来的菜单，而不是列一堆没装的 App）",
    probeInstalledApps({ platform: "linux", exists: () => true }).length === 0);

  const zed = APP_TABLE.find((row) => row.id === "zed") as AppRow;
  check("bundle 候选顺序 = 先第一个名字的所有 Applications 目录，再下一个名字",
    bundleCandidates(zed, ["/A", "/B"]).join(",") === "/A/Zed.app,/B/Zed.app,/A/Zed Preview.app,/B/Zed Preview.app",
    bundleCandidates(zed, ["/A", "/B"]).join(","));
  check("清单里每个 id 只出现一次", new Set(APP_TABLE.map((row) => row.id)).size === APP_TABLE.length);

  if (MAC) {
    const real = probeInstalledApps();
    const ids = real.map((app) => app.id);
    check("真机探测含 finder 与 terminal（系统自带，不依赖用户装没装编辑器）",
      ids.includes("finder") && ids.includes("terminal"), ids.join(",") || "(空)");
    check("探到的每个 bundle 都是真实存在的目录",
      real.every((app) => { try { return statSync(app.bundle).isDirectory(); } catch { return false; } }),
      real.map((app) => app.bundle).join(" "));
  }

  // ── 2. 拼命令：纯函数（不执行、不看文件系统）──────────────────────
  section("2. 拼命令（纯函数）");
  const openArgs = (app: { launch: "app" | "reveal"; target: "file" | "dir" }, path: string, isDir: boolean) =>
    buildLaunchInvocation(app, "/Applications/Whatever.app", { path, isDir });
  check("reveal 类（访达）→ open -R <路径>",
    JSON.stringify(openArgs({ launch: "reveal", target: "file" }, "/ws/a.txt", false)) === JSON.stringify({ cmd: "open", args: ["-R", "/ws/a.txt"] }));
  check("编辑器类 + 文件 → open -a <bundle> <文件>",
    JSON.stringify(openArgs({ launch: "app", target: "file" }, "/ws/a.txt", false).args) === JSON.stringify(["-a", "/Applications/Whatever.app", "/ws/a.txt"]));
  check("终端类 + 文件 → open -a <bundle> <文件所在目录>",
    JSON.stringify(openArgs({ launch: "app", target: "dir" }, "/ws/sub/a.txt", false).args) === JSON.stringify(["-a", "/Applications/Whatever.app", "/ws/sub"]));
  check("终端类 + 目录 → open -a <bundle> <目录本身>（不再剥一层）",
    JSON.stringify(openArgs({ launch: "app", target: "dir" }, "/ws/sub", true).args) === JSON.stringify(["-a", "/Applications/Whatever.app", "/ws/sub"]));

  // ── 3. 路由 + 注入 launcher：命令与文案可断言，一个窗口都不开 ────────
  section("3. /api/open-in-app（注入 launcher）");
  const FAKE_APPS: InstalledApp[] = [
    { id: "cursor", name: "Cursor", bundle: "/Applications/Cursor.app", launch: "app", target: "file" },
    { id: "terminal", name: "终端", bundle: "/Applications/Utilities/Terminal.app", launch: "app", target: "dir" },
    { id: "finder", name: "访达", bundle: "/System/Library/CoreServices/Finder.app", launch: "reveal", target: "file" },
  ];
  const deps = (platform: NodeJS.Platform = "darwin") => ({
    platform,
    probe: () => FAKE_APPS,
    launcher: async (cmd: string, args: string[]) => { launched.push({ cmd, args }); return { ok: true, message: "" }; },
  });
  const callOpen = async (body: unknown, platform: NodeJS.Platform = "darwin") => {
    const out = makeFakeRes();
    const handled = await handleOpenInAppRoutes(
      "/api/open-in-app", new URL("http://localhost/api/open-in-app"),
      makeFakeReq(JSON.stringify(body)), out.res, services, deps(platform),
    );
    return { handled, status: out.status(), json: out.json() };
  };

  const opened = await callOpen({ appId: "cursor", path: "in-workspace.txt", project_id: P });
  check("用指定 App 打开 → 200，且 argv = open -a <清单里的 bundle> <realpath>",
    opened.status === 200 && JSON.stringify(launched.at(-1)?.args ?? []) === JSON.stringify(["-a", "/Applications/Cursor.app", fileReal]),
    `status=${opened.status} args=${JSON.stringify(launched.at(-1)?.args ?? [])}`);
  check("成功文案点名是哪个 App", String(opened.json.message ?? "").includes("Cursor"), String(opened.json.message ?? ""));
  check("handler 认领了这条路径", opened.handled === true);

  const dirTarget = await callOpen({ appId: "terminal", path: ".", project_id: P });
  check("终端类：目标是目录时原样传过去（走的是同一份守卫）",
    dirTarget.status === 200 && (launched.at(-1)?.args.at(-1) ?? "") === projReal,
    JSON.stringify(launched.at(-1)?.args ?? []));

  const revealed = await callOpen({ appId: "finder", path: "in-workspace.txt", project_id: P });
  check("reveal 类 → open -R <路径>（在文件管理器里选中）",
    revealed.status === 200 && JSON.stringify(launched.at(-1)?.args ?? []) === JSON.stringify(["-R", fileReal]),
    JSON.stringify(launched.at(-1)?.args ?? []));

  // ── 4. 边界：请求体里的一切都进不了命令 ─────────────────────────
  section("4. 边界（用户输入不许进命令）");
  const before = launched.length;
  const evil = await callOpen({ appId: "cursor; rm -rf /", path: "in-workspace.txt", project_id: P });
  check("appId 里塞命令 → 400，且一条命令都没拼出来",
    evil.status === 400 && launched.length === before, `status=${evil.status} launched=${launched.length - before}`);
  check("appId 未知时说的就是「清单里没有」", /清单里没有/.test(String(evil.json.message ?? "")), String(evil.json.message ?? ""));

  const esc = await callOpen({ appId: "cursor", path: "../outside-smoke-secret.txt", project_id: P });
  check("越界 path → 403，且没执行任何命令（与 /api/open-path 同一份守卫）",
    esc.status === 403 && launched.length === before, `status=${esc.status} ${String(esc.json.message ?? "")}`);
  const link = await callOpen({ appId: "cursor", path: "escape-link", project_id: P });
  check("软链逃逸 → 403（realpath 那道）", link.status === 403 && launched.length === before, `status=${link.status}`);
  const gone = await callOpen({ appId: "cursor", path: "no-such-file.txt", project_id: P });
  check("不存在 → 404", gone.status === 404 && launched.length === before, `status=${gone.status}`);
  check("缺 path → 400", (await callOpen({ appId: "cursor", path: "" })).status === 400);
  check("缺 appId → 400", (await callOpen({ path: "in-workspace.txt", project_id: P })).status === 400);
  const otherOs = await callOpen({ appId: "cursor", path: "in-workspace.txt", project_id: P }, "linux");
  check("非 darwin → 501（不猜命令，也不假装支持）", otherOs.status === 501 && launched.length === before, `status=${otherOs.status}`);
  check("别的路径不吃这条 handler（前缀相同也不行）",
    (await handleOpenInAppRoutes(
      "/api/open-in-app/apps/extra", new URL("http://localhost/api/open-in-app/apps/extra"),
      makeFakeReq(undefined, "GET"), makeFakeRes().res, services, deps(),
    )) === false);

  // ── 5. 真 HTTP（过令牌闸门 + 真探测）：这几条一定到不了 launcher ──
  section("5. 真 HTTP 层");
  const appsRes = await raw("/api/open-in-app/apps", { headers: AUTH });
  const appsBody = jsonOf(appsRes);
  check("GET /api/open-in-app/apps → 200 且 apps 是数组",
    appsRes.status === 200 && Array.isArray(appsBody.apps), `status=${appsRes.status}`);
  check("platform 字段如实回报", appsBody.platform === process.platform, String(appsBody.platform));
  const rows = Array.isArray(appsBody.apps) ? appsBody.apps as Record<string, unknown>[] : [];
  check("清单只回 id / name / action（不给 bundle 路径）",
    rows.length > 0 && rows.every((row) => Object.keys(row).sort().join(",") === "action,id,name"),
    JSON.stringify(rows[0] ?? {}));
  check("不带令牌 → 401（闸还在）", (await raw("/api/open-in-app/apps")).status === 401);

  const httpBad = await raw("/api/open-in-app", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "definitely-not-installed", path: "in-workspace.txt", project_id: P }),
  });
  check("HTTP 层：未知 appId → 400（这条永远到不了 launcher，安全的）",
    httpBad.status === 400, `status=${httpBad.status}`);

  if (MAC) {
    // 图标：真跑一次 plutil + sips（不开窗口、不弹对话框）。抽不到就会走 404 —— 那也算失败。
    const icon = await raw("/api/open-in-app/icon?id=finder", { headers: AUTH });
    check("GET /api/open-in-app/icon?id=finder → 200 image/png",
      icon.status === 200 && String(icon.headers["content-type"] ?? "").startsWith("image/png"),
      `status=${icon.status} ct=${String(icon.headers["content-type"] ?? "")}`);
    check("图标响应带缓存头", String(icon.headers["cache-control"] ?? "").includes("max-age"), String(icon.headers["cache-control"] ?? ""));
    const icon404 = await raw("/api/open-in-app/icon?id=nope", { headers: AUTH });
    check("图标：不在清单里的 id → 404（面板退回通用图标）", icon404.status === 404, `status=${icon404.status}`);
  }
} catch (e) {
  failed++;
  console.log("  ❌ 冒烟脚本自己抛了：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  try { legacy?.close(); } catch { /* ignore */ }
}

section("结果");
console.log("  通过 " + passed + " / 失败 " + failed);
console.log(failed === 0 ? "✅ 打开方式（清单 / 拼命令 / 边界 / 图标）全部通过" : "❌ 有失败项，见上面");
finish(svc, failed === 0 ? 0 : 1);
