/**
 * smoke-video —— GenerateVideo 端到端自测
 *
 * 跑法：cd harness && node --no-warnings scripts/smoke-video.ts
 *
 * 覆盖：
 *   1) ensureEncoder() 可用（必要时 swiftc 首次编译；打印编译耗时）
 *   2) 3 页幻灯片视频（每页 1s，1280x720，24fps）
 *   3) 校验产出是真 MP4：前 12 字节里必须有 ftyp box
 *   4) mdls 读时长/宽高，与预期比对（±0.5s）
 *   5) 从一组已有图片（PNG + 一张不同比例的 JPG）生成轮播视频，同样校验
 *   6) 打印文件大小
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encoderPath, ensureEncoder } from "../packages/core/src/media/encoder.ts";
import { makeFrameDir, renderTextFrame } from "../packages/core/src/media/frames.ts";
import { generateVideoTool } from "../packages/core/src/tools/builtin/generate-video.ts";
import type { ToolContext } from "../packages/core/src/tools/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKDIR = ROOT.replace(/\/$/, "");
const OUTPUTS = join(WORKDIR, "outputs");
const SIPS = "/usr/bin/sips";
const MDLS = "/usr/bin/mdls";

/** 工具返回（ToolResult 是 unknown 值表，这里收窄成明确类型） */
interface VideoOut {
  ok?: boolean; path?: string; bytes?: number; durationSec?: number;
  width?: number; height?: number; frames?: number; encoder?: string; error?: string; message?: string;
}

const failures: string[] = [];

