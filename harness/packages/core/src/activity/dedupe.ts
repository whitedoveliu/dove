/**
 * 三级判重（T7.2，参数照抄 Alma）
 * ① FNV-1a（seed 2166136261，像素混合 (77R+150G+29B)>>8）完全相等 → 丢弃
 * ② 32 桶直方图（每像素同权重）开根号后欧氏距离 < 0.05 → 进 ③
 * ③ 逐像素差分（通道容差 30）比例 < 0.02 → 判重
 *
 * 位图来源：screencapture 只能产 JPEG/PNG，纯 JS 解不了；所以走
 *   sips -s format bmp -Z 256 → 我们只解析 BMP（未压缩，24/32bpp，结构 54/124 字节头）。
 * 选它的理由：sips 是 macOS 自带、BMP 无压缩无滤波（不用写 PNG 的 5 种 filter + zlib 重建），
 * 且解码失败时还有「原始 JPEG 字节哈希」这条兜底，判重不会因为解码问题而崩。
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { SIPS, run } from "./capture.ts";

export const FNV_OFFSET_BASIS = 2166136261;
export const FNV_PRIME = 16777619;
export const HISTOGRAM_BUCKETS = 32;
/** ② 直方图（开根号后）欧氏距离阈值 */
export const HISTOGRAM_THRESHOLD = 0.05;
/** ③ 逐像素容差与差异比例阈值 */
export const PIXEL_TOLERANCE = 30;
export const PIXEL_DIFF_THRESHOLD = 0.02;
/** 判重位图的长边上限 */
export const DEDUPE_THUMB_WIDTH = 256;

export interface Bitmap { width: number; height: number; data: Uint8Array }

export interface DedupeResult {
  duplicate: boolean;
  /** hash | histogram | pixel | raw */
  reason?: string;
  /** ③ 的差异比例（0-1），未走到 ③ 时为 undefined */
  diffPct?: number;
}

/** 像素混合：Alma 的 (77R + 150G + 29B) >> 8 */
function mix(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

/** FNV-1a 32 位；data 为 RGBA */
export function fnv1a(data: Uint8Array): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i + 3 < data.length; i += 4) {
    h ^= mix(data[i]!, data[i + 1]!, data[i + 2]!);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

export function toHex(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function bitmapHash(bitmap: Bitmap): string {
  return toHex(fnv1a(bitmap.data));
}

/** 任意字节流的 FNV-1a（降级路径用） */
export function bytesHash(bytes: Uint8Array): string {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]!; h = Math.imul(h, FNV_PRIME) >>> 0; }
  return toHex(h >>> 0);
}

/** 32 桶同权重直方图，按像素数归一化 */
export function histogram(bitmap: Bitmap): number[] {
  const buckets = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  const { data } = bitmap;
  const total = Math.max(1, data.length / 4);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const v = mix(data[i]!, data[i + 1]!, data[i + 2]!);
    const b = Math.min(HISTOGRAM_BUCKETS - 1, Math.max(0, v >> 3));
    buckets[b]! += 1;
  }
  for (let i = 0; i < buckets.length; i++) buckets[i] = buckets[i]! / total;
  return buckets;
}

export function sqrtNormalize(hist: number[]): number[] {
  return hist.map((v) => Math.sqrt(Math.max(0, v)));
}

/** 开根号后的欧氏距离 */
export function histogramDistance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < n; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); sum += d * d; }
  return Math.sqrt(sum);
}

/** 逐像素差分比例：任一通道差 > tolerance 记为「变了」 */
export function pixelDiffRatio(a: Bitmap, b: Bitmap, tolerance = PIXEL_TOLERANCE): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const da = a.data, db = b.data;
  const total = Math.max(1, a.width * a.height);
  let changed = 0;
  for (let i = 0; i + 3 < da.length; i += 4) {
    if (
      Math.abs(da[i]! - db[i]!) > tolerance ||
      Math.abs(da[i + 1]! - db[i + 1]!) > tolerance ||
      Math.abs(da[i + 2]! - db[i + 2]!) > tolerance
    ) changed++;
  }
  return changed / total;
}

// ── BMP 解码 ──────────────────────────────────────────────

function channel(value: number, mask: number): number {
  if (mask === 0) return 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0 && shift < 32) shift++;
  const bits = (mask >>> shift) >>> 0;
  let width = 0;
  while (((bits >>> width) & 1) === 1 && width + shift < 32) width++;
  if (width <= 0) return 0;
  const raw = (value & mask) >>> shift;
  const max = (1 << width) - 1;
  return width === 8 ? raw : Math.round((raw * 255) / max);
}

