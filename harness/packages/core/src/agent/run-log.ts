/**
 * 每轮的双写日志门面（事件日志 + 线程日志）
 *
 * 为什么要两份：
 * - `session/event-log.ts` 的按天全局文件是**面板日志页的契约**（`/api/logs` 读它），动它会连带改面板；
 * - `session/journal.ts` 的每线程文件才是**可重放 + 可当恢复指针**的那一份
 *   （行号即序号、大正文走 blob 不截断、坏行可修复）。
 *
 * ⚠️ 两份的**载荷形状故意不同**（不是同一份数据的两次拷贝）：
 *  - 按天日志给**面板**看：够用就行，长正文截断（tool_result 只写 800 字符的 preview）；
 *  - 线程日志给**模型**找回细节：`context/recovery-footer.ts` 的恢复指针明确告诉模型
 *    「完整内容在磁盘上的日志里」—— 那一份必须完整，否则那句承诺是空话
 *    （journal 的 blob 机制认的是 `JOURNAL_BLOB_AFTER_CHARS`，喂给它的载荷被提前截断就永远触发不了）。
 *  所以需要两种载荷时用 `split` 一次写两处（各一条记录），不要为了「省一次调用」把截断过的那份
 *  写进 journal，也不要用两次 append 写同一件事 —— 那会在 journal 里留下两条同名记录
 *  （一条截断一条完整），按恢复指针去 grep 的人分不清哪条才是正文。
 *
 * 纪律：
 *  - 这里**不做**包装魔法，就是两次显式 append，调用点一眼能看出写了两处；
 *  - 线程日志写失败**绝不能**影响对话（它是第二份，不是权威）；事件日志失败仍然抛出
 *    （那是既有行为，调用方与 fsync 屏障都依赖它）。
 */
import type { EventLog, EventType } from "../session/event-log.ts";
import type { Journal } from "../session/journal.ts";

type Ctx = { run?: string; turn?: number; step?: number };

export interface RunLog {
  /** 两份日志都写，载荷**同一份**（面板看的形状） */
  append(type: string, data?: Record<string, unknown>, ctx?: Ctx): void;
  /**
   * 两份日志**各写一份形状不同的载荷**（按天日志用 daily、journal 用 journal），各一条记录 ——
   * 需要「面板够用 / 模型必须完整」两种形状时用这个，别用两次 append（那会在 journal 里留下两条
   * 同名记录：一条截断的一条完整的，按恢复指针去 grep 的人分不清哪条是正文）。
   */
  split(type: string, daily: Record<string, unknown>, journal: Record<string, unknown>, ctx?: Ctx): void;
  /** 线程日志写失败的累计次数（0 = 一切正常；只涨不清，供面板/诊断以后暴露） */
  readonly journalFailures: number;
}

export function makeRunLog(opts: { eventLog: EventLog; journal?: Journal | null }): RunLog {
  let failures = 0;
  const writeJournal = (type: string, data: Record<string, unknown>, ctx: Ctx): void => {
    try {
      opts.journal?.append(type, data, ctx);
    } catch (e) {
      failures++;
      // 出口：**只**在第一次失败时往按天日志记一条（用的是 eventLog，不是本门面，免得自己递归）。
      // 为什么不重试、不抛出：线程日志是第二份，主流程不能因它挂掉（选的就是这一边）；
      // 但也不能一声不吭 —— 「恢复指针指着一份没写进去的日志」正是要消灭的静默失败。
      if (failures === 1) {
        try {
          opts.eventLog.append("journal_failed", { type, error: e instanceof Error ? e.message : String(e), failures });
        } catch { /* 按天日志也写不进去：这次确实无处可说（连主出口都坏了） */ }
      }
    }
  };
  return {
    append(type, data = {}, ctx = {}) {
      opts.eventLog.append(type as EventType, data, ctx);
      writeJournal(type, data, ctx);
    },
    split(type, daily, journal, ctx = {}) {
      opts.eventLog.append(type as EventType, daily, ctx);
      writeJournal(type, journal, ctx);
    },
    get journalFailures() { return failures; },
  };
}
