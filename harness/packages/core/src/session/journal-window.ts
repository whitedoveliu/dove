/**
 * 压缩窗口：把「被摘要的是哪几行」变成**行号**（从 journal.ts 拆出来 —— 那边贴着 400 行硬约束）
 *
 * 窗口标记是一条普通记录（type = JOURNAL_WINDOW_TYPE），**压缩时由 runtime 追加**。它的语义：
 *   标记**之前**的行 = 已被摘要覆盖的内容（压缩那一刻的全量原文）；
 *   标记本身及其**之后**的行 = 压缩之后新写进来的（绝不会在摘要里）。
 * 所以「被摘要那一段」= 标记之前 —— 反着取（标记之后的区间）拿到的是**没被摘要**的新内容，
 * 把它写成「被摘要的是第 X–Y 行」= 给模型一个错坐标，照着 grep 只会白跑几步。
 *
 * 为什么值钱：模型唯一的检索手段是拿行号去 grep 日志。「最近 200 行」压在压缩这个时刻上，
 * 几乎整段落在没被摘要的地方 —— 假精确比没有指针更坏（它让人以为有档可查）。
 */
export const JOURNAL_WINDOW_TYPE = "context.window";

/** Context Recovery 段要的三件东西（结构上就是 context/recovery-footer.ts 的 RecoveryInfo） */
export interface RecoveryPointer {
  logPath: string;
  startLine?: number;
  endLine?: number;
  /** true = 区间只是「最近 n 行」的**估计**（没有标记可依）；false/缺省 = 真的对应被摘要那一段 */
  approximate?: boolean;
}

/** lastWindow 的返回：approximate **必填** —— 调用方没法「忘了标」，文案就不会假装精确 */
export interface WindowPointer extends RecoveryPointer { approximate: boolean }

/** 区间部分（logPath 由 journal 自己补，纯函数才好测） */
export type WindowRange = Omit<WindowPointer, "logPath">;

/**
 * 最近一条窗口标记的行号（1-based，== seq 字段）；没有返回 null。
 * 从尾部往前扫：标记总在最近一次压缩那里，而压缩远少于写入。
 * 坏行当**不是**标记跳过（journal 读时会把坏行修掉，这里不必再做一遍校验）。
 */
export function windowMarkLine(lines: readonly string[]): number | null {
  for (let i = lines.length - 1; i > 0; i--) {   // i > 0：第 1 行是 metadata，不可能是标记
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      if ((JSON.parse(line) as { type?: string }).type === JOURNAL_WINDOW_TYPE) return i + 1;
    } catch { /* 坏行：跳过 */ }
  }
  return null;
}

/**
 * 区间：有标记（且标记之前真有内容）→ [2, 标记前一行]，**精确**；
 * 否则退回「最近 n 行」并标 approximate=true —— 那是估计，不许当证据。
 *
 * 已知边界（有意保留，别当 bug「优化」掉）：
 * ① 起点固定第 2 行（本文件第一行内容），而不是「上一次标记之后」：摘要覆盖的是整个上下文
 *    （摘要还能再被摘要），从上一次标记起算反而会把更早、但同样被摘要覆盖的内容排除在外；
 * ② 压缩会原样保留最近几轮，它们排在标记之前、其实没被摘要 —— 这段重叠只靠行号消不掉
 *    （runtime 不知道某条消息落在第几行）。宁可多给一小段，也不给偏小的区间：
 *    偏小 = 模型查不到它要的细节。
 */
export function windowRange(end: number, mark: number | null, n: number): WindowRange {
  if (mark !== null && mark > 2) return { startLine: 2, endLine: mark - 1, approximate: false };
  if (end < 2) return { approximate: true };
  return { startLine: Math.max(2, end - Math.max(1, Math.floor(n)) + 1), endLine: end, approximate: true };
}
