/**
 * 本地令牌（8008 兼容层的闸门）—— 端到端：真起兼容层、真发 HTTP。
 *
 * 为什么放在 core/test 下：`npm test` 只扫这个目录（服务器路由没有自己的测试目录，
 * 同 capture.test.ts）。被测的是 packages/server/src/local-token.ts 与 legacy/server.ts 的闸门，
 * 断言的是**面板与攻击者真正看到的东西**：无令牌 / 错令牌 401、对令牌放行、/api/health 不过闸、
 * /preview/* 要 ?token=（它服务的是项目目录里的任意文件）、401 响应不带 CORS 头、
 * 令牌文件 0600 且重启复用。
 *
 * 端口一律用 0（系统分配）：用户在跑的 App 可能正占着 8008 / 8790，测试绝不碰它们。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Services } from "../../server/src/bootstrap.ts";
import { startLegacyServer } from "../../server/src/legacy/server.ts";
import { loadOrMintToken, readTokenFile, tokenFilePath, tokenMatches, requestToken } from "../../server/src/local-token.ts";
import { handle } from "../../server/src/routes.ts";
import { SseHub } from "../../server/src/sse.ts";

const cfgDir = mkdtempSync(join(tmpdir(), "dove-token-cfg-"));
const projDir = mkdtempSync(join(tmpdir(), "dove-token-proj-"));
writeFileSync(join(projDir, "index.html"), "<h1>预览内容</h1>");

const PROJECT = { id: "p1", name: "桩项目", path: projDir, port: 4321 };

/** 最小 Services 桩：只喂闸门与 /api/health、/api/projects*、/preview 真正要读的字段 */
function stubServices(): Services {
  return {
    tools: new Map(),
    projects: { list: () => [PROJECT], get: (id: string) => (id === "p1" ? PROJECT : null) },
    store: { listThreads: () => [], listMessages: () => [] },
  } as unknown as Services;
}

// 与内核同一条路径：真生成 / 真复用
const TOKEN = loadOrMintToken(cfgDir);

const legacy = await startLegacyServer(stubServices(), 0, TOKEN);
assert.ok(legacy, "兼容层应该起得来");
const LEGACY = `http://127.0.0.1:${legacy.port}`;

const hub = new SseHub();
const kernel: Server = createServer((req, res) => {
  handle(req, res, {
    svc: stubServices(), hub, controlPanelDir: "/nonexistent-panel", running: new Map(), token: TOKEN,
  }).catch(() => { try { res.writeHead(500); res.end(); } catch { /* 已经写过头 */ } });
});
await new Promise<void>((r) => kernel.listen(0, "127.0.0.1", () => r()));
const addr = kernel.address();
const KERNEL = `http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`;

after(() => {
  legacy.close();
  hub.close();
  kernel.close();
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

const hit = (base: string, path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

/* ───────────────────────── 令牌文件（要求 f） ───────────────────────── */

test("令牌文件：首次启动生成 0600、形状合法，重启复用同一把", () => {
  const file = tokenFilePath(cfgDir);
  assert.ok(existsSync(file), "启动后应该有令牌文件");
  assert.match(TOKEN, /^[0-9a-f]{32,}$/, "≥32 个十六进制字符");
  assert.equal(statSync(file).mode & 0o777, 0o600, "文件权限必须是 0600");

  // 「重启」= 再调一次：必须拿到同一把，否则开着的旧面板会整块 401
  assert.equal(loadOrMintToken(cfgDir), TOKEN);
  assert.equal(readTokenFile(file), TOKEN);
});

test("令牌文件：内容坏掉（被截断 / 手写垃圾）→ 重新生成，不拿坏令牌去比对", () => {
  const dir = mkdtempSync(join(tmpdir(), "dove-token-bad-"));
  try {
    const file = tokenFilePath(dir);
    writeFileSync(file, "not-a-token\n", { mode: 0o600 });
    const minted = loadOrMintToken(dir);
    assert.match(minted, /^[0-9a-f]{32,}$/);
    assert.notEqual(minted, "not-a-token");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("比对：空值 / 长度不齐 / 差一个字符都判否", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN, ""), false);
  assert.equal(tokenMatches("", TOKEN), false);
  assert.equal(tokenMatches(TOKEN, TOKEN + "a"), false);
  assert.equal(tokenMatches(TOKEN, TOKEN.slice(0, -1) + (TOKEN.endsWith("a") ? "b" : "a")), false);
});

/* ───────────────────── 闸门（要求 a~e） ───────────────────── */

test("闸门：不带令牌 → 401，正文是 unauthorized，且**不带** CORS 头", async () => {
  const res = await hit(LEGACY, "/api/projects");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: "unauthorized" });
  // 没有 CORS 头 = 跨源页面连这个响应体都读不到（正是要的效果）
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("access-control-allow-headers"), null);
});

test("闸门：错令牌 → 401（头和查询串两条路都不放行）", async () => {
  const wrong = "f".repeat(64);
  assert.equal((await hit(LEGACY, "/api/projects", { "X-Dove-Token": wrong })).status, 401);
  assert.equal((await hit(LEGACY, `/api/projects?token=${wrong}`)).status, 401);
  // 前缀对但长度不对（截断的令牌）也不放行
  assert.equal((await hit(LEGACY, "/api/projects", { "X-Dove-Token": TOKEN.slice(0, 32) })).status, 401);
});

