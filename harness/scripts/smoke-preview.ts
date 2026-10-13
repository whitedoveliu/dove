#!/usr/bin/env node
/**
 * 预览路由自测：8790 同源的「项目作用域」路径形（/api/preview/project/…）+ 下载路由
 * 运行：cd harness && node --no-warnings scripts/smoke-preview.ts
 *
 * 为什么要有这个脚本：面板修「8008 /preview 上了令牌闸」时把 **HTML 预览**改到了面板同源 ——
 * 因为 HTML 里的 `./style.css`、`<img src="img/x.png">` 是相对 URL，**不会继承查询串**
 * （8008 那条的令牌只能走 `?token=`），子资源必然 401。改完之后有三条契约只能靠断言钉住：
 *   ① 项目键写在**路径**里：同一份相对路径必须解析回**同一个项目**（同名文件不许串项目）；
 *   ② 点段（.env / .git/…）在预览路由上**一律 403**（它不过令牌闸门，只能自己挡）；
 *   ③ 「下载 / 另存」走 `/api/file/download`：**在令牌闸门之内**、点文件照给、同源能读响应体。
 *   ④ 能跑脚本的文档（html / svg / xml）一律带 CSP 沙箱（`preview-path.ts` 的 PREVIEW_DOC_CSP）——
 *      它们跑在**面板同源**（相对子资源要求同源），不隔离就等于把令牌（≈ 内核）交给页面。
 *
 * 起的是**进程内**内核（临时库 + 端口 8883），不碰用户正在跑的内核（8790 / 8008）。
 * ⚠️ 验不了什么：浏览器里相对 URL 的真实解析过程（这里只能证明「浏览器解析后的那两个 URL
 * 服务端给得对」）；面板 DOM 的渲染；桌面 WKWebView 的下载行为。
 */
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库与配置指到临时目录，别碰生产库
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, bootstrap, type Services } from "../packages/server/src/bootstrap.ts";
import { handle } from "../packages/server/src/routes.ts";
import { SseHub } from "../packages/server/src/sse.ts";
import { loadOrMintToken } from "../packages/server/src/local-token.ts";
import { finish } from "./_lifecycle.ts";

/** 8883：verify.sh 第 0 步的端口预检里点名了这个端口 */
const PORT = 8883;
process.env.DOVE_PORT = String(PORT);

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};
const section = (t: string): void => { console.log("\n=== " + t + " ==="); };

interface Raw { status: number; body: string; headers: Record<string, string | string[] | undefined> }

/** 用 node:http（要能自己指定 Host：反 rebinding 的判据在 Host 上，fetch 改不了它） */
function raw(path: string, opts: { headers?: Record<string, string> } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: PORT, path, method: "GET", headers: opts.headers ?? {} },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(new Error("超时")); });
    req.end();
  });
}

let svc: Services | null = null;
let server: Server | null = null;

