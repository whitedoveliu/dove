/**
 * Dove Harness 入口
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, bootstrap } from "./bootstrap.ts";
import { loadOrMintToken } from "./local-token.ts";
import { SseHub } from "./sse.ts";
import { handle } from "./routes.ts";
import { startLegacyServer } from "./legacy/server.ts";

const cfg = loadConfig();

/**
 * 端口预检：**在启动任何重服务之前**先确认端口能用。
 *
 * 为什么要有：不预检的话，端口被占时会在 bootstrap() 启动完截屏/输入监听/调度器
 * 之后才在 listen() 抛 EADDRINUSE，留下一堆刚起来的子进程和无意义的堆栈。
 */
async function preflightPort(port: number): Promise<{ ok: boolean; holder?: number }> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => {
      // 谁占着？给用户一个能直接用的提示
      import("node:child_process").then(({ execSync }) => {
        try {
          const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: "utf8" });
          const pid = Number(out.trim().split("\n")[0]);
          resolve({ ok: false, holder: Number.isFinite(pid) ? pid : undefined });
        } catch { resolve({ ok: false }); }
      }).catch(() => resolve({ ok: false }));
    });
    srv.once("listening", () => srv.close(() => resolve({ ok: true })));
    srv.listen(port, "127.0.0.1");
  });
}

const pre = await preflightPort(cfg.port);
if (!pre.ok) {
  console.error(`\n[dove] 端口 ${cfg.port} 已被占用，内核没有启动。`);
  if (pre.holder) {
    console.error(`       占用者 pid = ${pre.holder}`);
    console.error(`       如果那是上一次没退干净的 Dove： kill ${pre.holder}`);
    console.error(`       想换端口： DOVE_PORT=8791 node packages/server/src/main.ts`);
  }
  process.exit(2);
}

const svc = await bootstrap(cfg);

// 本地令牌：启动时取（有就复用、没有就生成 0600）—— 面板过 8008 闸门用的就是它。
// 放在 bootstrap 之后、起服务之前：日志桥已经装好，这条「令牌文件已生成」会进日志缓冲。
const apiToken = loadOrMintToken(cfg.configDir);

/**
 * 父进程看门狗：桌面 App 被杀 / 崩溃 / 强退时，内核不能变成孤儿。
 *
 * 为什么需要它：Tauri 的 RunEvent::Exit 只在「正常退出」路径触发。
 * 实测给 app 发 SIGTERM 时它不跑 —— app 没了、内核还在、端口还占着，
 * 下次启动就撞端口。
 *
 * 只在 App 显式设了 DOVE_EXIT_WITH_PARENT=1 时启用：
 * 手动在终端跑或 nohup 当服务跑时 ppid 本来就是 1，不能自杀。
 */
if (process.env.DOVE_EXIT_WITH_PARENT === "1") {
  const parent = process.ppid;
  const wd = setInterval(() => {
    if (process.ppid !== parent || process.ppid === 1) {
      console.log("[dove] 父进程已退出，内核跟着停");
      try { svc.shutdown(); } catch { /* ignore */ }
      process.exit(0);
    }
  }, 1500);
  wd.unref();
}
const hub = new SseHub();
const running = new Map<string, AbortController>();
// 产品界面 = control-panel 的构建产物
const controlPanelDir = process.env.DOVE_CONTROL_PANEL_DIR
  ?? resolve(import.meta.dirname, "../../../../control-panel/dist");

const server = createServer((req, res) => {
  handle(req, res, { svc, hub, controlPanelDir, running, token: apiToken }).catch((e) => {
    console.error("[server] 未处理错误:", e);
    try { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e) })); } catch { /* ignore */ }
  });
});

// 内核侧事件（cron / heartbeat）→ SSE 广播
svc.onEvent((e) => {
  for (const c of hub.allClients()) hub.send(c, e);
});
// cron 与 heartbeat 在服务起来后再启动（避免启动期就触发任务）
setTimeout(() => {
  try { svc.cron?.start(); } catch (e) { console.error("[dove] cron 启动失败:", e); }
  try { svc.heartbeat?.start(); } catch (e) { console.error("[dove] heartbeat 启动失败:", e); }
}, 2_000);

// listen 失败也要走清理路径，不能抛未捕获异常（会跳过 shutdown 留下子进程）
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(`\n[dove] 内核启动失败：${e.code ?? ""} ${e.message}`);
  try { svc.shutdown(); } catch { /* ignore */ }
  process.exit(2);
});

// ── 面板兼容层（8008）：让 control-panel 一行不改地跑在内核上 ──
//    带上令牌：除 /api/health 外，/api/* 一律要它（见 legacy/server.ts 的令牌闸门）
const legacyPort = Number(process.env.DOVE_LEGACY_PORT ?? 8008);
let legacy: Awaited<ReturnType<typeof startLegacyServer>> = null;
if (process.env.DOVE_LEGACY !== "off") {
  legacy = await startLegacyServer(svc, legacyPort, apiToken);
  if (legacy) console.log(`[dove] 兼容层: http://127.0.0.1:${legacy.port}（control-panel 用这个）`);
  else console.warn(`[dove] 兼容层没起来：端口 ${legacyPort} 被占用（control-panel 会连不上后端）`);
}

server.listen(cfg.port, "127.0.0.1", () => {
  const panel = existsSync(controlPanelDir) ? `http://127.0.0.1:${cfg.port}/` : "(界面未构建：cd control-panel && npm run build)";
  console.log(`[dove] harness 已启动  http://127.0.0.1:${cfg.port}`);
  console.log(`[dove] 面板: ${panel}`);
  console.log(`[dove] 模型: ${cfg.model}  工作区: ${cfg.workspaceRoot}  配置: ${cfg.configDir}`);
  console.log(`[dove] 工具: ${svc.tools.size} 个  记忆: ${svc.memory ? "已启用" : "未启用"}`);
  console.log(`[dove] 主动性: ${svc.cron ? "cron + heartbeat 已启动" : "未接入"}`);
});

function shutdown(): void {
  console.log("\n[dove] 正在关闭…");
  try { legacy?.close(); } catch { /* ignore */ }
  hub.close();
  try { svc.shutdown(); } catch (e) { console.error("[dove] 关闭时出错:", e); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