/** 解析 BMP（仅 BI_RGB / BI_BITFIELDS，24 或 32bpp，支持上下两种行序） */
export function decodeBmp(buf: Uint8Array): Bitmap | null {
  if (buf.length < 54) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint8(0) !== 0x42 || dv.getUint8(1) !== 0x4d) return null;   // "BM"
  const dataOffset = dv.getUint32(10, true);
  const headerSize = dv.getUint32(14, true);
  const width = dv.getInt32(18, true);
  const rawHeight = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const compression = dv.getUint32(30, true);
  const height = Math.abs(rawHeight);
  if (width <= 0 || height <= 0 || (bpp !== 24 && bpp !== 32)) return null;
  if (compression !== 0 && compression !== 3) return null;               // 压缩 BMP 不支持
  let rMask = 0x00ff0000, gMask = 0x0000ff00, bMask = 0x000000ff;
  if (compression === 3 && headerSize >= 56 && buf.length >= 66) {
    rMask = dv.getUint32(54, true);
    gMask = dv.getUint32(58, true);
    bMask = dv.getUint32(62, true);
  }
  const bytesPP = bpp / 8;
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  if (dataOffset + stride * height > buf.length) return null;
  const topDown = rawHeight < 0;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const p = row + x * bytesPP;
      const v = bytesPP === 4
        ? dv.getUint32(p, true)
        : (dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16));
      const o = (y * width + x) * 4;
      out[o] = channel(v >>> 0, rMask);
      out[o + 1] = channel(v >>> 0, gMask);
      out[o + 2] = channel(v >>> 0, bMask);
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** 用 sips 把任意图片转成小 BMP 再解码；失败返回 null（调用方走降级） */
export async function toBitmap(imagePath: string, bmpPath: string, maxWidth = DEDUPE_THUMB_WIDTH): Promise<Bitmap | null> {
  const r = await run(SIPS, ["-s", "format", "bmp", "-Z", String(maxWidth), imagePath, "--out", bmpPath]);
  if (r.code !== 0 || !existsSync(bmpPath)) return null;
  try {
    const bitmap = decodeBmp(readFileSync(bmpPath));
    try { unlinkSync(bmpPath); } catch { /* ignore */ }
    return bitmap;
  } catch { return null; }
}

// ── Deduper ───────────────────────────────────────────────

export interface DeduperState { hashHex: string; histogram: number[] }

export class Deduper {
  #hist: number[] | null = null;      // 已开根号
  #rawHist: number[] | null = null;
  #bitmap: Bitmap | null = null;
  #hash: string | null = null;
  #comparisons = 0;

  get comparisons(): number { return this.#comparisons; }
  get state(): DeduperState | null {
    return this.#hash && this.#rawHist ? { hashHex: this.#hash, histogram: this.#rawHist } : null;
  }

  /** 进程重启后从库里恢复上一次的快照指纹（没有位图，只做 ①②） */
  seed(hashHex: string | null, histogram: number[] | null): void {
    if (hashHex) this.#hash = hashHex;
    if (histogram && histogram.length) {
      this.#rawHist = histogram;
      this.#hist = sqrtNormalize(histogram);
    }
    this.#bitmap = null;
  }

  reset(): void {
    this.#hist = null; this.#rawHist = null; this.#bitmap = null; this.#hash = null; this.#comparisons = 0;
  }

  check(bitmap: Bitmap): DedupeResult {
    this.#comparisons++;
    const hash = bitmapHash(bitmap);
    const hist = histogram(bitmap);
    const sqrt = sqrtNormalize(hist);

    if (this.#hash && this.#hash === hash) {
      this.#remember(bitmap, hash, hist, sqrt);
      return { duplicate: true, reason: "hash" };
    }
    let diffPct: number | undefined;
    if (this.#hist && this.#bitmap) {
      const dist = histogramDistance(this.#hist, sqrt);
      if (dist < HISTOGRAM_THRESHOLD) {
        diffPct = pixelDiffRatio(this.#bitmap, bitmap);
        if (diffPct < PIXEL_DIFF_THRESHOLD) {
          this.#remember(bitmap, hash, hist, sqrt);
          return { duplicate: true, reason: "pixel", diffPct };
        }
      } else {
        this.#remember(bitmap, hash, hist, sqrt);
        return { duplicate: false, reason: "histogram", diffPct: 1 };   // 直方图差异过大：直接判「变了」
      }
    }
    this.#remember(bitmap, hash, hist, sqrt);
    return { duplicate: false, ...(diffPct !== undefined ? { diffPct } : {}) };
  }

  /** 降级路径：解不出位图时用原始字节哈希（同一块屏幕的 JPEG 编码是确定的） */
  checkRaw(bytes: Uint8Array): DedupeResult {
    this.#comparisons++;
    const hash = bytesHash(bytes);
    const dup = this.#hash !== null && this.#hash === `raw:${hash}`;
    this.#hash = `raw:${hash}`;
    this.#hist = null; this.#rawHist = null; this.#bitmap = null;
    return { duplicate: dup, reason: dup ? "raw" : undefined };
  }

  #remember(bitmap: Bitmap, hash: string, hist: number[], sqrt: number[]): void {
    this.#bitmap = bitmap;
    this.#hash = hash;
    this.#rawHist = hist;
    this.#hist = sqrt;
  }
}
