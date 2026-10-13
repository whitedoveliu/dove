/**
 * 分隔符文本（csv / tsv）→ 二维数组。
 *
 * 处理边界（**说清楚，不假装全能**）：
 *  · 认 RFC4180 的引号规则：`"a,b"` 里的分隔符不算分隔符、`""` 表示一个字面引号、
 *    引号内可以有换行（多行字段）；
 *  · CRLF / LF / 结尾无换行都吃；
 *  · 开头若有 UTF-8 BOM 会剥掉（Excel 导出的 csv 常有，不剥第一列会带上一个不可见字符）；
 *  · **不做**类型推断（全部按字符串返回，数字 / 日期 / 公式都不解释）；
 *  · **只解析前 maxRows 行 × maxCols 列**，多出来的丢掉并置 truncated —— 一张十万行的表
 *    铺进 DOM 就是卡死面板，这个取舍写死在调用方的常量里；
 *  · 列数不齐的行按自身长度返回（调用方按最长行补空格对齐展示）；
 *  · 引号不闭合（文件被截断）时，剩下的内容整段当最后一个字段 —— 不抛错。
 */
export interface ParsedTable {
  rows: string[][];
  /** 有行/列被丢掉（只解析了前 N 行或前 M 列） */
  truncated: boolean;
  /** 解析出来的总列数（= 最宽一行） */
  columns: number;
}

export function parseDelimited(text: string, delimiter: string, maxRows: number, maxCols: number): ParsedTable {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let truncated = false;

  const pushField = () => {
    if (row.length < maxCols) row.push(field);
    else truncated = true;
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (rows.length < maxRows) rows.push(row);
    else truncated = true;
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.length === 0) { inQuotes = true; continue; }
    if (ch === delimiter) { pushField(); continue; }
    if (ch === "\n") { pushRow(); continue; }
    if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      pushRow();
      continue;
    }
    field += ch;
  }
  // 结尾：最后一个字段/行没被换行收尾时才补
  if (field.length > 0 || row.length > 0) pushRow();

  // 全空行（只有分隔符）丢弃 —— 尾部的空行不该在表格里占一行
  const cleaned = rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
  const columns = cleaned.reduce((n, r) => Math.max(n, r.length), 0);
  return { rows: cleaned, truncated, columns };
}
