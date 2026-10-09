/**
 * Swift helper 的运行时编译与缓存（照抄 activity/ocr.ts 的成熟模式）
 * - 源码按内容 sha256 命名，缓存到 ~/.dove/cache/<prefix>-<hash>
 * - 同内容只编译一次；进程内并发调用共享同一次编译
 * - 无 swiftc / 编译失败 → { ok:false, error }，绝不抛
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SWIFTC = process.env.DOVE_SWIFTC?.trim() || "/usr/bin/swiftc";
export const COMPILE_TIMEOUT_MS = 180_000;
export const SWIFTC_MISSING_HINT =
  "未找到 swiftc：先安装 Xcode Command Line Tools（xcode-select --install）后重试；" +
  "期间可先用 /usr/bin/textutil 处理 docx/rtf 等富文本。";

export interface HelperResult { ok: boolean; bin?: string; error?: string }
export interface RunResult { code: number | null; stdout: string; stderr: string; error?: string }

/** 缓存目录：DOVE_CACHE_DIR 可覆盖，默认 ~/.dove/cache */
export function cacheDir(): string {
  const custom = process.env.DOVE_CACHE_DIR?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), ".dove", "cache");
}

/** 跑子进程；不抛，错误落在返回值（timeout 到期杀进程） */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: RunResult): void => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = execFile(
        cmd, args,
        { timeout: opts.timeoutMs ?? 60_000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, encoding: "utf8" },
        (err: Error | null, stdout: string, stderr: string) => {
          const code = (err as { code?: unknown } | null)?.code;
          finish({
            code: err ? (typeof code === "number" ? code : null) : 0,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            error: err ? String((err as Error).message) : undefined,
          });
        },
      );
      child.on("error", (e: Error) => finish({ code: null, stdout: "", stderr: "", error: String(e.message) }));
    } catch (e) {
      finish({ code: null, stdout: "", stderr: "", error: String((e as Error).message) });
    }
  });
}

function usable(path: string): boolean {
  try { return existsSync(path) && statSync(path).size > 0; } catch { return false; }
}

/** 编译产物路径：~/.dove/cache/<prefix>-<源码 hash 前 12 位> */
export function helperBinPath(sourcePath: string, prefix: string): string {
  const src = readFileSync(sourcePath, "utf8");
  const hash = createHash("sha256").update(src).digest("hex").slice(0, 12);
  return join(cacheDir(), prefix + "-" + hash);
}

const compiling = new Map<string, Promise<HelperResult>>();

/** 确保 helper 可用（必要时编译）；同一进程内并发调用共享同一次编译 */
export async function ensureSwiftHelper(opts: { source: string; prefix: string; frameworks?: string[] }): Promise<HelperResult> {
  const { source, prefix, frameworks = [] } = opts;
  if (!existsSync(source)) return { ok: false, error: "缺少 Swift 源码：" + source };
  let bin: string;
  try { bin = helperBinPath(source, prefix); } catch (e) { return { ok: false, error: "读取 Swift 源码失败：" + String(e) }; }
  if (usable(bin)) return { ok: true, bin };
  const running = compiling.get(prefix);
  if (running) return running;
  const task = compile(source, prefix, bin, frameworks).finally(() => { compiling.delete(prefix); });
  compiling.set(prefix, task);
  return task;
}

async function compile(source: string, prefix: string, bin: string, frameworks: string[]): Promise<HelperResult> {
  if (!existsSync(SWIFTC)) return { ok: false, error: SWIFTC_MISSING_HINT };
  try { mkdirSync(cacheDir(), { recursive: true }); } catch { /* 目录已存在或权限不足，交给编译报错 */ }
  const tmp = bin + ".tmp-" + process.pid;
  const args = ["-O", "-o", tmp, source, ...frameworks.flatMap((f) => ["-framework", f])];
  const r = await run(SWIFTC, args, { timeoutMs: COMPILE_TIMEOUT_MS });
  if (r.code !== 0 || !usable(tmp)) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    const detail = (r.stderr || r.error || "").trim().split("\n").slice(0, 6).join(" / ").slice(0, 400);
    return { ok: false, error: prefix + " Swift 编译失败（code=" + r.code + "）：" + detail };
  }
  try { renameSync(tmp, bin); } catch (e) { return { ok: false, error: "编译产物落盘失败：" + String(e) }; }
  return { ok: true, bin };
}
