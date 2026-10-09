/**
 * Edit —— 精确字符串替换
 * 纪律：old_string 必须在文件里**唯一**，否则报错让模型自己补上下文（防止改错地方）。
 */
import * as fsp from "node:fs/promises";
import { defineTool, S } from "../types.ts";
import { guarded, resolveInsideWorkspace, relPath, str, optBool, readTextFile } from "./util.ts";

export const EditTool = defineTool({
  name: "Edit",
  description:
    "在文件里做精确字符串替换。old_string 必须与文件内容逐字符一致且**唯一**（不唯一就多带几行上下文，或改用 replace_all）。" +
    "替换失败不会改文件，会返回原因。",
  parameters: S.obj({
    file_path: S.str("要修改的文件路径"),
    old_string: S.str("要被替换的原文（必须唯一，除非 replace_all=true）"),
    new_string: S.str("替换成的新内容（可为空串 = 删除这段）"),
    replace_all: S.bool("true = 替换所有出现（默认 false，要求唯一）"),
  }, ["file_path", "old_string", "new_string"]),
  outputTier: "exact",
  approval: "heuristic",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    // ⚠️ 必须用带护栏的版本 —— 否则能改工作区外的文件且不审批（见 util 的说明）
    const abs = resolveInsideWorkspace(str(input, "file_path"), ctx.workdir);
    const oldStr = str(input, "old_string");
    const newStr = String(input.new_string ?? "");
    const replaceAll = optBool(input, "replace_all", false);

    const { text, binary } = readTextFile(abs);
    if (binary) throw new Error("这是二进制文件，Edit 不支持：" + relPath(abs, ctx.workdir));

    const count = text.split(oldStr).length - 1;
    if (count === 0) {
      return { file_path: relPath(abs, ctx.workdir), replacements: 0, error: "未找到 old_string（可能与文件内容不完全一致：注意空白/换行/缩进）。文件未被修改。" };
    }
    if (count > 1 && !replaceAll) {
      return { file_path: relPath(abs, ctx.workdir), replacements: 0, matches: count, error: "old_string 在文件中出现 " + count + " 次，不唯一。请多带上下文使其唯一，或设置 replace_all=true。文件未被修改。" };
    }

    const next = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
    await fsp.writeFile(abs, next, "utf8");

    const rel = relPath(abs, ctx.workdir);
    ctx.emit("tool:file-edited", { toolCallId: ctx.toolCallId, path: rel, replacements: count });
    return { file_path: rel, replacements: count, bytes: Buffer.byteLength(next, "utf8") };
  }),
});
