/**
 * 运维类子命令：health / status / version / logs / stop / steer / up
 *
 * `dove up` 为什么要自己 spawn 内核：CLI 是内核的**客户端**，正常情况下它不该负责启动。
 * 但没有这一步，第一次用 CLI 的人会撞上「没找到在跑的内核」然后卡住 ——
 * 所以给一条自助路径：后台起一个、日志落到 ~/.dove/logs/cli-kernel.log、轮询到就绪再返回。
 * 父进程立刻 unref 走人，内核不跟着 CLI 一起死（它本来就是常驻服务）。
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flagBool, flagNum, flagStr, freeText, type Args } from "./args.ts";
import { api, ApiError, configDir, probeHealth, resolveTarget, type Target } from "./client.ts";
import { bold, dim, EXIT, green, humanMs, note, out, red, shortTime, yellow } from "./out.ts";
import { resolveThread, NoThreadError } from "./threads.ts";

interface Health {
  ok?: boolean;
  version?: string;
  model?: string;
  threads?: number;
  tools?: number;
  memory?: boolean;
  projects?: number;
}

export async function cmdHealth(t: Target, a: Args): Promise<number> {
  const h = await api<Health>(t, "/api/health", { timeoutMs: 8_000 });
  if (flagBool(a, "json")) { out(JSON.stringify(h)); return EXIT.ok; }
  out(`${green("✓")} 内核在跑 ${bold(t.base)} ${dim("（来源：" + t.source + "）")}`);
  out(`  版本 ${h.version ?? "?"} · 模型 ${h.model ?? "?"} · 工具 ${h.tools ?? "?"} 个`);
  out(`  线程 ${h.threads ?? "?"} 个 · 项目 ${h.projects ?? "?"} 个 · 记忆 ${h.memory ? "已启用" : "未启用"}`);
  return EXIT.ok;
}

export async function cmdStatus(t: Target, a: Args): Promise<number> {
  const h = await api<Health>(t, "/api/health", { timeoutMs: 8_000 });
  let cfg: Record<string, unknown> = {};
  try { cfg = await api<Record<string, unknown>>(t, "/api/config", { timeoutMs: 8_000 }); } catch { /* 老内核没这条就算了 */ }
  const threads = await api<unknown[]>(t, "/api/threads", { timeoutMs: 8_000 }).catch(() => []);
  if (flagBool(a, "json")) { out(JSON.stringify({ base: t.base, source: t.source, health: h, config: cfg })); return EXIT.ok; }
  out(`${bold("内核")}    ${t.base}  ${dim("（" + t.source + "）")}`);
  out(`${bold("模型")}    ${h.model ?? String(cfg.model ?? "?")}${cfg.toolModel ? dim("（工具模型 " + String(cfg.toolModel) + "）") : ""}`);
  out(`${bold("工作区")}  ${String(cfg.workspaceRoot ?? "?")}`);
  out(`${bold("配置")}    ${String(cfg.configDir ?? configDir())}`);
  out(`${bold("规模")}    线程 ${threads.length} · 项目 ${h.projects ?? "?"} · 工具 ${h.tools ?? "?"} · 记忆 ${h.memory ? "已启用" : "未启用"}`);
  return EXIT.ok;
}

/** CLI 自己的版本（读 harness/package.json；读不到就写 unknown —— 不为一个版本号把命令搞失败） */
function cliVersion(): string {
  try {
    const pkg = join(resolve(import.meta.dirname, "../../.."), "package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "unknown";
  } catch { return "unknown"; }
}

export async function cmdVersion(a: Args): Promise<number> {
  const line = `dove CLI ${cliVersion()}`;
  let target: Target | null = null;
  try { target = await resolveTarget(flagNum(a, "port")); } catch { /* 内核没跑也算正常，version 要能离线回答 */ }
  if (!target) {
    out(`${line}  ${dim("（内核没在跑；dove up 可以把它起起来）")}`);
    return EXIT.ok;
  }
  const h = await api<Health>(target, "/api/health", { timeoutMs: 8_000 }).catch(() => null);
  if (flagBool(a, "json")) {
    out(JSON.stringify({ cli: cliVersion(), kernel: h?.version ?? null, port: target.port, model: h?.model ?? null }));
    return EXIT.ok;
  }
  out(`${line}  ${dim("·")}  内核 ${h?.version ?? "?"} ${dim("@ " + target.base)}  模型 ${h?.model ?? "?"}`);
  return EXIT.ok;
}

export async function cmdUp(a: Args): Promise<number> {
  // up 的端口顺序和别的命令不同：端口文件是**内核写的**，拿它猜「该把内核起在哪」是循环论证
  const port = flagNum(a, "port") ?? (Number(process.env.DOVE_PORT) || 8790);
  const timeoutS = flagNum(a, "timeout") ?? 60;

  if (await probeHealth(port)) {
    out(`${green("✓")} 内核已经在跑：http://127.0.0.1:${port} ${dim("（没有重复启动）")}`);
    return EXIT.ok;
  }

  const harnessDir = resolve(import.meta.dirname, "../../..");
  const entry = join(harnessDir, "packages/server/src/main.ts");
  const logDir = join(configDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "cli-kernel.log");

  const fd = openSync(logFile, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ["--no-warnings", entry], {
      cwd: harnessDir,
      detached: true,                       // 内核是常驻服务，不能跟着 CLI 一起死
      stdio: ["ignore", fd, fd],
      env: { ...process.env, DOVE_PORT: String(port) },
    });
  } finally {
    closeSync(fd);                          // 子进程已经拿到自己的副本，父进程这边必须关掉
  }
  child.unref();
  const pid = child.pid;

  let exited: number | null = null;
  child.on("exit", (code) => { exited = code ?? -1; });
  note(dim(`内核启动中（pid ${pid ?? "?"}，端口 ${port}，日志 ${logFile}）…`));

  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutS) {
    if (await probeHealth(port, 800)) {
      out(`${green("✓")} 内核已就绪 http://127.0.0.1:${port} ${dim(`（pid ${pid ?? "?"} · ${humanMs(Date.now() - t0)}）`)}`);
      out(dim(`  日志：${logFile}`));
      out(dim(`  试试：dove health / dove run "你好"`));
      return EXIT.ok;
    }
    if (exited !== null) {
      note(red("✗ ") + `内核起来就退了（退出码 ${exited}）。日志末尾：`);
      note(tailOf(logFile, 12));
      if (exited === 2) note(dim("  退出码 2 = 端口被占用或启动失败；换个端口：dove up --port 8791"));
      return EXIT.fail;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  note(red("✗ ") + `等了 ${timeoutS} 秒内核还没就绪（pid ${pid ?? "?"} 可能还在慢慢初始化）。`);
  note(dim(`  看日志：tail -f ${logFile}`));
  return EXIT.fail;
}

function tailOf(file: string, n: number): string {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-n).map((l) => "  " + l).join("\n");
  } catch { return "  （日志读不出来）"; }
}

