/**
 * GenerateImage —— 生成图片
 * 零依赖实现：优先用 fal.ai（有 FAL_KEY 时），否则回退生成一张**本地 SVG 占位图**，
 * 并如实告诉模型/用户「这是占位图，不是 AI 生成」—— 绝不假装生成了真实图片。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "../types.ts";
import { guarded, str, optStr, optNum } from "./util.ts";

const FAL_ENDPOINT = "https://fal.run/fal-ai/flux/schnell";

/** 由描述确定性地挑一组配色，保证占位图不难看 */
function paletteFor(seed: string): [string, string] {
  const palettes: [string, string][] = [
    ["#2f5d50", "#e8e2d5"], ["#8a5a3b", "#f2ece2"], ["#3b4a63", "#e6e8ee"],
    ["#6b5b4a", "#f0ebe3"], ["#42564d", "#e9efe9"], ["#7a4b5a", "#f3eaee"],
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palettes[h % palettes.length]!;
}

function placeholderSvg(prompt: string, w: number, h: number): string {
  const [fg, bg] = paletteFor(prompt);
  const label = prompt.slice(0, 42).replace(/[<>&]/g, "");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="${bg}"/>`,
    `<circle cx="${w * 0.3}" cy="${h * 0.4}" r="${Math.min(w, h) * 0.22}" fill="${fg}" opacity="0.85"/>`,
    `<rect x="${w * 0.5}" y="${h * 0.32}" width="${w * 0.32}" height="${h * 0.36}" rx="8" fill="${fg}" opacity="0.55"/>`,
    `<text x="${w * 0.5}" y="${h * 0.88}" font-family="Helvetica, sans-serif" font-size="${Math.round(h * 0.045)}" fill="${fg}" text-anchor="middle" opacity="0.75">${label}</text>`,
    "</svg>",
  ].join("");
}

export const GenerateImageTool = defineTool({
  name: "GenerateImage",
  discoverable: "按描述生成图片",
  description: [
    "按描述生成图片，保存到项目目录。",
    "prompt 写清：主体 + 风格 + 光线 + 构图。英文 prompt 通常效果更好。",
    "返回里会说明是真·AI 生成还是本地占位图 —— 汇报给用户时请如实转述。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "图片描述（越具体越好）" },
      filename: { type: "string", description: "保存的文件名（不含扩展名）" },
      directory: { type: "string", description: "保存目录，默认 assets/generated" },
      width: { type: "number", description: "宽度，默认 1024" },
      height: { type: "number", description: "高度，默认 1024" },
    },
    required: ["prompt"],
  },
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const prompt = str(input, "prompt");
    const w = Math.min(Math.max(optNum(input, "width") ?? 1024, 64), 2048);
    const h = Math.min(Math.max(optNum(input, "height") ?? 1024, 64), 2048);
    const dir = join(ctx.workdir, optStr(input, "directory") ?? "assets/generated");
    mkdirSync(dir, { recursive: true });
    const base = (optStr(input, "filename") ?? prompt.slice(0, 24).replace(/[^\p{L}\p{N}_-]/gu, "_")) || "image";

    const falKey = process.env.FAL_KEY ?? process.env.FAL_API_KEY;
    if (falKey) {
      try {
        const res = await fetch(FAL_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, image_size: { width: w, height: h }, num_images: 1 }),
          signal: AbortSignal.timeout(120_000),
        });
        if (res.ok) {
          const data = await res.json() as { images?: { url?: string }[] };
          const url = data.images?.[0]?.url;
          if (url) {
            const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
            const buf = Buffer.from(await img.arrayBuffer());
            const file = join(dir, base + ".png");
            writeFileSync(file, buf);
            return { ok: true, path: file, source: "fal.ai", bytes: buf.length, message: `已生成图片：${file}` };
          }
        }
      } catch { /* 落到占位图 */ }
    }

    const svg = placeholderSvg(prompt, w, h);
    const file = join(dir, base + ".svg");
    writeFileSync(file, svg);
    return {
      ok: true, path: file, source: "placeholder", bytes: svg.length,
      message: `已在 ${file} 生成一张**本地占位图**（未配置 FAL_KEY，没有调用真正的生图模型）。`,
      note: "这是占位图，不是 AI 生成的成品。汇报时必须如实说明，不要让用户误以为已经拿到真实配图。配置 FAL_KEY 后会自动改用 fal.ai。",
    };
  }),
});
