/**
 * 图片重水化（T2.8）
 * 消息里存的是**引用**（文件路径），只有在真的要发给模型时才读成 data URL。
 * 这样历史消息不会把 base64 塞进数据库。
 */
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { ContentBlock } from "../providers/types.ts";
import { IMAGE_MAX_BYTES, IMAGE_MAX_PER_MESSAGE } from "../constants.ts";

/**
 * 单张图上限：超过就不发（否则一次请求能把上下文撑爆）。
 * ⚠️ 值来自 constants.ts 的**单点定义** —— ReadImage 工具用的是同一个数，
 *    在这里另写一个字面量就会出现「工具说读到了、装配时被静默跳过」。
 */
export const MAX_IMAGE_BYTES = IMAGE_MAX_BYTES;
/** 一条消息最多带几张图 */
export const MAX_IMAGES_PER_MESSAGE = IMAGE_MAX_PER_MESSAGE;

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};

export interface HydrateOptions {
  /** 模型是否支持图片输入；不支持时降级为文字提示 */
  supportsImages?: boolean;
  maxBytes?: number;
}

export interface HydrateResult {
  blocks: ContentBlock[];
  /** 降级说明（该告诉模型的东西） */
  notes: string[];
}

/**
 * 把图片引用转成可发送的 content block。
 * 任何失败都降级为文字提示 —— 不能因为一张图读不到就整轮失败。
 */
export function hydrateImages(refs: string[], opts: HydrateOptions = {}): HydrateResult {
  const notes: string[] = [];
  const blocks: ContentBlock[] = [];
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;

  if (opts.supportsImages === false) {
    if (refs.length > 0) notes.push(`（本模型不支持图片输入，${refs.length} 张图已省略）`);
    return { blocks, notes };
  }

  for (const ref of refs.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    if (ref.startsWith("data:")) { blocks.push({ type: "image_url", image_url: { url: ref } }); continue; }
    if (/^https?:\/\//.test(ref)) { blocks.push({ type: "image_url", image_url: { url: ref } }); continue; }

    const mime = MIME[extname(ref).toLowerCase()];
    if (!mime) { notes.push(`（${ref} 不是支持的图片格式，已跳过）`); continue; }
    try {
      const st = statSync(ref);
      if (st.size > maxBytes) {
        notes.push(`（${ref} 有 ${(st.size / 1024 / 1024).toFixed(1)}MB，超过单图上限，已跳过）`);
        continue;
      }
      const b64 = readFileSync(ref).toString("base64");
      blocks.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
    } catch (e) {
      notes.push(`（读不到 ${ref}：${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  if (refs.length > MAX_IMAGES_PER_MESSAGE) notes.push(`（还有 ${refs.length - MAX_IMAGES_PER_MESSAGE} 张图未发送）`);
  return { blocks, notes };
}
