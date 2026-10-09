/**
 * 帧生成（媒体层）
 *
 * 两条路：
 * 1) 文字帧：交给 encoder.swift 的 --render-frame 用 CoreText 直接绘制成 PNG。
 *    没有走「SVG + sips」——sips 转 SVG 会丢字体（中文直接变豆腐块/空白），
 *    而 CoreText + PingFang SC 是系统原生路径，中英文都稳。
 * 2) 图片帧：直接引用已有图片文件；尺寸/比例不符由编码器 letterbox 适配。
 *
 * 本目录（media/）不依赖 core 的其他层，只用 node: 内置模块。
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFramePng, removeDir, type FrameSpecJson } from "./encoder.ts";

/** 支持的图片扩展名（CGImageSource 能解的常见格式） */
export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff", ".gif", ".bmp", ".webp"]);

export interface TextFrameOpts {
  title: string;
  /** 要点列表 */
  body?: string[];
  subtitle?: string;
  footer?: string;
  /** 从 0 开始的页码下标 */
  index: number;
  total: number;
  width: number;
  height: number;
  /** 6 位十六进制主色 */
  accent?: string;
  bg?: string;
  /** 帧落盘目录；省略则用临时目录 */
  outDir?: string;
}

/** 建一个唯一的临时帧目录 */
export function makeFrameDir(prefix = "dove-video-frames"): string {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 临时目录清理（best-effort） */
export function cleanupFrames(dir: string | undefined): void {
  if (dir) removeDir(dir);
}

/**
 * 渲染一张文字帧为 PNG，返回 PNG 绝对路径；失败抛错（由工具层 guarded 收口）。
 */
export async function renderTextFrame(opts: TextFrameOpts): Promise<string> {
  if (!opts.title && !(opts.body && opts.body.length > 0)) throw new Error("文字帧至少要有一个标题");
  const dir = opts.outDir ?? makeFrameDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `frame-${String(opts.index).padStart(3, "0")}.png`);
  const spec: FrameSpecJson = {
    width: opts.width,
    height: opts.height,
    title: opts.title,
    subtitle: opts.subtitle,
    body: opts.body,
    footer: opts.footer,
    accent: opts.accent,
    bg: opts.bg,
    index: opts.index,
    total: opts.total,
  };
  return renderFramePng(spec, file);
}

/** 校验一批图片路径（绝对路径）：不存在/不是文件/扩展名不认识都给出明确错误 */
export function assertImages(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`图片不存在：${p}`);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(p); } catch (e) { throw new Error(`图片读不了：${p}（${String(e)}）`); }
    if (!st.isFile()) throw new Error(`不是文件：${p}`);
    const dot = p.lastIndexOf(".");
    const ext = dot >= 0 ? p.slice(dot).toLowerCase() : "";
    if (!IMAGE_EXTS.has(ext)) throw new Error(`不支持的图片格式：${p}（支持 ${[...IMAGE_EXTS].join("/")}）`);
    out.push(p);
  }
  return out;
}
