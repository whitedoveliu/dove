#!/usr/bin/env node
/**
 * 本机准入自测：8790 的 Host 反 rebinding + API 令牌闸门
 * 运行：cd harness && node --no-warnings scripts/smoke-auth.ts
 *
 * 为什么要有这个脚本：令牌机制（packages/server/src/local-token.ts）当初是为 8008 兼容层
 * 造的，8790 一直裸着。裸着的 8790 有两个真实入口，都不需要「读到」令牌：
 *   ① 简单请求：跨源页面发一个 text/plain 的 POST 不触发预检，浏览器直接放行 ——
 *      任意网页都能 POST /api/chat 开回合、POST /api/approve 批准工具调用；
 *   ② DNS rebinding：页面以为自己**同源**（地址栏 evil.example，DNS 指向 127.0.0.1），
 *      于是 GET /api/local-token 在浏览器眼里是「同源读取」，连 CORS 都不用 ——
 *      令牌直接被拿走，然后 8008 的锁也一起失效。
 * 两条都只能靠服务端挡：① 令牌闸门；② Host 必须是 loopback 字面量。
 *
 * 端口是本脚本分配的（8861/8862），不碰用户正在跑的 Dove。
 */
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库与配置指到临时目录，别碰生产库
import { createServer, request as httpRequest, type Server } from "node:http";
import { loadConfig, bootstrap, type Services } from "../packages/server/src/bootstrap.ts";
import { handle } from "../packages/server/src/routes.ts";
import { SseHub } from "../packages/server/src/sse.ts";
import { loadOrMintToken } from "../packages/server/src/local-token.ts";
import { finish } from "./_lifecycle.ts";

const PORT = 8861;          // 带令牌的内核
const PORT_NOAUTH = 8862;   // 进程内测试服务（无令牌）
process.env.DOVE_PORT = String(PORT);

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};
const section = (t: string): void => { console.log("\n=== " + t + " ==="); };

interface Raw { status: number; body: string; headers: Record<string, string | string[] | undefined> }

/**
 * 用 node:http 而不是 fetch —— 因为要能**自己指定 Host**（fetch 把 Host 当禁改头）。
 * rebinding 的判据全在 Host 上，这正是不用 fetch 的原因。
 */
function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers ?? {} },
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
let server: Server | null = null;
let serverNoAuth: Server | null = null;