test("闸门：对令牌 → 走原来那条路（200 + 老契约形状，CORS 头照旧）", async () => {
  const res = await hit(LEGACY, "/api/projects", { "X-Dove-Token": TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*", "面板跨源调 8008，这条不能变");
  const body = (await res.json()) as { projects?: { port: string }[] };
  assert.equal(body.projects?.[0]?.port, "4321");
});

test("闸门：`?token=` 查询串也认（EventSource 发不了自定义头，走这条）", async () => {
  const res = await hit(LEGACY, `/api/projects/4321/exists?token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { exists?: boolean }).exists, true);
});

test("闸门：/api/health 不过闸（面板靠它判断内核在不在）", async () => {
  const res = await hit(LEGACY, "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(((await res.json()) as { status?: string }).status, "ok");
});

test("闸门：/preview/* 要 ?token=（iframe / <img> 只能走查询串），且响应不带 CORS 头", async () => {
  // 2026-10 收紧：这条以前**不过闸** —— 实测 `curl /preview/4321/.env` 直接 200 吐文件，
  // 而这台机器上任意一个网页都能这样读走项目里的 .env。面板手里有令牌，把 ?token= 拼进
  // 资源 URL 即可（<img>/<video>/<iframe> 发不了自定义头，所以只能走查询串）。
  assert.equal((await hit(LEGACY, "/preview/4321/")).status, 401, "不带令牌必须 401");

  const res = await hit(LEGACY, `/preview/4321/?token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<h1>预览内容</h1>");
  // 去掉 ACAO `*`：这些字节只给带令牌的面板，跨源页面读了也拿不到（对比 /api/* 那条照旧的 CORS）
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("闸门：跨源页面（Origin: https://evil.example）不带令牌 → 401，且响应无 CORS 头", async () => {
  const res = await hit(LEGACY, "/api/settings/model", { Origin: "https://evil.example" });
  assert.equal(res.status, 401, "改模型 base URL / key 的入口必须先过闸");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("access-control-allow-headers"), null);
});

test("闸门：OPTIONS 预检不过闸（浏览器替面板发的预检不带自定义头）", async () => {
  const res = await fetch(`${LEGACY}/api/projects`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
});

test("闸门：startLegacyServer 少了令牌直接抛 —— 不许静默裸奔", async () => {
  await assert.rejects(() => startLegacyServer(stubServices(), 0), /令牌/);
});

/* ───────────── 令牌的取用口（8790，要求 2） ───────────── */

test("8790 /api/local-token：同源可读（无 Origin 头），响应里没有 CORS 头", async () => {
  const res = await hit(KERNEL, "/api/local-token");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { token: TOKEN });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("8790 /api/local-token：跨源页面（https://evil.example）拿不到 CORS 头 —— 浏览器读不到令牌", async () => {
  const res = await hit(KERNEL, "/api/local-token", { Origin: "https://evil.example" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("vary"), "Origin");
});

test("8790 /api/local-token：白名单里的面板源（自测静态服务 3055）回显 CORS", async () => {
  // 白名单在 packages/server/src/panel-origin.ts —— 改端口要同时改那里（或给内核 DOVE_PANEL_ORIGINS）。
  // 开发态（vite）不需要这条：它走 vite 自己的代理，对浏览器是同源请求。
  for (const origin of ["http://localhost:3055", "http://127.0.0.1:3055"]) {
    const res = await hit(KERNEL, "/api/local-token", { Origin: origin });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.deepEqual(await res.json(), { token: TOKEN });
  }
});

test("8790 /api/local-token：**别的**本机端口不回显 —— 任意本机页面读不到令牌", async () => {
  // 安全边界（以前是任一 loopback 端口都回显，等于本机任何页面都能拿走令牌）：
  // 4399 这种「本机随便一个服务」必须读不到，否则令牌到手 ≈ 内核到手。
  // 3006 也在名单外，而且是**故意**的：3000–3099 是项目 dev server 的区间，
  // 那上面跑的是模型产出的网站（见 panel-origin.ts；开发态面板走 vite 代理，不需要 CORS）。
  for (const origin of ["http://localhost:4399", "http://127.0.0.1:4321", "http://[::1]:3000", "http://localhost:3006", "http://127.0.0.1:3006"]) {
    const res = await hit(KERNEL, "/api/local-token", { Origin: origin });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null, origin + " 不该回显 CORS");
    assert.equal(res.headers.get("vary"), "Origin");
  }
});

test("8790 /api/local-token：同源（Origin 与 Host 逐字相同）回显 —— 桌面壳 / 内核托管的界面", async () => {
  const res = await hit(KERNEL, "/api/local-token", { Origin: KERNEL });
  assert.equal(res.headers.get("access-control-allow-origin"), KERNEL);
});

/* ───────────────────────── 令牌在请求里的解析 ───────────────────────── */

test("requestToken：头优先，头为空时退回查询串", () => {
  const url = new URL(`http://x/api/projects?token=${TOKEN}`);
  assert.equal(requestToken({ headers: {} } as never, url), TOKEN);
  assert.equal(requestToken({ headers: { "x-dove-token": "abc" } } as never, url), "abc");
  assert.equal(requestToken({ headers: { "x-dove-token": "  " } } as never, url), TOKEN);
});
