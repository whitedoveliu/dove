/**
 * 截屏（T7.1）
 * 主路径：spawn /usr/sbin/screencapture -x（-x 静音），再交给 /usr/bin/sips 压到目标尺寸与质量。
 * - 常规图：最大宽 2560 / q55（长边自适应，不放大）
 * - 判重专用图：最大宽 640 / q40（更便宜，只用来算哈希/直方图）
 * 任何失败都返回结构化结果（ok:false + error），绝不抛；无权限时给明确引导。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const SCREENCAPTURE = "/usr/sbin/screencapture";
export const SIPS = "/usr/bin/sips";
export const IOREG = "/usr/sbin/ioreg";
export const CAPTURE_MAX_WIDTH = 2560;
export const CAPTURE_QUALITY = 55;
export const PROBE_MAX_WIDTH = 640;
export const PROBE_QUALITY = 40;
export const CMD_TIMEOUT_MS = 20_000;
/** 小于该字节数的截图基本是空图（无权限时 macOS 只给一张桌面图）——启发式，宁可误报也不假装成功 */
export const MIN_PLAUSIBLE_BYTES = 1_024;

export const SCREEN_PERMISSION_HINT =
  "未获得「屏幕录制」权限：打开 系统设置 → 隐私与安全性 → 屏幕录制，勾选 Dove（或运行它的终端 / IDE）后重启该程序。";

export interface CaptureResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  width?: number;
  height?: number;
  error?: string;
}

export interface CaptureOptions {
  /** 输出文件绝对路径 */
  out: string;
  /** 长边上限，默认 2560 */
  maxWidth?: number;
  /** JPEG 质量 0-100，默认 55 */
  quality?: number;
}

export interface RunResult { code: number | null; stdout: string; stderr: string; error?: string }

