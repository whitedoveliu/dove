/**
 * 预览 dev server 管理
 * 一个项目一个 dev server；端口从 3000 起分配。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectPackageManager } from "./build.ts";
import { startStaticServer } from "./static-server.ts";

interface Running { proc: ChildProcess; port: number; url: string; startedAt: number; logFile: string }

/** package.json 里有没有 dev 脚本 */
function hasDevScript(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.dev === "string" && pkg.scripts.dev.trim().length > 0;
  } catch { return false; }
}

export class PreviewManager {
  #running = new Map<string, Running>();
  /** 静态回退服务（与 dev server 分开管理，因为停止方式不同） */
  #static = new Map<string, { url: string; port: number; stop(): void }>();
  #basePort: number;
  #nextPort: number;

  constructor(basePort = 3000) { this.#basePort = basePort; this.#nextPort = basePort; }

  get(projectId: string): Running | undefined { return this.#running.get(projectId); }

  list(): { projectId: string; port: number; url: string; startedAt: number }[] {
    return [
      ...[...this.#running.entries()].map(([k, v]) => ({ projectId: k, port: v.port, url: v.url, startedAt: v.startedAt })),
      ...[...this.#static.entries()].map(([k, v]) => ({ projectId: k, port: v.port, url: v.url, startedAt: 0 })),
    ];
  }

  /** 端口是否真的空闲（只查注册表不够 —— 可能有别的进程占着） */
  async #portFree(port: number): Promise<boolean> {
    const { createServer } = await import("node:net");
    return new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => { srv.close(() => resolve(true)); });
      srv.listen(port, "127.0.0.1");
    });
  }

  /** 从 nextPort 起找一个真正空闲的端口，最多试 50 个 */
  async #findFreePort(): Promise<number> {
    for (let i = 0; i < 50; i++) {
      const p = this.#nextPort++;
      if (this.#running.has(String(p)) || this.#static.has(String(p))) continue;
      if (await this.#portFree(p)) return p;
    }
    throw new Error("找不到空闲端口（已试 50 个）");
  }

  async start(projectId: string, dir: string): Promise<{ url: string; port: number }> {
    const existing = this.#running.get(projectId);
    if (existing) return { url: existing.url, port: existing.port };
    const existingStatic = this.#static.get(projectId);
    if (existingStatic) return { url: existingStatic.url, port: existingStatic.port };

    // 端口要真的空闲才用 —— 否则会 EADDRINUSE（实测踩过）
    const port = await this.#findFreePort();

    // 没有 dev 脚本的项目（纯静态站点、产物目录）→ 直接静态服务，不报"预览失败"
    if (!hasDevScript(dir)) {
      const h = await startStaticServer(dir, port);
      this.#static.set(projectId, h);
      return { url: h.url, port: h.port };
    }

    const pm = detectPackageManager(dir);
    const logDir = join(dir, ".logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, "dev-server.log");
    const stream = createWriteStream(logFile, { flags: "a" });

    const args = pm.cmd === "npm"
      ? ["run", "dev", "--", "--port", String(port), "--host", "127.0.0.1"]
      : ["run", "dev", "--", "--port", String(port), "--host", "127.0.0.1"];

    const proc = spawn(pm.cmd, args, { cwd: dir, env: { ...process.env, PORT: String(port), NO_COLOR: "1" } });
    proc.stdout.pipe(stream);
    proc.stderr.pipe(stream);
    proc.on("exit", () => { this.#running.delete(projectId); });

    const url = `http://127.0.0.1:${port}`;
    this.#running.set(projectId, { proc, port, url, startedAt: Date.now(), logFile });
    await waitForHttp(url, 45_000);
    return { url, port };
  }

  stop(projectId: string): void {
    const s = this.#static.get(projectId);
    if (s) { try { s.stop(); } catch { /* ignore */ } this.#static.delete(projectId); }
    const r = this.#running.get(projectId);
    if (!r) return;
    try { r.proc.kill("SIGTERM"); } catch { /* ignore */ }
    this.#running.delete(projectId);
  }

  stopAll(): void {
    // 注意：静态回退服务也在这里面 —— 漏掉它进程会因为 server 句柄不释放而挂住
    for (const k of new Set([...this.#running.keys(), ...this.#static.keys()])) this.stop(k);
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}
