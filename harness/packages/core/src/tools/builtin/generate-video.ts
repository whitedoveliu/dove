/**
 * GenerateVideo —— 生成真正的 .mp4（零 npm 依赖）
 *
 * 做法：Swift + AVFoundation 的 AVAssetWriter 直接编 H.264（见 media/encoder.swift），
 *       本机不需要 ffmpeg。文字帧用 CoreText 直绘成 PNG（中文走 PingFang SC，不会丢字），
 *       图片帧按比例 letterbox 进画布。
 *
 * 两种模式（二选一）：
 *   a) slides —— 从「标题 + 要点」大纲生成幻灯片式视频
 *   b) images —— 用一组已有图片生成轮播视频
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "../types.ts";
import { guarded, str, optStr, optNum, clampNum, humanBytes, resolvePath } from "./util.ts";
import { encodeVideo, type EncodeFrame } from "../../media/encoder.ts";
import { assertImages, cleanupFrames, makeFrameDir, renderTextFrame } from "../../media/frames.ts";

export const MAX_CLIPS = 120;
export const MAX_TOTAL_MS = 600_000;

/** 合法 6 位十六进制主色，非法则回退 */
function accentOf(v: unknown, fallback = "2F5D50"): string {
  const s = String(v ?? "").replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : fallback;
}

/** 尺寸取偶（H.264 要求宽高为偶数），并夹在合理区间 */
function evenSize(v: number | undefined, fallback: number): number {
  const n = Math.round(clampNum(v ?? fallback, 160, 3840));
  return n % 2 === 0 ? n : n + 1;
}

export const generateVideoTool = defineTool({
  name: "GenerateVideo",
  discoverable: "生成 .mp4 视频（幻灯片式或图片轮播）",
  description: [
    "生成一个真正的 .mp4 视频（H.264，系统原生编码，不需要 ffmpeg），保存到项目的 outputs/ 目录。",
    "两种模式：给 slides（标题 + 要点）生成幻灯片式视频；或给 images（已有图片路径）生成轮播视频。",
    "每页默认停留 2.5 秒，可用 seconds_per_slide 调整；图片模式还可用 total_seconds 指定总时长。",
    "生成后把文件路径告诉用户。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "视频标题（用作文件名）" },
      slides: {
        type: "array",
        description: "幻灯片列表（模式 a；与 images 二选一）",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "本页标题" },
            bullets: { type: "array", items: { type: "string" }, description: "本页要点" },
          },
          required: ["title"],
        },
      },
      images: {
        type: "array",
        items: { type: "string" },
        description: "图片路径列表（模式 b；相对路径按工作目录展开，与 slides 二选一）",
      },
      seconds_per_slide: { type: "number", description: "每页/每张停留秒数，默认 2.5，范围 0.5–20" },
      total_seconds: { type: "number", description: "可选：整片总时长（秒），给出后覆盖 seconds_per_slide" },
      width: { type: "number", description: "视频宽度，默认 1280（取偶，160–3840）" },
      height: { type: "number", description: "视频高度，默认 720（取偶，160–3840）" },
      fps: { type: "number", description: "帧率，默认 24（1–60）" },
      accent_color: { type: "string", description: "主色，6 位十六进制（可带 #），默认 2F5D50" },
      filename: { type: "string", description: "文件名（可选，不用带扩展名）" },
    },
    required: ["title"],
  },
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  // 编码超时 300s（media/encoder.ts），工具层留出余量
  timeoutMs: 360_000,
  execute: (input, ctx) => guarded(async () => {
    const title = str(input, "title");
    const slidesRaw = Array.isArray(input.slides) ? input.slides : [];
    const imagesRaw = Array.isArray(input.images) ? input.images : [];
    if (slidesRaw.length === 0 && imagesRaw.length === 0) return { error: "slides 与 images 至少要给一个" };
    if (slidesRaw.length > 0 && imagesRaw.length > 0) return { error: "slides 与 images 只能二选一" };

    const width = evenSize(optNum(input, "width"), 1280);
    const height = evenSize(optNum(input, "height"), 720);
    const fps = Math.round(clampNum(optNum(input, "fps") ?? 24, 1, 60));
    const accent = accentOf(input.accent_color);
    const clips = slidesRaw.length > 0 ? slidesRaw.length : imagesRaw.length;
    if (clips > MAX_CLIPS) return { error: `最多 ${MAX_CLIPS} 页/张，当前 ${clips}` };

    // 每页秒数：total_seconds 优先
    const perSlide = clampNum(optNum(input, "seconds_per_slide") ?? 2.5, 0.5, 20);
    const totalSeconds = optNum(input, "total_seconds");
    const seconds = totalSeconds && totalSeconds > 0
      ? clampNum(totalSeconds / clips, 0.1, 60)
      : perSlide;
    if (clips * seconds * 1000 > MAX_TOTAL_MS) return { error: `视频过长（${Math.round(clips * seconds)}s），上限 ${MAX_TOTAL_MS / 1000}s` };

    const frames: EncodeFrame[] = [];
    const frameDir = makeFrameDir();
    try {
      if (slidesRaw.length > 0) {
        const total = slidesRaw.length;
        for (let i = 0; i < total; i++) {
          const o = (slidesRaw[i] ?? {}) as { title?: unknown; bullets?: unknown };
          const pageTitle = String(o.title ?? "").trim() || `第 ${i + 1} 页`;
          const bullets = (Array.isArray(o.bullets) ? o.bullets : []).map((b) => String(b)).slice(0, 8);
          const png = await renderTextFrame({
            title: pageTitle, body: bullets, index: i, total,
            width, height, accent, outDir: frameDir,
          });
          frames.push({ image: png, seconds });
        }
      } else {
        const imgs = assertImages(imagesRaw.map((p) => resolvePath(p, ctx.workdir)));
        for (const p of imgs) frames.push({ image: p, seconds });
      }

      const dir = ctx.outputsDir || join(ctx.workdir, "outputs");
      mkdirSync(dir, { recursive: true });
      const safe = (optStr(input, "filename") ?? title).replace(/[^\p{L}\p{N}_\- ]/gu, "").trim().slice(0, 60) || "video";
      const out = join(dir, safe + ".mp4");

      const res = await encodeVideo({ out, width, height, fps, frames });
      if (!res.ok) return { ok: false, error: res.error ?? "编码失败" };
      let bytes = res.bytes ?? 0;
      try { bytes = statSync(out).size; } catch { /* 用编码器报的字节数 */ }
      return {
        ok: true,
        path: out,
        bytes,
        durationSec: Number(((res.durationMs ?? 0) / 1000).toFixed(2)),
        width: res.width ?? width,
        height: res.height ?? height,
        fps: res.fps ?? fps,
        frames: res.frames ?? 0,
        encoder: "swift-avfoundation-h264",
        message: `已生成 ${clips} 页 / ${((res.durationMs ?? 0) / 1000).toFixed(1)}s 的 MP4（${humanBytes(bytes)}）：${out}`,
      };
    } finally {
      cleanupFrames(frameDir);
    }
  }),
});
