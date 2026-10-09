/**
 * Glob —— 文件名模式匹配（零依赖，node:fs 递归自己实现）
 * 输出档 compact：结果是一串路径，超预算由 budget.ts 裁剪并落盘。
 */
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { defineTool, S } from "../types.ts";
import { guarded, resolvePath, relPath, str, optStr, optNum, walkFiles, compileGlob } from "./util.ts";

const MAX_RESULTS = 200;

/** 把绝对 pattern 收敛到 root 之下；不含 / 的模式按「任意层级的文件名」处理 */
function buildMatcher(pattern: string, root: string, workdir: string): (rel: string) => boolean {
  let p = pattern.trim().split(path.sep).join("/");
  if (path.isAbsolute(p)) {
    const rel = path.relative(root, p).split(path.sep).join("/");
    if (!rel.startsWith("..")) p = rel;
  }
  if (!p.includes("/")) {
    const re = compileGlob(p);
    return (rel) => re.test(rel.split("/").pop() ?? rel);
  }
  const re = compileGlob(p);
  return (rel) => re.test(rel);
}

export const GlobTool = defineTool({
  name: "Glob",
  description:
    "按文件名模式查找文件（内置实现，支持 ** * ? {a,b}；默认跳过 node_modules / .git 等）。" +
    "适合「有哪些文件」；要按内容找请用 Grep。结果按修改时间倒序，最多 " + MAX_RESULTS + " 条。",
  parameters: S.obj({
    pattern: S.str("glob 模式，如 **/*.ts、src/**/*.css；不含 / 时按文件名在任意层级匹配"),
    path: S.str("搜索根目录（默认当前工作目录）"),
    max_results: S.num("最多返回多少条（默认 " + MAX_RESULTS + "）"),
  }, ["pattern"]),
  outputTier: "compact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const pattern = str(input, "pattern");
    const root = resolvePath(optStr(input, "path") ?? ".", ctx.workdir);
    const limit = Math.max(1, Math.min(2000, Math.floor(optNum(input, "max_results") ?? MAX_RESULTS)));

    const match = buildMatcher(pattern, root, ctx.workdir);
    // walkFiles 的回调签名是 (abs, rel)：这里必须用相对路径匹配，否则 '**/*.ts' 这类模式永远不命中
    const { files, scanned, capped } = await walkFiles({ root, match: (_abs, rel) => match(rel) });

    const withTime: { rel: string; mtime: number }[] = [];
    for (const abs of files) {
      const st = await fsp.stat(abs).catch(() => null);
      withTime.push({ rel: relPath(abs, ctx.workdir), mtime: st ? st.mtimeMs : 0 });
    }
    withTime.sort((a, b) => b.mtime - a.mtime);

    const picked = withTime.slice(0, limit).map((f) => f.rel);
    const truncated = withTime.length > picked.length;
    return {
      pattern,
      root: relPath(root, ctx.workdir),
      count: withTime.length,
      files: picked,
      truncated,
      note: truncated
        ? "只返回了前 " + picked.length + " 条（匹配共 " + withTime.length + " 条，扫描 " + scanned + " 个文件）。" +
          "这是**摘录覆盖**，不代表只有这些文件；请收窄 pattern 或指定 path 再查。"
        : capped ? "扫描达到上限提前停止，结果可能不完整（请指定更小的 path）。" : undefined,
    };
  }),
});