export async function cmdLogs(t: Target, a: Args): Promise<number> {
  const limit = flagNum(a, "tail") ?? 50;
  const level = flagStr(a, "level");
  const q = new URLSearchParams({ limit: String(limit) });
  if (level) q.set("level", level);
  const r = await api<{ lines?: Record<string, unknown>[] }>(t, `/api/logs/runtime?${q}`, { timeoutMs: 8_000 });
  const lines = r.lines ?? [];
  if (flagBool(a, "json")) { for (const l of lines) out(JSON.stringify(l)); return EXIT.ok; }
  if (lines.length === 0) { out(dim("（没有日志）")); return EXIT.ok; }
  for (const l of lines) {
    const lv = String(l.level ?? "log");
    const tag = lv === "error" ? red(lv) : lv === "warn" ? yellow(lv) : dim(lv);
    out(`${dim(shortTime(Number(l.ts ?? 0)))} ${tag} ${String(l.text ?? "")}`);
  }
  return EXIT.ok;
}

export async function cmdStop(t: Target, a: Args): Promise<number> {
  let id: string;
  try {
    id = (await resolveThread(t, a, undefined, { allowCreate: false })).id;
  } catch (e) {
    if (e instanceof NoThreadError) { note(red("✗ ") + e.message); return EXIT.fail; }
    throw e;
  }
  const r = await api<{ stopped?: boolean }>(t, "/api/stop", { body: { threadId: id }, timeoutMs: 8_000 });
  if (flagBool(a, "json")) { out(JSON.stringify({ threadId: id, stopped: Boolean(r.stopped) })); return EXIT.ok; }
  // 没有在跑的回合**不是失败**：stop 幂等，脚本里连着调两次不该报错
  out(r.stopped ? `已停止 ${id}` : dim(`${id} 当前没有在跑的回合`));
  return EXIT.ok;
}

export async function cmdUndo(t: Target, a: Args): Promise<number> {
  const asked = flagStr(a, "turns") ?? freeText(a);
  const turns = Number.isFinite(Number(asked)) && Number(asked) > 0 ? Math.floor(Number(asked)) : 1;
  let id: string;
  try {
    id = (await resolveThread(t, a, undefined, { allowCreate: false })).id;
  } catch (e) {
    if (e instanceof NoThreadError) { note(red("✗ ") + e.message); return EXIT.fail; }
    throw e;
  }
  try {
    const r = await api<{ undone?: number; available?: number; reason?: string }>(
      t, `/api/threads/${encodeURIComponent(id)}/undo`, { body: { turns }, timeoutMs: 15_000 },
    );
    if (flagBool(a, "json")) { out(JSON.stringify({ threadId: id, turns, ...r })); return r.undone ? EXIT.ok : EXIT.fail; }
    out(`已撤销 ${r.undone} 轮（${id}）。磁盘上的历史一个字都没删 —— 只是标记为已撤销，日志里追加了一条 context.undo。`);
    return EXIT.ok;
  } catch (e) {
    // 撤销不了是**预期结果**，不是「内核出错」：内核用 409 + reason 说清了差多少。
    // 不在这里接住的话，用户看到的是通用的「内核返回 409：{...}"——信息在，但像是故障。
    if (e instanceof ApiError && e.status === 409) {
      const reason = (e.body as { reason?: string } | null)?.reason ?? "没有可撤销的轮次";
      if (flagBool(a, "json")) { out(JSON.stringify({ threadId: id, turns, undone: 0, reason })); return EXIT.fail; }
      note(red("✗ ") + reason);
      return EXIT.fail;
    }
    throw e;
  }
}

export async function cmdSteer(t: Target, a: Args): Promise<number> {
  const msg = flagStr(a, "text") ?? freeText(a);
  if (!msg) { note("用法：dove steer [--thread <id>] \"插话内容\""); return EXIT.usage; }
  let id: string;
  try {
    id = (await resolveThread(t, a, undefined, { allowCreate: false })).id;
  } catch (e) {
    if (e instanceof NoThreadError) { note(red("✗ ") + e.message); return EXIT.fail; }
    throw e;
  }
  await api(t, "/api/steer", { body: { threadId: id, message: msg }, timeoutMs: 8_000 });
  out(flagBool(a, "json") ? JSON.stringify({ ok: true, threadId: id }) : `已插话到 ${id}（下一个 step 生效）`);
  return EXIT.ok;
}
