/**
 * Present —— 把「已经写完的文件」声明为交付物
 *
 * 参考 DSH 的 present，但有一条 Dove 自己的纪律：**它不复制内容、不生成文件**，
 * 只是把磁盘上已有的路径宣告给界面（前端渲染成卡片，点击预览/打开）。
 * 所以校验必须是「存在且是普通文件」—— 声明一个不存在的文件比不声明更糟。
 *
 * 工具结果里只有路径与说明；卡片是前端从工具参数里解析出来的（不新增事件类型），
 * 这样刷新页面、回放历史都能重建。
 */
import * as fsp from "node:fs/promises";
import { defineTool, S } from "../types.ts";
import { guarded, resolvePath, relPath, optStr } from "./util.ts";

/** 一次最多声明几个（DSH 也是 8，描述里建议 1–2） */
export const PRESENT_MAX_FILES = 8;

interface PresentedFile { path: string; description?: string; bytes?: number }

export const PresentTool = defineTool({
  name: "Present",
  description: [
    "把**已经存在的文件**声明为这次任务的交付物：界面会在回复下面渲染成卡片，用户可以点开预览。",
    "",
    "什么时候用：用户要的是一个能打开的文件（文档 / 表格 / 幻灯片 / 图片 / 报告 / 打包产物），",
    "而且单独一张卡片能让他直接打开它。",
    "",
    "不要用在：只是改了几个源文件（在回复里说清路径就行）；也不要为了让界面好看而调用。",
    "文件内容不会被复制或打包，卡片指向磁盘上那个路径 —— 所以文件必须**真的写完了**。",
    "声明完之后，回复里用一两句话说明每个交付物是什么，不要在正文里粘贴文件内容。",
  ].join("\n"),
  parameters: S.obj({
    files: S.arr(S.obj({
      path: S.str("已存在文件的路径（相对工作目录或绝对路径）"),
      description: S.str("一句话说明这是什么（给用户看的）"),
    }, ["path"]), "通常只报 1–2 个最重要的，一次最多 " + PRESENT_MAX_FILES + " 个"),
  }, ["files"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const raw = input.files;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { presented: 0, files: [], error: "files 不能为空：至少给一个已存在的文件路径。" };
    }
    const files: PresentedFile[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const item of raw.slice(0, PRESENT_MAX_FILES)) {
      const row = (item ?? {}) as Record<string, unknown>;
      const rawPath = optStr(row, "path") ?? "";
      const description = optStr(row, "description");
      if (!rawPath.trim()) { skipped.push({ path: "(空路径)", reason: "path 是空的" }); continue; }
      const abs = resolvePath(rawPath, ctx.workdir);
      const shown = relPath(abs, ctx.workdir);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) { skipped.push({ path: shown, reason: "文件不存在（先把文件写完再声明）" }); continue; }
      if (!st.isFile()) { skipped.push({ path: shown, reason: "不是普通文件" }); continue; }
      files.push({ path: shown, ...(description ? { description } : {}), bytes: st.size });
    }
    if (raw.length > PRESENT_MAX_FILES) {
      skipped.push({ path: "(其余 " + (raw.length - PRESENT_MAX_FILES) + " 个)", reason: "一次最多声明 " + PRESENT_MAX_FILES + " 个" });
    }
    return {
      presented: files.length,
      files,
      ...(skipped.length > 0 ? { skipped } : {}),
      note: files.length > 0
        ? "已声明 " + files.length + " 个交付物，界面会渲染成卡片；回复里用一两句话说明它们是什么。"
        : "没有任何文件被声明（看 skipped 里的原因）。"
        + (skipped.length > 0 ? " 有 " + skipped.length + " 个被跳过。" : ""),
    };
  }),
});
