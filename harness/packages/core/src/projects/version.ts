/**
 * 版本管理（git 快照）
 * 简化版：项目目录内 git init，每次快照 = 一次 commit，版本号 = 递增计数。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function git(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd: dir });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
    p.on("error", () => resolve({ code: -1, out: "git 不可用" }));
  });
}

export interface VersionInfo { version: string; message: string; at: number; hash: string }

const IGNORE = ["node_modules/", "dist/", ".logs/", ".spill/", ".git/", "*.log"];

export class VersionManager {
  async ensureRepo(dir: string): Promise<void> {
    if (!existsSync(join(dir, ".git"))) {
      await git(dir, ["init", "-q"]);
      await git(dir, ["config", "user.email", "dove@local"]);
      await git(dir, ["config", "user.name", "Dove"]);
    }
    const gi = join(dir, ".gitignore");
    if (!existsSync(gi)) {
      await git(dir, ["config", "core.excludesfile", ""]);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(gi, IGNORE.join("\n") + "\n");
    }
  }

  async snapshot(dir: string, message: string): Promise<{ ok: boolean; version?: string; hash?: string; message: string }> {
    await this.ensureRepo(dir);
    await git(dir, ["add", "-A"]);
    const r = await git(dir, ["commit", "-q", "-m", message, "--allow-empty"]);
    if (r.code !== 0 && !r.out.includes("nothing to commit")) {
      return { ok: false, message: r.out.slice(0, 500) };
    }
    const count = await git(dir, ["rev-list", "--count", "HEAD"]);
    const hash = await git(dir, ["rev-parse", "--short", "HEAD"]);
    return { ok: true, version: count.out.trim(), hash: hash.out.trim(), message };
  }

  async list(dir: string): Promise<VersionInfo[]> {
    if (!existsSync(join(dir, ".git"))) return [];
    const r = await git(dir, ["log", "--pretty=format:%h%x1f%s%x1f%at", "-n", "100"]);
    if (r.code !== 0) return [];
    const lines = r.out.split("\n").filter(Boolean);
    const total = lines.length;
    return lines.map((l, i) => {
      const [hash, msg, at] = l.split("\x1f");
      return { version: String(total - i), hash: hash ?? "", message: msg ?? "", at: Number(at ?? 0) * 1000 };
    });
  }

  /** 基于历史版本重新开始：把某个 commit 的内容检出为新的一次提交 */
  async restore(dir: string, version: string): Promise<{ ok: boolean; message: string }> {
    const list = await this.list(dir);
    const target = list.find((v) => v.version === version);
    if (!target) return { ok: false, message: `版本 ${version} 不存在` };
    const r = await git(dir, ["checkout", target.hash, "--", "."]);
    if (r.code !== 0) return { ok: false, message: r.out.slice(0, 400) };
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", `恢复到版本 ${version}`, "--allow-empty"]);
    return { ok: true, message: `已恢复到版本 ${version}（${target.message}）` };
  }

  async diff(dir: string): Promise<string> {
    const r = await git(dir, ["diff", "--stat", "HEAD"]);
    return r.out.slice(0, 2_000);
  }
}
