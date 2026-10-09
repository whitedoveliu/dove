/**
 * Write —— 写文件（自动建父目录）
 * 整文件覆盖；改局部请用 Edit（避免重写整文件带来的风险与噪音）。
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { defineTool, S } from "../types.ts";
import { guarded, resolveInsideWorkspace, relPath, str, ensureDir } from "./util.ts";

export const WriteTool = defineTool({
  name: "Write",
  description:
    "把完整内容写入文件（覆盖同路径旧文件，自动创建父目录）。" +
    "只想改一小段时用 Edit 更安全；写之前建议先 Read 确认现状。",
  parameters: S.obj({
    file_path: S.str("目标文件路径（相对工作目录，或绝对路径）"),
    content: S.str("要写入的完整内容（UTF-8）"),
  }, ["file_path", "content"]),
  outputTier: "exact",
  approval: "heuristic",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    // ⚠️ 必须用带护栏的版本 —— 否则能写到工作区外且不审批（见 util 的说明）
    const abs = resolveInsideWorkspace(str(input, "file_path"), ctx.workdir);
    if (input.content === undefined || input.content === null) throw new Error("缺少必填参数 content");
    const content = String(input.content);
    const existed = await fsp.stat(abs).then((s) => s.isFile()).catch(() => false);

    ensureDir(path.dirname(abs));
    await fsp.writeFile(abs, content, "utf8");

    const bytes = Buffer.byteLength(content, "utf8");
    const rel = relPath(abs, ctx.workdir);
    ctx.emit("tool:file-written", { toolCallId: ctx.toolCallId, path: rel, bytes, created: !existed });
    return { file_path: rel, bytes, lines: content.split("\n").length, created: !existed };
  }),
});
