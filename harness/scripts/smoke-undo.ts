#!/usr/bin/env node
/**
 * 撤销（append-only）端到端自测：store → HTTP 路由 → CLI 子命令
 * 运行：cd harness && node --no-warnings scripts/smoke-undo.ts
 *
 * 为什么要有这个脚本：撤销最容易被实现成「删行」——那样一来历史没了、日志也对不上，
 * 而「撤销」本该是**只标记、不删数据**（对照 Kimi Code 的「undo = 新分支」与
 * Codex 的 `ThreadRolledBack` 标记：两家都不改写已有记录）。
 * 所以这里断言的重点不是「消息不见了」，而是：
 *   ① 模型看得见的历史里不见了；② 磁盘上原始行仍在（undone_at 标记）；③ 日志里追加了一条记录。
 *
 * 端口是本脚本分配的（8871 已被 smoke-goal-eval 占用，这里用 8881），不碰用户在跑的 Dove。
 */
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库与配置指到临时目录
import { createServer, request as httpRequest, type Server } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, bootstrap, type Services } from "../packages/server/src/bootstrap.ts";
import { handle } from "../packages/server/src/routes.ts";
import { SseHub } from "../packages/server/src/sse.ts";
import { loadOrMintToken } from "../packages/server/src/local-token.ts";
import { journalFile, openJournal } from "../packages/core/src/session/journal.ts";
import { finish } from "./_lifecycle.ts";

const PORT = 8881;
process.env.DOVE_PORT = String(PORT);

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};
const section = (t: string): void => { console.log("\n=== " + t + " ==="); };

interface Raw { status: number; body: string }
function raw(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path, method: opts.method ?? "GET", headers: opts.headers ?? {} }, (res) => {
      let body = ""; res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("超时")));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const J = (body: string): Record<string, unknown> => { try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; } };

/**
 * 异步跑一次 CLI。
 * ⚠️ **必须异步**：这个脚本的内核就跑在**同一个进程**里，而 `spawnSync` 会把事件循环整个冻住 ——
 * 子进程发出的 /api/health 探活永远等不到回答，表现成「没找到在跑的内核」。
 * （第一版就是这么栽的：CLI 报错说端口文件读到了、但没人响应。）
 */
function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", "bin/dove.mjs", ...args], {
      cwd: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const THREAD = "th_undo_smoke";
let svc: Services | null = null;
let server: Server | null = null;

