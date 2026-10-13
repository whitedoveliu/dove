/**
 * Context Recovery 指针（压缩后追加到摘要正文末尾）
 * 为什么要有：session/event-log.ts 的纪律是「模型可见 ⟺ 已记录」，但模型不知道**去哪找** ——
 * 那条纪律就只是可观测性，不是可恢复性。压缩必然把早期消息移出上下文，摘要必然丢细节；
 * 真正能兜住「摘要里没写的那一条」的，是磁盘上那份**只追加**的 NDJSON。
 * 所以压缩完必须给模型一个指针：文件在哪、被摘要的是哪几行、怎么读。
 * 抄 Kimi 的 Context Recovery 段。
 *
 * 纪律：拿不到 logPath 就返回**空串**。半截指针（只写「内容已存档」却不给路径）
 * 比没有指针更坏 —— 模型会以为有档可查，转身去找一个不存在的路径，白烧几步。
 *
 * ⚠️ 行号要么精确、要么**明说是估的**（approximate）：模型会照这个区间去 grep，
 *    「最近 n 行」被写成「被摘要的就是这几行」时，它落到的多半是没被摘要的地方 ——
 *    等于花几步确认「这里没有我要的细节」。精确区间由压缩时的窗口标记给出
 *    （session/journal.ts 的 markWindowStart / lastWindow）。
 */
export interface RecoveryInfo {
  /** 事件日志绝对路径 */
  logPath: string;
  /** 被摘要的行段（例如第 120–840 行）；拿不到就留空 */
  startLine?: number;
  endLine?: number;
  /**
   * true = 上面那个区间**只是估计**（没有窗口标记，按「最近 n 行」凑的）。
   * 有它就得如实说：模型会拿着行号去 grep，区间若落在**没被摘要**的地方，它白跑几步还找不回细节 ——
   * 假精确比直说「这是估计」更坏（见 session/journal.ts 的 markWindowStart / lastWindow）。
   */
  approximate?: boolean;
  /** 工具结果外置目录（<workdir>/.spill），没有就不提 */
  spillDir?: string;
}

/** 行号归一：只认 ≥ 1 的整数（NaN / 0 / 负数一律当没给，宁可不写也不写错） */
function lineNo(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/** 行段写法：两头都有写区间（起点大于终点时自动换回来），只有一头就写单边 */
export function formatLineRange(startRaw?: number, endRaw?: number): string {
  let start = lineNo(startRaw);
  let end = lineNo(endRaw);
  if (start !== undefined && end !== undefined && start > end) [start, end] = [end, start];
  if (start !== undefined && end !== undefined) return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
  if (start !== undefined) return `从第 ${start} 行起`;
  if (end !== undefined) return `到第 ${end} 行为止`;
  return "";
}

/**
 * 近似区间的写法：**必须**把「这是估计」说出来。
 * 为什么这句值钱：模型拿到行号会先去 grep；区间只是「最近 n 行」时，
 * 它多半落在**没被摘要**的那一段 —— 白烧几步，还找不回细节。
 * 所以宁可写清「近似 + 最近多少行」，也不要拿估计冒充「被摘要的就是这几行」。
 */
function approximateSentence(startRaw?: number, endRaw?: number): string {
  const start = lineNo(startRaw);
  const end = lineNo(endRaw);
  const count = start !== undefined && end !== undefined ? Math.abs(end - start) + 1 : undefined;
  const span = count !== undefined ? `最近 ${count} 行` : "一段";
  return `被摘要的大致是${formatLineRange(startRaw, endRaw)}（近似区间：${span} —— `
    + "没有窗口标记，边界是估的，别当成精确范围用）。";
}

/**
 * 渲染 `### Context Recovery` 段；info 为空（或 logPath 为空）→ 空串。
 * 读取方式**必须**写进提示里：日志一行就是一条完整 JSON，工具结果那条经常上万字符，
 * 整文件读一次能直接把刚压缩出来的余量吃回去 —— 正确姿势是先 grep 拿行号、再只读那一行。
 */
export function renderRecoveryFooter(info?: RecoveryInfo): string {
  const logPath = typeof info?.logPath === "string" ? info.logPath.trim() : "";
  if (!logPath) return "";

  const range = formatLineRange(info?.startLine, info?.endLine);
  const lines: string[] = [
    "### Context Recovery",
    "",
    "这份摘要**之前**的完整内容仍然在磁盘上的事件日志里（只追加、不改写，压缩不会删掉它）：",
    `\`${logPath}\``,
  ];
  // 精确 ↔ 近似：两种写法只差这一句，读法（grep 再只读那一行）两种都不变
  if (range) lines.push("", info?.approximate
    ? approximateSentence(info?.startLine, info?.endLine)
    : `被摘要的是${range}。`);
  lines.push(
    "",
    "读法：日志**每行是一条完整 JSON**，一条工具结果动辄上万字符 —— **先用 grep 拿到行号，再只读那一行**"
      + "（例如 `sed -n '812p' <日志文件>`），不要整文件读。",
  );
  const spill = typeof info?.spillDir === "string" ? info.spillDir.trim() : "";
  if (spill) {
    lines.push("", `超出预算的工具结果正文外置在 \`${spill}\`（文件名是工具调用 id），需要细节时去那里读。`);
  }
  return lines.join("\n");
}
