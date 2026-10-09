/**
 * 视频编码器（媒体层）：Swift + AVFoundation 的运行时编译与调用。
 *
 * 思路与 activity/ocr.ts 完全一致：
 * - 源码 = 同目录的 encoder.swift；按内容 sha256 命名，编译产物缓存到 ~/.dove/cache/video-encoder-<hash>
 * - 已有可执行文件直接复用；没有才编译（首次约 5–15 秒；同内容只编译一次，进程内并发共享同一次编译）
 * - 无 swiftc / 编译失败 / 编码失败 → 结构化结果（ok:false + error），绝不抛
 *
 * 本目录（media/）不依赖 core 的任何其他层，只用 node: 内置模块。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SWIFTC = "/usr/bin/swiftc";
/** 首次编译实测约 5–15 秒，这里给足余量 */
export const COMPILE_TIMEOUT_MS = 240_000;
/** 编码超时保护：默认 300 秒（长视频/高分辨率时由调用方抬高） */
export const ENCODE_TIMEOUT_MS = 300_000;
export const SWIFTC_MISSING_HINT =
  "未找到 /usr/bin/swiftc：安装 Xcode Command Line Tools（xcode-select --install）后重试。";

/** 一帧的版式描述（对应 encoder.swift 的 FrameSpec） */
export interface FrameSpecJson {
  width?: number;
  height?: number;
  title?: string;
  subtitle?: string;
  body?: string[];
  footer?: string;
  /** 6 位十六进制，可带 # */
  accent?: string;
  bg?: string;
  index?: number;
  total?: number;
}

export interface EncodeFrame {
  /** 帧图片绝对路径（与 spec 二选一） */
  image?: string;
  /** 内联文字版式：不落 PNG，直接画进 pixel buffer */
  spec?: FrameSpecJson;
  /** 该帧停留秒数，默认 2 */
  seconds?: number;
}

export interface EncodeSpec {
  out: string;
  width: number;
  height: number;
  fps?: number;
  bg?: string;
  frames: EncodeFrame[];
}

export interface EncodeResult {
  ok: boolean;
  path?: string;
  frames?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  bytes?: number;
  error?: string;
}

export interface EncoderInfo {
  ok: boolean;
  bin?: string;
  error?: string;
  /** 本次是否真的执行了编译 */
  compiled?: boolean;
  compileMs?: number;
}

interface RunResult { code: number | null; stdout: string; stderr: string; error?: string }

/** 跑子进程：不抛异常，错误都落在返回值里 */
function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: RunResult): void => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
        (err: Error | null, stdout: string, stderr: string) => {
          const errCode = (err as { code?: unknown } | null)?.code;
          finish({
            code: err ? (typeof errCode === "number" ? errCode : null) : 0,
            stdout: String(stdout ?? ""), stderr: String(stderr ?? ""),
            error: err ? String((err as Error).message) : undefined,
          });
        });
      child.on("error", (e: Error) => finish({ code: null, stdout: "", stderr: "", error: String(e.message) }));
    } catch (e) {
      finish({ code: null, stdout: "", stderr: "", error: String((e as Error).message) });
    }
  });
}

/** 缓存目录：DOVE_CACHE_DIR 可覆盖，默认 ~/.dove/cache（与 OCR helper 共用） */
export function cacheDir(): string {
  const custom = process.env.DOVE_CACHE_DIR?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), ".dove", "cache");
}

export function swiftSourcePath(): string {
  return fileURLToPath(new URL("./encoder.swift", import.meta.url));
}

function sourceHash(): string {
  return createHash("sha256").update(readFileSync(swiftSourcePath(), "utf8")).digest("hex").slice(0, 12);
}

/** 编译产物路径：~/.dove/cache/video-encoder-<hash> */
export function encoderPath(): string {
  return join(cacheDir(), `video-encoder-${sourceHash()}`);
}

function isUsable(p: string): boolean {
  try { return existsSync(p) && statSync(p).size > 0; } catch { return false; }
}

let compiling: Promise<EncoderInfo> | null = null;

