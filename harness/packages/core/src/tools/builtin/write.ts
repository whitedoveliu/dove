/**
 * Write —— 写文件（自动建父目录）
 * 整文件覆盖；改局部请用 Edit（避免重写整文件带来的风险与噪音）。
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { defineTool, S } from "../types.ts";
import { guarded, resolvePath, resolveInsideWorkspace, relPath, str, ensureDir, readTextFile } from "./util.ts";
import { recordFileMutation } from "../turn-diff.ts";
import type { ToolAccesses } from "../types.ts";

/**
 * 「同意并记住」的参数模式：照抄模型给的 file_path 逐字。
 * 为什么不做绝对化：`Tool.approvalRule(args)` 拿不到 workdir（tools/types.ts 的签名），
 * 用 process.cwd() 会把别的项目的相对路径也解析到同一处 —— 那是悄悄扩大授权，
 * 比「规则不够精确」危险得多。要绝对化得给 approvalRule 加第二个参数（见交接说明）。
 */
function ruleArg(args: Record<string, unknown>): string | undefined {
  const p = args.file_path;
  return typeof p === "string" && p.trim() ? p.trim() : undefined;
}

/**
 * 并发调度声明：写**一个文件**（非递归）。
 * 路径用 resolvePath（不抛）：越界由 execute 里那道 resolveInsideWorkspace 拦
 * （那里才会抛，且是结构化错误）；调度阶段一抛就是整批拖垮。
 */
export function writeAccesses(args: Record<string, unknown>, workdir: string): ToolAccesses {
  const p = args.file_path;
  if (typeof p !== "string" || !p.trim()) return { kind: "all" };
  return { kind: "paths", paths: [{ path: resolvePath(p, workdir), operation: "write" }] };
}

/**
 * 取覆盖前的旧内容 —— **必须在落盘之前调**，写完再读就只剩新内容了。
 *
 * 为什么读失败（超过 readTextFile 的 32MB 上限 / 权限 / 二进制）也返回 "" 而不是 null：
 * null 在净 diff 里的含义是「文件当时不存在」，会让这个文件被标成 created ——
 * 将来「回退这一轮」可能据此把文件删掉，比行数不准危险得多。
 * 退化成「旧内容为空」至少保住了「覆盖了一个已存在的文件」这个事实。
 */
function readBefore(abs: string): string {
  try {
    const r = readTextFile(abs);
    return r.binary ? "" : r.text;
  } catch {
    return "";
  }
}

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
  accesses: writeAccesses,
  approvalRule: ruleArg,
  execute: (input, ctx) => guarded(async () => {
    // ⚠️ 必须用带护栏的版本 —— 否则能写到工作区外且不审批（见 util 的说明）
    const abs = resolveInsideWorkspace(str(input, "file_path"), ctx.workdir);
    if (input.content === undefined || input.content === null) throw new Error("缺少必填参数 content");
    const content = String(input.content);
    const existed = await fsp.stat(abs).then((s) => s.isFile()).catch(() => false);
    // 净 diff 的 before 只在这里读一次（覆盖已有文件时）；不为了记账去读第二遍
    const before = existed ? readBefore(abs) : null;

    ensureDir(path.dirname(abs));
    await fsp.writeFile(abs, content, "utf8");

    const bytes = Buffer.byteLength(content, "utf8");
    const rel = relPath(abs, ctx.workdir);
    // 写成功了才记账；记账本身失败绝不能连累这次写入（吞掉，只当没记上）
    try { recordFileMutation(ctx.threadId, { path: rel, before, after: content }); } catch { /* 忽略 */ }
    ctx.emit("tool:file-written", { toolCallId: ctx.toolCallId, path: rel, bytes, created: !existed });
    return { file_path: rel, bytes, lines: content.split("\n").length, created: !existed };
  }),
});