try {
  svc = await bootstrap(loadConfig());
  const token = loadOrMintToken(svc.cfg.configDir);
  const hub = new SseHub();

  server = createServer((req, res) => {
    handle(req, res, { svc: svc!, hub, controlPanelDir: "", running: new Map(), token })
      .catch(() => { try { res.writeHead(500); res.end(); } catch { /* ignore */ } });
  });
  await new Promise<void>((r) => server!.listen(PORT, "127.0.0.1", () => r()));

  // 无令牌的进程内服务：smoke 脚本全都这么用，按既有约定**不设闸门**
  serverNoAuth = createServer((req, res) => {
    handle(req, res, { svc: svc!, hub, controlPanelDir: "", running: new Map() })
      .catch(() => { try { res.writeHead(500); res.end(); } catch { /* ignore */ } });
  });
  await new Promise<void>((r) => serverNoAuth!.listen(PORT_NOAUTH, "127.0.0.1", () => r()));

  const AUTH = { "X-Dove-Token": token };

  // ── 1. 豁免路径：健康检查与令牌自举必须免闸门 ──────────────
  section("1. 豁免路径");
  const health = await raw(PORT, "/api/health");
  check("/api/health 不要令牌", health.status === 200 && jsonOf(health).ok === true, "status=" + health.status);

  const boot = await raw(PORT, "/api/local-token");
  check("/api/local-token 免令牌且能把令牌交给同源面板", boot.status === 200 && jsonOf(boot).token === token);
  check("自举响应默认**不带** CORS 头（跨源页面读不到）", boot.headers["access-control-allow-origin"] === undefined);

  const bootLoop = await raw(PORT, "/api/local-token", { headers: { Origin: "http://localhost:3055" } });
  check("白名单里的面板源（自测静态服务 3055）回显 CORS", bootLoop.headers["access-control-allow-origin"] === "http://localhost:3055");

  // 安全边界：白名单之外的**本机**端口也不给 —— 以前任意 loopback 端口都回显，等于
  // 用户本机随便一个页面都能读走令牌（令牌到手 ≈ 内核到手）。白名单见 panel-origin.ts。
  const bootOtherPort = await raw(PORT, "/api/local-token", { headers: { Origin: "http://localhost:4399" } });
  check("白名单外的本机端口（4399）不回显 CORS", bootOtherPort.headers["access-control-allow-origin"] === undefined);

  // 3006 是**故意**不在名单里的：3000–3099 是项目 dev server 的区间（模型产出的网站），
  // 开发态面板走 vite 自己的代理，不需要 CORS。见 panel-origin.ts。
  const bootDevPort = await raw(PORT, "/api/local-token", { headers: { Origin: "http://localhost:3006" } });
  check("项目端口区间（3006）不回显 CORS", bootDevPort.headers["access-control-allow-origin"] === undefined);

  const bootSame = await raw(PORT, "/api/local-token", { headers: { Origin: "http://127.0.0.1:" + PORT } });
  check("同源（Origin 与 Host 逐字相同）回显 CORS", bootSame.headers["access-control-allow-origin"] === "http://127.0.0.1:" + PORT);

  const bootEvil = await raw(PORT, "/api/local-token", { headers: { Origin: "https://evil.example" } });
  check("非 loopback Origin 不回显 CORS", bootEvil.headers["access-control-allow-origin"] === undefined);

  // ── 2. 令牌闸门 ──────────────────────────────────────
  section("2. 令牌闸门");
  const noTok = await raw(PORT, "/api/threads");
  check("不带令牌 → 401", noTok.status === 401, "status=" + noTok.status + " " + String(jsonOf(noTok).error ?? "").slice(0, 40));

  const badTok = await raw(PORT, "/api/threads", { headers: { "X-Dove-Token": "deadbeef".repeat(8) } });
  check("错令牌 → 401", badTok.status === 401, "status=" + badTok.status);

  const goodTok = await raw(PORT, "/api/threads", { headers: AUTH });
  // GET /api/threads 直接返回数组（不是 {threads: […] }）—— 断言真实形状，别断言我记忆里的形状
  const threadsArr = (() => { try { return JSON.parse(goodTok.body) as unknown; } catch { return null; } })();
  check("对令牌（头）→ 200 且返回真实数据", goodTok.status === 200 && Array.isArray(threadsArr), "status=" + goodTok.status);

  const qTok = await raw(PORT, "/api/threads?token=" + encodeURIComponent(token));
  check("对令牌（?token=，EventSource 用）→ 200", qTok.status === 200, "status=" + qTok.status);

  const post = await raw(PORT, "/api/steer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: "x", message: "hi" }) });
  check("写类端点（/api/steer）不带令牌 → 401", post.status === 401, "status=" + post.status);

  // ── 3. Host 反 rebinding ─────────────────────────────
  section("3. Host 反 rebinding");
  const rebindToken = await raw(PORT, "/api/local-token", { headers: { Host: "evil.example" } });
  check("Host=evil.example 取令牌 → 403（这条是 rebinding 的要害）", rebindToken.status === 403, "status=" + rebindToken.status);

  const rebindChat = await raw(PORT, "/api/chat", { method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ threadId: "t", message: "hi" }) });
  check("Host=evil.example + 对令牌 → 依然 403", rebindChat.status === 403, "status=" + rebindChat.status);

  const hostLocalhost = await raw(PORT, "/api/threads", { headers: { Host: "localhost:" + PORT, ...AUTH } });
  check("Host=localhost:PORT 放行", hostLocalhost.status === 200, "status=" + hostLocalhost.status);

  const hostLoop = await raw(PORT, "/api/threads", { headers: { Host: "127.0.0.1:" + PORT, ...AUTH } });
  check("Host=127.0.0.1:PORT 放行", hostLoop.status === 200, "status=" + hostLoop.status);

  // ── 4. 豁免路径不能被外层闸门误伤 ────────────────────
  section("4. 豁免路径不被外层闸门误伤");
  const toolsList = await raw(PORT, "/api/tools/list?session=nope&token=nope");
  check("/api/tools/* 走自己的 session+token 闸门（403，而不是 401）", toolsList.status === 403, "status=" + toolsList.status);

  const preview = await raw(PORT, "/api/preview/file?path=/nonexistent");
  check("/api/preview/* 不被 401 挡住（浏览器内嵌资源发不了自定义头）", preview.status !== 401, "status=" + preview.status);

  // ── 5. 无令牌的进程内服务保持原样 ─────────────────────
  section("5. 无令牌的进程内服务不设闸门（既有约定）");
  const noAuth = await raw(PORT_NOAUTH, "/api/threads");
  check("deps.token 缺省 → 放行（smoke 脚本与嵌入式用法）", noAuth.status === 200, "status=" + noAuth.status);
} catch (e) {
  failed++;
  console.log("  ❌ 冒烟脚本自己抛了：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  server?.close();
  serverNoAuth?.close();
}

section("结果");
console.log("  通过 " + passed + " / 失败 " + failed);
console.log(failed === 0 ? "✅ 本机准入（Host + 令牌）全部通过" : "❌ 有失败项，见上面");
finish(svc, failed === 0 ? 0 : 1);