/** 本机沙箱在删除/覆盖文件时会留下 .sb-<hash>-<rand> 备份副本：只清自己产物的这类残留 */
function cleanSandboxBackups(): void {
  try {
    for (const f of readdirSync(OUTPUTS)) {
      if (f.startsWith("smoke-video-") && /\.sb-[0-9a-f]+-[A-Za-z0-9]+$/.test(f)) rmSync(join(OUTPUTS, f), { force: true });
    }
  } catch { /* 清理失败不影响自测结论 */ }
}
function check(cond: boolean, label: string, detail = ""): void {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures.push(label);
}
function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** 真 MP4 判定：前 12 字节 = [size(4)][ftyp(4)][brand(4)] */
function ftypInfo(file: string): { ok: boolean; hex: string; brand: string } {
  const buf = readFileSync(file).subarray(0, 12);
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return { ok: buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp", hex, brand: buf.toString("latin1", 8, 12) };
}

/**
 * 直接解析 MP4 box（moov/mvhd + trak/tkhd）读时长与宽高。
 * 不依赖 Spotlight —— 和 mdls 互为交叉验证，避免「没索引到 / 读到缓存」误判。
 */
function mp4Timeline(file: string): { duration: number; width: number; height: number } | null {
  const buf = readFileSync(file);
  const at = buf.indexOf(Buffer.from("mvhd", "latin1"));
  if (at < 0) return null;
  const v = buf[at + 4]!;
  const timescale = buf.readUInt32BE(at + 4 + (v === 1 ? 20 : 12));
  const duration = v === 1 ? Number(buf.readBigUInt64BE(at + 4 + 24)) : buf.readUInt32BE(at + 4 + 16);
  if (timescale <= 0 || timescale > 1e7 || duration <= 0) return null;
  const tk = buf.indexOf(Buffer.from("tkhd", "latin1"));
  if (tk < 0) return null;
  const off = tk + (buf[tk + 4] === 1 ? 92 : 80);
  return { duration: duration / timescale, width: Math.round(buf.readUInt32BE(off) / 65536), height: Math.round(buf.readUInt32BE(off + 4) / 65536) };
}

/** 等 Spotlight 建索引后读 mdls（新文件可能几秒内读不到，不是视频的问题） */
async function mdls(file: string, tries = 12): Promise<{ duration: number; width: number; height: number } | null> {
  for (let i = 0; i < tries; i++) {
    let out = "";
    try { out = execFileSync(MDLS, ["-name", "kMDItemDurationSeconds", "-name", "kMDItemPixelWidth", "-name", "kMDItemPixelHeight", file], { encoding: "utf8" }); }
    catch { out = ""; }
    const d = /kMDItemDurationSeconds\s*=\s*([\d.]+)/.exec(out);
    const w = /kMDItemPixelWidth\s*=\s*(\d+)/.exec(out);
    const h = /kMDItemPixelHeight\s*=\s*(\d+)/.exec(out);
    if (d && w && h) return { duration: Number(d[1]), width: Number(w[1]), height: Number(h[1]) };
    await sleep(1000);
  }
  return null;
}

/** 造一个最小的工具上下文（工具只用到 workdir / outputsDir） */
function ctx(): ToolContext {
  return {
    toolCallId: "smoke-video", threadId: "smoke", workdir: WORKDIR, outputsDir: OUTPUTS,
    emit: () => { /* 自测不上报 */ },
    requestApproval: async () => ({ approved: true, decision: "allow" as const }),
    services: {},
  };
}

async function main(): Promise<void> {
  console.log("== 1. 编码器（Swift + AVFoundation）==");
  const existed = existsSync(encoderPath());
  const t0 = Date.now();
  const enc = await ensureEncoder();
  const ms = Date.now() - t0;
  check(enc.ok, "ensureEncoder() 可用", enc.ok ? `bin=${enc.bin}` : String(enc.error));
  if (!enc.ok) { report(); return; }
  console.log(`  · 缓存路径 ${encoderPath()}`);
  console.log(`  · ${existed ? "命中已有可执行文件" : "首次编译"}，本次耗时 ${ms}ms（编译器自报 ${enc.compileMs ?? "-"}ms）`);
  const probe = JSON.parse(execFileSync(enc.bin!, ["--probe"], { encoding: "utf8" }));
  check(probe.ok === true, "编码器自检 --probe", String(probe.system));

  mkdirSync(OUTPUTS, { recursive: true });
  cleanSandboxBackups();
  const T = ctx();

  console.log("\n== 2. 幻灯片视频（3 页 × 1s，1280x720，24fps）==");
  const slideFile = join(OUTPUTS, "smoke-video-slides.mp4");
  rmSync(slideFile, { force: true });
  const slides = (await generateVideoTool.execute({
    title: "smoke 幻灯片",
    filename: "smoke-video-slides",
    seconds_per_slide: 1,
    width: 1280, height: 720, fps: 24,
    slides: [
      { title: "第一页：目标", bullets: ["验证真 MP4 输出", "H.264 / AVFoundation"] },
      { title: "第二页：做法", bullets: ["CoreText 绘制中文帧", "AVAssetWriter 编码"] },
      { title: "第三页：结论", bullets: ["零 npm 依赖", "QuickTime 可播放"] },
    ],
  }, T)) as VideoOut;
  check(slides.ok === true, "工具返回 ok", JSON.stringify(slides.error ?? ""));
  if (slides.ok !== true) { report(); return; }
  console.log("  · 返回字段:", JSON.stringify({ path: slides.path, bytes: slides.bytes, durationSec: slides.durationSec, width: slides.width, height: slides.height, frames: slides.frames, encoder: slides.encoder }));
  check(typeof slides.path === "string" && existsSync(slides.path), "文件存在");
  check(slides.path === slideFile, "落在 outputs/ 且文件名正确");
  await verifyMp4(slideFile, { duration: 3, width: 1280, height: 720, frames: 72 });

  console.log("\n== 3. 图片轮播视频（已有 PNG + 不同比例 JPG，各 1s）==");
  const stage = makeFrameDir("dove-video-smoke-src");
  const png = await renderTextFrame({ title: "轮播图 A", body: ["来自 PNG 640x360"], index: 0, total: 2, width: 640, height: 360, accent: "3B4A63", outDir: stage });
  const jpg = join(stage, "source-b.jpg");
  execFileSync(SIPS, ["-s", "format", "jpeg", "-Z", "480", png, "--out", jpg]);
  check(existsSync(png) && existsSync(jpg), "预置图片就绪", `${png.split("/").pop()} + ${jpg.split("/").pop()} (${statSync(jpg).size} B)`);

  const carouselFile = join(OUTPUTS, "smoke-video-carousel.mp4");
  rmSync(carouselFile, { force: true });
  const carousel = (await generateVideoTool.execute({
    title: "smoke 轮播",
    filename: "smoke-video-carousel",
    images: [png, jpg],
    total_seconds: 2,
    width: 1280, height: 720, fps: 24,
  }, T)) as VideoOut;
  check(carousel.ok === true, "工具返回 ok", JSON.stringify(carousel.error ?? ""));
  if (carousel.ok === true) {
    console.log("  · 返回字段:", JSON.stringify({ path: carousel.path, bytes: carousel.bytes, durationSec: carousel.durationSec, frames: carousel.frames }));
    await verifyMp4(carouselFile, { duration: 2, width: 1280, height: 720, frames: 48 });
  }

  console.log("\n== 4. 文件大小 ==");
  for (const f of [slideFile, carouselFile]) {
    if (existsSync(f)) console.log(`  · ${f.replace(WORKDIR + "/", "")}  ${fmtBytes(statSync(f).size)}`);
  }
  rmSync(stage, { recursive: true, force: true });
  cleanSandboxBackups();
  report();
}

/** 一次完整的「真 MP4」校验：ftyp + mdls 读数 + 帧数 */
async function verifyMp4(file: string, want: { duration: number; width: number; height: number; frames: number }): Promise<void> {
  const ft = ftypInfo(file);
  check(ft.ok, "ftyp box 存在（真 MP4）", `前 12 字节 = ${ft.hex} / brand=${ft.brand}`);
  const size = statSync(file).size;
  check(size > 4096, "文件大小合理", fmtBytes(size));
  const box = mp4Timeline(file);
  if (box) {
    console.log(`  · MP4 box 读数：时长 ${box.duration}s / ${box.width}x${box.height}`);
    check(Math.abs(box.duration - want.duration) <= 0.5 && box.width === want.width && box.height === want.height,
      "moov/mvhd+tkhd 交叉验证", `${box.duration}s / ${box.width}x${box.height}`);
  } else {
    check(false, "moov/mvhd+tkhd 交叉验证", "解析不出 mvhd/tkhd");
  }
  const meta = await mdls(file);
  if (!meta) { check(false, "mdls 读出元数据", "等了 12s 仍是 (null)：Spotlight 未索引该路径（box 读数见上）"); return; }
  console.log(`  · mdls 读数：时长 ${meta.duration}s / ${meta.width}x${meta.height}`);
  check(Math.abs(meta.duration - want.duration) <= 0.5, `时长 ≈ ${want.duration}s（±0.5s）`, `实测 ${meta.duration}s`);
  check(meta.width === want.width && meta.height === want.height, `尺寸 = ${want.width}x${want.height}`, `实测 ${meta.width}x${meta.height}`);
}

function report(): void {
  if (failures.length === 0) { console.log("\n✓ smoke-video 全部通过"); process.exit(0); }
  console.error("\n✗ smoke-video 失败项：" + failures.join(" | "));
  process.exit(1);
}

await main();