async function compile(): Promise<EncoderInfo> {
  const src = swiftSourcePath();
  if (!existsSync(src)) return { ok: false, error: `缺少 Swift 源码：${src}` };
  const swiftc = process.env.DOVE_SWIFTC?.trim() || SWIFTC;
  if (!existsSync(swiftc)) return { ok: false, error: SWIFTC_MISSING_HINT };
  const out = encoderPath();
  try { mkdirSync(cacheDir(), { recursive: true }); } catch { /* ignore */ }
  const tmp = `${out}.tmp-${process.pid}`;
  const started = Date.now();
  const r = await run(swiftc, ["-O", "-o", tmp, src], COMPILE_TIMEOUT_MS);
  const compileMs = Date.now() - started;
  if (r.code !== 0 || !isUsable(tmp)) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    const detail = (r.stderr || r.error || "").trim().split("\n").slice(0, 6).join(" / ").slice(0, 400);
    return { ok: false, error: `Swift 编译失败（code=${r.code}，${compileMs}ms）：${detail}` };
  }
  try { renameSync(tmp, out); } catch (e) { return { ok: false, error: `编译产物落盘失败：${String(e)}` }; }
  return { ok: true, bin: out, compiled: true, compileMs };
}

/** 确保编码器可用（必要时编译）；同一进程内并发调用共享同一次编译 */
export async function ensureEncoder(force = false): Promise<EncoderInfo> {
  const out = encoderPath();
  if (!force && isUsable(out)) return { ok: true, bin: out, compiled: false };
  if (!compiling) compiling = compile().finally(() => { compiling = null; });
  return compiling;
}

/** 渲染单张文字帧为 PNG（供 frames.ts 使用）；返回绝对路径，失败抛错 */
export async function renderFramePng(spec: FrameSpecJson, out: string, timeoutMs = 60_000): Promise<string> {
  const enc = await ensureEncoder();
  if (!enc.ok || !enc.bin) throw new Error(enc.error ?? "视频编码器不可用");
  const specFile = join(tmpdir(), `dove-frame-spec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(specFile, JSON.stringify(spec), "utf8");
  try {
    const r = await run(enc.bin, ["--render-frame", specFile, out], timeoutMs);
    if (r.code !== 0 || !existsSync(out)) {
      throw new Error(`渲染帧失败（code=${r.code}）：${(r.stderr || r.error || "").trim().slice(0, 300)}`);
    }
  } finally {
    try { unlinkSync(specFile); } catch { /* ignore */ }
  }
  return out;
}

/** 编码成 H.264 MP4；manifest 落临时文件后交给 Swift，读回结果 JSON */
export async function encodeVideo(spec: EncodeSpec, opts: { timeoutMs?: number } = {}): Promise<EncodeResult> {
  const enc = await ensureEncoder();
  if (!enc.ok || !enc.bin) return { ok: false, error: enc.error ?? "视频编码器不可用" };
  if (!spec.frames || spec.frames.length === 0) return { ok: false, error: "frames 不能为空" };

  const manifest = join(tmpdir(), `dove-video-manifest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    writeFileSync(manifest, JSON.stringify(spec), "utf8");
  } catch (e) {
    return { ok: false, error: `清单写入失败：${String(e)}` };
  }
  try {
    const r = await run(enc.bin, [manifest], opts.timeoutMs ?? ENCODE_TIMEOUT_MS);
    if (r.code !== 0) {
      return { ok: false, error: `编码失败（code=${r.code}）：${(r.stderr || r.error || "").trim().slice(0, 400)}` };
    }
    const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
    let parsed: EncodeResult;
    try { parsed = JSON.parse(line) as EncodeResult; }
    catch { return { ok: false, error: `编码器输出无法解析：${line.slice(0, 200)}` }; }
    if (!parsed.ok) return { ok: false, error: parsed.error ?? "编码器返回失败" };
    if (!parsed.path || !isUsable(parsed.path)) return { ok: false, error: "编码器报告成功但产物不存在" };
    return parsed;
  } finally {
    try { unlinkSync(manifest); } catch { /* ignore */ }
  }
}

/** 删除一整个临时目录（best-effort，失败不影响结果） */
export function removeDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
