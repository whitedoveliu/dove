/**
 * Grep —— 正则搜索文件内容（零依赖，node:fs 自己实现）
 * 输出形如 文件:行号:内容；compact 档，超预算由 budget.ts 落盘。
 * 纪律：命中上限被截断时必须在结果里说清「这只是摘录覆盖」。
 */
import * as path from "node:path";
import { defineTool, S } from "../types.ts";
import { guarded, resolvePath, relPath, str, optStr, optNum, optBool, walkFiles, compileGlob, readTextFile } from "./util.ts";

const DEFAULT_MAX = 250;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_CHARS = 400;

function buildInclude(include: string | undefined): ((rel: string) => boolean) | undefined {
  if (!include) return undefined;
  const p = include.trim().split(path.sep).join("/");
  if (!p.includes("/")) {
    const re = compileGlob(p);
    return (rel) => re.test(rel.split("/").pop() ?? rel);
  }
  const re = compileGlob(p);
  return (rel) => re.test(rel);
}

export const GrepTool = defineTool({
  name: "Grep",
  description:
    "用正则在文件内容里搜索（内置实现，返回 文件:行号:内容）。不要用 grep 猜代码结构，先 Grep 再 Read 具体文件。" +
    "达到上限时只返回**摘录覆盖**，不代表「不存在」；需要确认请缩小 path/include 再搜。",
  parameters: S.obj({
    pattern: S.str("正则表达式（JS 正则语法）"),
    path: S.str("搜索根目录或单个文件（默认当前工作目录）"),
    include: S.str("只搜匹配该 glob 的文件，如 *.ts 或 src/**/*.tsx"),
    ignore_case: S.bool("忽略大小写（默认 false）"),
    max_results: S.num("最多返回多少条匹配（默认 " + DEFAULT_MAX + "）"),
  }, ["pattern"]),
  outputTier: "compact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const pattern = str(input, "pattern");
    const target = resolvePath(optStr(input, "path") ?? ".", ctx.workdir);
    const maxResults = Math.max(1, Math.min(2000, Math.floor(optNum(input, "max_results") ?? DEFAULT_MAX)));

    let re: RegExp;
    try {
      re = new RegExp(pattern, optBool(input, "ignore_case", false) ? "i" : "");
    } catch (e) {
      return { pattern, error: "正则不合法：" + (e instanceof Error ? e.message : String(e)) };
    }

    const includeMatch = buildInclude(optStr(input, "include"));
    const st = await import("node:fs/promises").then((m) => m.stat(target)).catch(() => null);
    const single = st?.isFile() ? [target] : (await walkFiles({
      root: target,
      match: includeMatch ? (_abs, rel) => includeMatch(rel) : undefined,
    })).files;

    const lines: string[] = [];
    let truncated = false;
    let searched = 0;
    for (const abs of single) {
      if (lines.length >= maxResults) { truncated = true; break; }
      const info = await (async () => {
        try { return readTextFile(abs, MAX_FILE_BYTES); } catch { return null; }
      })();
      if (!info || info.binary) continue;
      searched++;
      const rows = info.text.split("\n");
      for (let i = 0; i < rows.length; i++) {
        const line = rows[i];
        if (!re.test(line)) continue;
        if (lines.length >= maxResults) { truncated = true; break; }
        const shown = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + " …[本行超长已截断]" : line;
        lines.push(relPath(abs, ctx.workdir) + ":" + (i + 1) + ":" + shown);
      }
    }

    return {
      pattern,
      root: relPath(target, ctx.workdir),
      matches: lines.length,
      files_searched: searched,
      truncated,
      result: lines.join("\n"),
      note: truncated
        ? "已达到 " + maxResults + " 条上限，**这只是摘录覆盖**（匹配可能更多）。" +
          "请用更窄的 path/include 或更精确的 pattern 分批搜索；不要据此断言「只有这些」或「不存在」。"
        : lines.length === 0 ? "没有匹配。注意：正则语义、大小写、include 过滤都会影响结果。" : undefined,
    };
  }),
});
