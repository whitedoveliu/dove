/**
 * Edit —— 精确字符串替换
 * 纪律：old_string 必须在文件里**唯一**，否则报错让模型自己补上下文（防止改错地方）。
 */
import * as fsp from "node:fs/promises";
import { defineTool, S } from "../types.ts";
import { guarded, resolvePath, resolveWritablePath, relPath, str, optBool, readTextFile } from "./util.ts";
import { recordFileMutation } from "../turn-diff.ts";
import type { ToolAccesses } from "../types.ts";

/**
 * 「同意并记住」的参数模式：照抄 file_path 逐字。不绝对化 —— approvalRule 拿不到 workdir，
 * 用 process.cwd() 会把别的项目的相对路径也解析到同一处（悄悄扩大授权，比不精确危险得多）。
 */
function ruleArg(args: Record<string, unknown>): string | undefined {
  const p = args.file_path;
  return typeof p === "string" && p.trim() ? p.trim() : undefined;
}

/** 并发调度声明：改**一个文件**（非递归）；越界由 execute 里的护栏拦，这里不抛 */
export function editAccesses(args: Record<string, unknown>, workdir: string): ToolAccesses {
  const p = args.file_path;
  if (typeof p !== "string" || !p.trim()) return { kind: "all" };
  return { kind: "paths", paths: [{ path: resolvePath(p, workdir), operation: "write" }] };
}

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
  accesses: editAccesses,
  approvalRule: ruleArg,
  execute: (input, ctx) => guarded(async () => {
    // ⚠️ 必须用带护栏的版本 —— 否则能改工作区外的文件且不审批（见 util 的说明）
    const abs = resolveWritablePath(str(input, "file_path"), ctx.workdir, ctx.permission);
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
    // 净 diff：before 就是刚才读进来做替换的那份 text，after 是落盘内容 —— 一次额外 IO 都没有。
    // 写成功了才记账；记账失败不能连累这次编辑（吞掉）
    try { recordFileMutation(ctx.threadId, { path: rel, before: text, after: next }); } catch { /* 忽略 */ }
    ctx.emit("tool:file-edited", { toolCallId: ctx.toolCallId, path: rel, replacements: count });
    return { file_path: rel, replacements: count, bytes: Buffer.byteLength(next, "utf8") };
  }),
});