try {
  svc = await bootstrap(loadConfig());
  const store = svc.store;
  const token = loadOrMintToken(svc.cfg.configDir);
  const hub = new SseHub();
  server = createServer((req, res) => {
    handle(req, res, { svc: svc!, hub, controlPanelDir: "", running: new Map(), token })
      .catch(() => { try { res.writeHead(500); res.end(); } catch { /* ignore */ } });
  });
  await new Promise<void>((r) => server!.listen(PORT, "127.0.0.1", () => r()));
  const H = { "X-Dove-Token": token, "Content-Type": "application/json" };
  const post = (p: string, body: unknown) => raw(p, { method: "POST", headers: H, body: JSON.stringify(body) });

  // ── 造 3 轮真实对话（直写库，不走模型）────────────────
  section("1. 造数据：3 轮真实用户消息");
  store.createThread({ id: THREAD, kind: "project", projectId: null, title: "undo smoke" });
  // ⚠️ 时间戳必须**真实交错**（u1,a1,u2,a2,u3,a3）：助手回复如果统一晚于所有用户消息，
  //    「最后一个真实用户消息之后的一切」就会把前几轮的回复也框进去 —— 那是我的测试数据不真实，
  //    不是撤销写错了（第一次跑就是这么栽的，断言差值对不上才发现）。
  const mkUser = (n: number) => ({
    id: `${THREAD}--u-${n}`, threadId: THREAD, role: "user" as const,
    parts: [{ type: "text" as const, text: `第 ${n} 轮的问题` }], createdAt: 1_000 + n * 10,
  });
  const mkAsst = (n: number) => ({
    id: `${THREAD}--a-${n}`, threadId: THREAD, role: "assistant" as const,
    parts: [{ type: "text" as const, text: `第 ${n} 轮的回答` }], createdAt: 1_000 + n * 10 + 1,
  });
  for (const n of [1, 2, 3]) { store.addMessage(mkUser(n)); store.addMessage(mkAsst(n)); }
  const beforeAll = store.listMessages(THREAD).length;
  const beforeVisible = store.recentMessages(THREAD, 100).length;
  check("库里有 6 条消息", beforeAll === 6, "listMessages=" + beforeAll);
  check("可见历史也是 6 条", beforeVisible === 6, "recentMessages=" + beforeVisible);
  check("可撤销 3 轮", store.undoableTurns(THREAD) === 3, "undoableTurns=" + store.undoableTurns(THREAD));

  // ── 撤销 1 轮 ────────────────────────────────────────
  section("2. 撤销 1 轮（HTTP 路由）");
  const r1 = await post(`/api/threads/${THREAD}/undo`, { turns: 1 });
  const b1 = J(r1.body);
  check("返回 200", r1.status === 200, "status=" + r1.status);
  check("undone=1", b1.undone === 1, JSON.stringify(b1));
  check("可见历史少 2 条（一轮 = 用户 + 回答）", store.recentMessages(THREAD, 100).length === beforeVisible - 2,
    "recentMessages=" + store.recentMessages(THREAD, 100).length);
  check("**磁盘上一条都没删**（这是纪律）", store.listMessages(THREAD).length === beforeAll,
    "listMessages=" + store.listMessages(THREAD).length);
  check("被撤的消息带 undoneAt 标记", store.listMessages(THREAD).some((m) => m.undoneAt !== undefined));
  check("可撤销剩 2 轮", store.undoableTurns(THREAD) === 2, "undoableTurns=" + store.undoableTurns(THREAD));

  // ── 日志里留了记录（可重放的那一份）────────────────────
  section("3. 线程日志里追加了 context.undo");
  const jf = journalFile(svc.cfg.configDir, THREAD);
  const recs = openJournal(svc.cfg.configDir, THREAD).readAll();
  const undoRec = recs.find((r) => r.type === "context.undo");
  check("日志文件存在", jf.length > 0);
  check("有 context.undo 记录", Boolean(undoRec), "记录类型：" + recs.map((r) => r.type).join(","));
  check("第 1 行是 metadata 且带 protocol_version",
    recs[0]?.type === "metadata" && Number((recs[0] as unknown as { protocol_version?: number }).protocol_version) >= 1,
    JSON.stringify(recs[0] ?? {}).slice(0, 120));
  check("行号即序号（连续从 1 开始）", recs.every((r, i) => r.seq === i + 1), recs.map((r) => r.seq).join(","));

  // ── 撤销超出可用轮数：不动作 + 说清差多少 ────────────────
  section("4. 撤销不了要说清，不许假装成功");
  const r2 = await post(`/api/threads/${THREAD}/undo`, { turns: 99 });
  const b2 = J(r2.body);
  check("状态码 409（不是 200）", r2.status === 409, "status=" + r2.status);
  check("reason 说清了差多少", typeof b2.reason === "string" && /(轮|available|不足|只有)/.test(String(b2.reason)), String(b2.reason ?? ""));
  check("没动作：可见历史不变", store.recentMessages(THREAD, 100).length === beforeVisible - 2);

  // ── CLI 子命令真的通了 ───────────────────────────────
  // 走**端口文件发现**这条路（与 smoke-cli.mjs 同一套）：内核进程不在这个脚本里，
  // 所以我们自己把 `<DOVE_CONFIG>/port` 写上（格式与 server/discovery.ts 一致）。
  // 不要用 DOVE_PORT —— runCli 那套会主动删掉它，端口文件才是生产路径。
  section("5. dove undo（CLI，走端口文件发现）");
  writeFileSync(join(process.env.DOVE_CONFIG ?? "", "port"), String(PORT) + "\n", "utf8");
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.DOVE_PORT;
  const cli = await runCli(["undo", "--turns", "1", "--thread", THREAD, "--json"], childEnv);
  const cliOut = cli.out;
  check("CLI 退出码 0", cli.code === 0, "status=" + cli.code + " " + cliOut.slice(0, 200));
  check("CLI 输出 JSON 且 undone=1", /"undone":1/.test(cliOut), cliOut.slice(0, 200));
  check("又撤了一轮 → 可撤销剩 1", store.undoableTurns(THREAD) === 1, "undoableTurns=" + store.undoableTurns(THREAD));
  check("磁盘上仍然一条都没删", store.listMessages(THREAD).length === beforeAll);
} catch (e) {
  failed++;
  console.log("  ❌ 冒烟脚本自己抛了：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  server?.close();
}

section("结果");
console.log("  通过 " + passed + " / 失败 " + failed);
console.log(failed === 0 ? "✅ 撤销（append-only）+ 线程日志全部通过" : "❌ 有失败项，见上面");
finish(svc, failed === 0 ? 0 : 1);