/** 跑一个子进程；不抛异常，错误都落在返回值里 */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: RunResult): void => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = execFile(
        cmd, args,
        { timeout: opts.timeoutMs ?? CMD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        (err: Error | null, stdout: string, stderr: string) => {
          const errCode = (err as { code?: unknown } | null)?.code;
          finish({
            code: err ? (typeof errCode === "number" ? errCode : null) : 0,
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

export function fileBytes(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/** 用 sips 读图片尺寸；失败返回 null */
export async function imageSize(path: string): Promise<{ width: number; height: number } | null> {
  const r = await run(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  if (r.code !== 0) return null;
  const w = /pixelWidth:\s*(\d+)/.exec(r.stdout);
  const h = /pixelHeight:\s*(\d+)/.exec(r.stdout);
  if (!w || !h) return null;
  return { width: Number(w[1]), height: Number(h[1]) };
}

/** sips 转码/缩放：format 例 "jpeg" / "bmp"；maxWidth 省略则不缩放 */
export async function convert(
  src: string, out: string,
  opts: { format: string; maxWidth?: number; quality?: number } = { format: "jpeg" },
): Promise<{ ok: boolean; error?: string }> {
  const args = ["-s", "format", opts.format];
  if (opts.quality !== undefined) args.push("-s", "formatOptions", String(opts.quality));
  if (opts.maxWidth !== undefined) args.push("-Z", String(opts.maxWidth));
  args.push(src, "--out", out);
  const r = await run(SIPS, args);
  if (r.code !== 0 || !existsSync(out)) {
    return { ok: false, error: `sips 失败（code=${r.code}）：${(r.stderr || r.error || "").trim().slice(0, 200)}` };
  }
  return { ok: true };
}

/** 把 screencapture 的原始输出压成目标规格；不放大（源图小于上限时直接转码） */
async function compress(raw: string, opts: CaptureOptions): Promise<{ ok: boolean; warning?: string }> {
  const out = opts.out;
  const maxWidth = opts.maxWidth ?? CAPTURE_MAX_WIDTH;
  const quality = opts.quality ?? CAPTURE_QUALITY;
  const dims = await imageSize(raw);
  const needScale = !!dims && Math.max(dims.width, dims.height) > maxWidth;
  const r = await convert(raw, out, { format: "jpeg", quality, ...(needScale ? { maxWidth } : {}) });
  if (r.ok) { try { unlinkSync(raw); } catch { /* ignore */ } return { ok: true }; }
  // 压缩失败也要留下截图：直接把原图搬过去
  try {
    renameSync(raw, out);
    return { ok: true, warning: `压缩失败，已保留原图：${r.error ?? ""}` };
  } catch (e) {
    return { ok: false, warning: `${r.error ?? ""}；原图保留失败：${String(e)}` };
  }
}

/** 无权限 / 命令缺失的判别与文案 */
function classify(run: RunResult, rawExists: boolean): string {
  const text = `${run.stderr} ${run.error ?? ""}`.toLowerCase();
  if (run.error && /enoent/.test(text)) return `找不到 ${SCREENCAPTURE}（非 macOS 或系统被裁剪）`;
  if (/not authorized|not permitted|permission|denied|could not create image|no such display/.test(text)) {
    return `截图被系统拒绝。${SCREEN_PERMISSION_HINT}`;
  }
  if (!rawExists) return `截图命令未产出文件（code=${run.code}）：${(run.stderr || run.error || "").trim().slice(0, 200)}`;
  return `截图失败（code=${run.code}）：${(run.stderr || run.error || "").trim().slice(0, 200)}`;
}

/**
 * 采一帧。
 * 注意：ok=true 且带 error 字段 = 截图成功但压缩降级（原图已保留）。
 */
export async function capture(opts: CaptureOptions): Promise<CaptureResult> {
  const out = opts.out;
  const raw = out.replace(/\.jpg$/i, "") + `.raw-${process.pid}-${Date.now()}.jpg`;
  try { mkdirSync(dirname(out), { recursive: true }); } catch { /* ignore */ }
  const r = await run(SCREENCAPTURE, ["-x", "-t", "jpg", raw]);
  const exists = existsSync(raw);
  if (r.code !== 0 || !exists) {
    if (exists) { try { unlinkSync(raw); } catch { /* ignore */ } }
    return { ok: false, error: classify(r, exists) };
  }
  const rawBytes = fileBytes(raw);
  if (rawBytes < MIN_PLAUSIBLE_BYTES) {
    try { unlinkSync(raw); } catch { /* ignore */ }
    return { ok: false, error: `截图内容为空（${rawBytes} 字节）。${SCREEN_PERMISSION_HINT}` };
  }
  const c = await compress(raw, opts);
  if (!c.ok) return { ok: false, error: c.warning ?? "压缩失败" };
  const bytes = fileBytes(out);
  const dims = (await imageSize(out)) ?? undefined;
  return {
    ok: true, path: out, bytes,
    ...(dims ? { width: dims.width, height: dims.height } : {}),
    ...(c.warning ? { error: c.warning } : {}),
  };
}

/** 真实截一张来探测权限（不读 TCC.db，读不到） */
export async function isScreenRecordingAllowed(): Promise<boolean> {
  const probe = join(tmpdir(), `dove-perm-probe-${process.pid}-${Date.now()}.jpg`);
  const r = await capture({ out: probe, maxWidth: PROBE_MAX_WIDTH, quality: PROBE_QUALITY });
  try { if (existsSync(probe)) unlinkSync(probe); } catch { /* ignore */ }
  return r.ok && (r.bytes ?? 0) >= MIN_PLAUSIBLE_BYTES;
}

/** 锁屏检测（T7.4「锁屏停采」）：ioreg 的 IOConsoleLocked / CGSSessionScreenIsLocked，约 20ms，不要高频调用 */
export async function screenIsLocked(): Promise<boolean> {
  const r = await run(IOREG, ["-n", "Root", "-d1", "-a"]);
  if (r.code !== 0) return false;
  return /<key>(?:IOConsoleLocked|CGSSessionScreenIsLocked)<\/key>\s*<true\s*\/>/.test(r.stdout);
}

/** 跳系统设置 → 隐私与安全性 → 屏幕录制 */
export function openPermissionSettings(): void {
  try {
    const child = execFile(
      "/usr/bin/open",
      ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"],
      { detached: true, stdio: "ignore" },
      () => { /* ignore */ },
    );
    child.unref();
  } catch { /* 打开面板失败不影响主流程 */ }
}
