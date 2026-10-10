/**
 * ReadImage —— 看图（把本地图片送进模型的眼睛）
 *
 * 关键接线：OpenAI 兼容协议里 role:"tool" 的 content **只能是字符串**，
 * 图片塞不进工具结果。所以这里不返回图片，而是通过 ctx.services.attachImage
 * 把图片挂到既有的 image part 链路上（消息 parts 的 "image" 类型）：
 *   ReadImage → attachImage（运行时）→ store 落一条带 image part 的 user 消息
 *             → 运行中在下一步注入 / 之后每轮由 toWireHistory 重水化成 data URL
 * 工具结果本身是 JSON 文本（路径、字节数、是否挂上），保证 assistant.tool_calls
 * 与 role:"tool" 的配对纪律不被破坏。
 */
import * as fsp from "node:fs/promises";
import { basename, extname } from "node:path";
import { defineTool, S } from "../types.ts";
import { IMAGE_MAX_BYTES } from "../../constants.ts";
import { guarded, resolvePath, relPath, str, optNum, humanBytes, clampNum } from "./util.ts";

/** 认识这五种：和 context/images.ts 的 MIME 表一一对应 */
export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export const SUPPORTED_IMAGE_HINT = "支持 png / jpg / jpeg / webp / gif，单张上限 " + humanBytes(IMAGE_MAX_BYTES) + "。";

export const ReadImageTool = defineTool({
  name: "ReadImage",
  description: [
    "读一张本地图片并**真的看到它**（png / jpg / jpeg / webp / gif，单张 ≤ " + humanBytes(IMAGE_MAX_BYTES) + "）。",
    "",
    "什么时候用：用户给了图片路径、你想看截图/设计稿/报错画面里到底有什么。",
    "只想拿图片里的文字做检索可以先用 OCR 类脚本；要理解画面内容就用本工具。",
    "",
    "它的工作方式（别误解结果）：",
    "- 返回的 JSON 只是回执（路径 / 字节数 / 是否挂上），**图片本身会作为一条消息挂进对话**；",
    "- 你在**下一步**就能看到图，不需要用户再发一次；",
    "- 文件不存在 / 格式不支持 / 超过上限时，返回结构化错误并说明原因，不会中断这一轮。",
  ].join("\n"),
  parameters: S.obj({
    file_path: S.str("图片路径（相对工作目录，或绝对路径）"),
    max_bytes: S.num("本次允许的最大字节数（可选，默认 " + IMAGE_MAX_BYTES + "；上限就是它，调高无效）"),
  }, ["file_path"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const raw = str(input, "file_path");
    const abs = resolvePath(raw, ctx.workdir);
    const shown = relPath(abs, ctx.workdir);
    const requested = optNum(input, "max_bytes");
    const maxBytes = requested === undefined
      ? IMAGE_MAX_BYTES
      : clampNum(Math.floor(requested), 1024, IMAGE_MAX_BYTES);

    const st = await fsp.stat(abs).catch(() => null);
    if (!st) {
      return { file_path: shown, attached: false, error: "文件不存在：" + shown, note: "确认路径后再试；目录用 Glob/Read 看。" };
    }
    if (st.isDirectory()) {
      return { file_path: shown, attached: false, error: "这是目录，不是图片文件：" + shown };
    }

    const ext = extname(abs).toLowerCase();
    const mediaType = IMAGE_MIME[ext];
    if (!mediaType) {
      return {
        file_path: shown, bytes: st.size, attached: false,
        error: "不支持的图片格式：" + (ext || "(无扩展名)"),
        supported: Object.keys(IMAGE_MIME), note: SUPPORTED_IMAGE_HINT,
      };
    }
    if (st.size > maxBytes) {
      return {
        file_path: shown, bytes: st.size, max_bytes: maxBytes, attached: false,
        error: "图片过大：" + humanBytes(st.size) + "，超过上限 " + humanBytes(maxBytes),
        note: requested !== undefined && requested < IMAGE_MAX_BYTES
          ? "可以调大 max_bytes（上限 " + humanBytes(IMAGE_MAX_BYTES) + "），或先用 Bash 缩放/压缩再读。"
          : "先用 Bash（sips / ffmpeg）缩放或压缩，再读缩放后的文件。",
      };
    }

    const attach = ctx.services?.attachImage;
    if (!attach) {
      return {
        file_path: shown, bytes: st.size, mediaType, attached: false,
        error: "VISION_UNAVAILABLE",
        note: "图片通道没接上（ctx.services.attachImage 为空）—— 我看不到这张图。" +
          "可以先用 Bash 跑 OCR / 读 EXIF 之类的替代手段，或告诉用户无法看图。",
      };
    }

    const res = await attach({ path: abs, mediaType, filename: basename(abs) });
    if (!res.ok) {
      return {
        file_path: shown, bytes: st.size, mediaType, attached: false,
        error: res.error ?? "图片挂载失败", note: res.note,
      };
    }

    ctx.emit("tool:image-attached", {
      toolCallId: ctx.toolCallId, file: shown, bytes: st.size, messageId: res.id,
    });
    return {
      file_path: shown, bytes: st.size, mediaType, attached: true, messageId: res.id,
      note: "图片已经挂进这次对话了：**下一步就能看到**。" + (res.note ? " " + res.note : "") +
        "不要仅凭文件名猜测画面内容 —— 看完图再回答。",
    };
  }),
});