try {
  svc = await bootstrap(loadConfig());
  const token = loadOrMintToken(svc.cfg.configDir);
  const hub = new SseHub();
  server = createServer((req, res) => {
    handle(req, res, { svc: svc!, hub, controlPanelDir: "", running: new Map(), token })
      .catch(() => { try { res.writeHead(500); res.end(); } catch { /* ignore */ } });
  });
  await new Promise<void>((r) => server!.listen(PORT, "127.0.0.1", () => r()));

  // ── 夹具：两个项目，各有一份**同名**文件（串项目的靶子）+ 点文件 + 出界软链 ──
  // 显式给 id 只是为了下面的断言读得懂（自动 id 的毫秒撞车已由
  // test/projects-create.test.ts 钉死，不再需要脚本绕开）。
  const a = svc.projects.create({ id: "smoke-prev-a", name: "smoke-preview-a" });
  const b = svc.projects.create({ id: "smoke-prev-b", name: "smoke-preview-b" });
  const PA = String(a.port ?? 0), PB = String(b.port ?? 0);
  const outside = join(dirname(svc.cfg.workspaceRoot), "outside-preview-secret.txt");
  writeFileSync(outside, "OUTSIDE-SECRET");
  for (const [proj, mark] of [[a, "AAA"], [b, "BBB"]] as const) {
    mkdirSync(join(proj.path, "sub"), { recursive: true });
    writeFileSync(join(proj.path, "sub", "page.html"),
      `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><h1>${mark}</h1><img src="./pic.png"></body></html>`);
    writeFileSync(join(proj.path, "sub", "style.css"), `h1{color:rgb(1,2,3)} /*${mark}-CSS*/`);
    writeFileSync(join(proj.path, "sub", "pic.png"), `${mark}-PNG`);
    // 能跑脚本的文档（html / svg）都要进沙箱 —— svg 用一个带 <script> 的当靶子
    writeFileSync(join(proj.path, "sub", "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`);
    writeFileSync(join(proj.path, "sub", ".env"), `SECRET=${mark}`);
    writeFileSync(join(proj.path, "index.html"), `<h1>${mark}-INDEX</h1>`);
    symlinkSync(outside, join(proj.path, "sub", "escape-link"));
  }

  const AUTH = { "X-Dove-Token": token };
  const P = (rel: string): string => `/api/preview/project/${PA}/${rel}`;

  // ── 1. HTML 文档：走项目路径形 ────────────────────────────
  section("1. /api/preview/project/<键>/<rel>");
  const page = await raw(P("sub/page.html"));
  check("HTML 文档 → 200 text/html，内容对", page.status === 200 && page.body.includes("AAA"), "status=" + page.status);
  // 沙箱是**响应头**，不是 iframe 属性：模板产出的 HTML 跑在面板同源，带上 allow-same-origin
  // 就等于把它变成面板的同源页面（`fetch('/api/local-token')` 读走令牌 ≈ 内核到手）。
  const pageCsp = String(page.headers["content-security-policy"] ?? "");
  check("HTML 文档带 CSP sandbox", pageCsp.includes("sandbox"), "csp=" + pageCsp);
  check("sandbox **不带** allow-same-origin", pageCsp !== "" && !pageCsp.includes("allow-same-origin"), "csp=" + pageCsp);
  check("sandbox 保住 allow-scripts（否则模型产出的 demo 就是静态图）", pageCsp.includes("allow-scripts"), "csp=" + pageCsp);
  const svg = await raw(P("sub/logo.svg"));
  const svgCsp = String(svg.headers["content-security-policy"] ?? "");
  check("SVG 文档同样进沙箱（它也是能跑脚本的文档）",
    svg.status === 200 && svgCsp.includes("sandbox") && !svgCsp.includes("allow-same-origin"),
    "status=" + svg.status + " csp=" + svgCsp);
  const root = await raw(P(""));
  check("项目根（目录）→ 200，命中 index.html（同样带沙箱）",
    root.status === 200 && root.body.includes("AAA-INDEX") && String(root.headers["content-security-policy"] ?? "").includes("sandbox"),
    "status=" + root.status + " csp=" + String(root.headers["content-security-policy"] ?? ""));

  // ── 2. 相对子资源：浏览器解析出来的路径必须落回**同一个项目** ──────
  // page.html 里写的是 ./style.css 与 ./pic.png —— 浏览器把文档 URL 的目录拼上文件名，
  // 于是请求就是下面这两条。它们能取到「这个项目」的字节，HTML 预览才不会裸奔。
  section("2. 相对子资源（浏览器解析的结果）");
  const css = await raw(P("sub/style.css"));
  check("style.css → 200 且是**本项目**那份（不是另一个项目的同名文件）", css.status === 200 && css.body.includes("AAA-CSS") && !css.body.includes("BBB"), "status=" + css.status);
  check("style.css 的 content-type = text/css", String(css.headers["content-type"] ?? "").startsWith("text/css"), "ct=" + String(css.headers["content-type"]));
  check("CSS 这类子资源**不**加沙箱头（只有能跑脚本的文档才加）", css.headers["content-security-policy"] === undefined);
  const png = await raw(P("sub/pic.png"));
  check("pic.png → 200 且是**本项目**那份", png.status === 200 && png.body === "AAA-PNG", "status=" + png.status + " body=" + png.body);
  check("pic.png 的 content-type = image/png", String(png.headers["content-type"] ?? "") === "image/png");
  const other = await raw(`/api/preview/project/${PB}/sub/style.css`);
  check("另一个项目拿到的仍是它自己的那份（同名文件不串项目）", other.status === 200 && other.body.includes("BBB-CSS"), "status=" + other.status);

  // ── 3. 点段 / 越界 / 未知项目：预览路由不过令牌闸门，必须自己挡 ──────
  section("3. 点段 / 越界 / 未知项目");
  const env = await raw(P("sub/.env"));
  check("点文件 .env → 403，且不回内容", env.status === 403 && !env.body.includes("SECRET"), "status=" + env.status);
  const envEnc = await raw(P("sub/%2eenv"));
  check("编码的点段（%2eenv）→ 403", envEnc.status === 403, "status=" + envEnc.status);
  const git = await raw(P(".git/config"));
  check("点目录里的文件（.git/…）→ 403", git.status === 403, "status=" + git.status);
  const queryEnv = await raw(`/api/preview/file?path=sub/.env&projectId=${PA}`);
  check("query 形也挡点文件（同一条判据）", queryEnv.status === 403, "status=" + queryEnv.status);
  const link = await raw(P("sub/escape-link"));
  check("软链指向工作区外 → 403（realpath 那道）", link.status === 403, "status=" + link.status);
  const unknown = await raw("/api/preview/project/9999999/a.html");
  check("未知项目 → 404（不是 200 也不是 500）", unknown.status === 404, "status=" + unknown.status);

  // query 形的 HTML 会注入 <base>：必须指回**项目路径形**（基址里的 query 不会被子资源继承）
  section("4. query 形注入的 base");
  const injected = await raw(`/api/preview/file?path=sub/page.html&projectId=${PA}`);
  check("query 形 HTML → 200 且 <base> 指到项目路径形",
    injected.status === 200 && injected.body.includes(`<base href="/api/preview/project/${PA}/sub/">`), "status=" + injected.status);

  // ── 5. 下载路由：令牌闸门之内，点文件照给 ──────────────────
  section("5. /api/file/download");
  const dlNoTok = await raw(`/api/file/download?projectId=${PA}&path=sub/pic.png`);
  check("不带令牌 → 401（在闸门之内）", dlNoTok.status === 401, "status=" + dlNoTok.status);
  const dl = await raw(`/api/file/download?projectId=${PA}&path=sub/pic.png`, { headers: AUTH });
  check("带令牌 → 200 + 字节 + Content-Length",
    dl.status === 200 && dl.body === "AAA-PNG" && dl.headers["content-length"] === "7",
    "status=" + dl.status + " len=" + String(dl.headers["content-length"]));
  const dlEnv = await raw(`/api/file/download?projectId=${PA}&path=sub/.env`, { headers: AUTH });
  check("带令牌下载 .env → 200（已鉴权的下载与预览路由的分工）", dlEnv.status === 200 && dlEnv.body.includes("SECRET=AAA"), "status=" + dlEnv.status);
  const dlEsc = await raw(`/api/file/download?projectId=${PA}&path=..%2f..%2f..%2f..%2fetc%2fhosts`, { headers: AUTH });
  check("越界路径 → 403", dlEsc.status === 403, "status=" + dlEsc.status);
  const dlLink = await raw(`/api/file/download?projectId=${PA}&path=sub/escape-link`, { headers: AUTH });
  check("软链指向工作区外 → 403", dlLink.status === 403, "status=" + dlLink.status);
  const dlDir = await raw(`/api/file/download?projectId=${PA}&path=sub`, { headers: AUTH });
  check("目录 → 400（不是 200 的空文件）", dlDir.status === 400, "status=" + dlDir.status);
  const dlHtml = await raw(`/api/file/download?projectId=${PA}&path=sub/page.html`, { headers: AUTH });
  check("下载口给的 html 也带沙箱（?token= 是明文，顶层打开时只有响应头管得住）",
    dlHtml.status === 200 && String(dlHtml.headers["content-security-policy"] ?? "").includes("sandbox"), "status=" + dlHtml.status);

  // ── 6. Host 反 rebinding：预览路由与下载路由都要过 ──────────────
  section("6. Host 反 rebinding");
  const evilPreview = await raw(P("sub/page.html"), { headers: { Host: "evil.example" } });
  check("Host=evil.example 的项目预览 → 403", evilPreview.status === 403, "status=" + evilPreview.status);

  // ── 7. 外站代理：回来的 HTML 同样要进沙箱 ──────────────────────
  // 代理的意义就是「同源才绕得过 frame 限制」—— 代理回来的页面**跑在面板同源**，
  // 用户随手打开的任何公网页面都在这里过：不给沙箱 = 任意公网页面能读走令牌。
  // 靶子用本机 upstream（_isolate.ts 为测试放开了代理的回环限制，正式内核的默认值没变）。
  section("7. 外站代理的沙箱");
  const upstream = createServer((_q, s) => {
    s.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    s.end("<!doctype html><html><head></head><body>UPSTREAM</body></html>");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const upAddr = upstream.address();
  const upPort = upAddr && typeof upAddr === "object" ? upAddr.port : 0;
  try {
    const proxied = await raw(`/api/preview/proxy?url=${encodeURIComponent(`http://127.0.0.1:${upPort}/`)}`, { headers: { Accept: "text/html" } });
    const pcsp = String(proxied.headers["content-security-policy"] ?? "");
    check("代理 HTML → 200 + 沙箱 + 无 allow-same-origin",
      proxied.status === 200 && pcsp.includes("sandbox") && !pcsp.includes("allow-same-origin"),
      "status=" + proxied.status + " csp=" + pcsp);
    check("代理 HTML 仍注入 <base>（相对链接靠它解析回源站）", proxied.body.includes("<base href="));
  } finally { upstream.close(); }
} catch (e) {
  failed++;
  console.log("  ❌ 冒烟脚本自己抛了：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  try { server?.close(); } catch { /* ignore */ }
}

section("结果");
console.log("  通过 " + passed + " / 失败 " + failed);
console.log(failed === 0 ? "✅ 预览路由（项目作用域 / 相对子资源 / 点段 / 下载）全部通过" : "❌ 有失败项，见上面");
finish(svc, failed === 0 ? 0 : 1);
