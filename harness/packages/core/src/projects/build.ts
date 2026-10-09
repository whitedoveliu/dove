/**
 * 构建（产物工具的后端实现）
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BuildResult { ok: boolean; output: string; durationMs: number; command: string }

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, CI: "1", NO_COLOR: "1" } });
    let out = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); out += "\n[构建超时，已终止]"; }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: out + "\n" + e.message }); });
  });
}

/** 选择包管理器：有 pnpm-lock 用 pnpm，有 yarn.lock 用 yarn，否则 npm */
export function detectPackageManager(dir: string): { cmd: string; installArgs: string[]; runArgs: (s: string) => string[] } {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return { cmd: "pnpm", installArgs: ["install"], runArgs: (s) => ["run", s] };
  if (existsSync(join(dir, "yarn.lock"))) return { cmd: "yarn", installArgs: [], runArgs: (s) => [s] };
  return { cmd: "npm", installArgs: ["install"], runArgs: (s) => ["run", s] };
}

export async function buildProject(dir: string, timeoutMs = 300_000): Promise<BuildResult> {
  const started = Date.now();
  const pm = detectPackageManager(dir);

  if (!existsSync(join(dir, "node_modules"))) {
    const inst = await run(pm.cmd, pm.installArgs, dir, timeoutMs);
    if (inst.code !== 0) {
      return { ok: false, output: `依赖安装失败：\n${inst.out.slice(-4_000)}`, durationMs: Date.now() - started, command: `${pm.cmd} ${pm.installArgs.join(" ")}` };
    }
  }

  const r = await run(pm.cmd, pm.runArgs("build"), dir, timeoutMs);
  return {
    ok: r.code === 0,
    output: r.out.slice(-8_000),
    durationMs: Date.now() - started,
    command: `${pm.cmd} ${pm.runArgs("build").join(" ")}`,
  };
}

/** 类型检查（可选，比 build 快） */
export async function typecheck(dir: string, timeoutMs = 120_000): Promise<BuildResult> {
  const started = Date.now();
  const r = await run("npx", ["tsc", "--noEmit"], dir, timeoutMs);
  return { ok: r.code === 0, output: r.out.slice(-8_000), durationMs: Date.now() - started, command: "npx tsc --noEmit" };
}
