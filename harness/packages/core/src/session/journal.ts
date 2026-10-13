/**
 * 每线程事件日志（journal）——「可重放 + 可恢复指针」的权威副本
 *
 * 为什么要有第二份日志（而不是改造旧的那份）：
 * ① 旧日志 `<configDir>/logs/YYYY-MM-DD.jsonl`（session/event-log.ts）是**全局按天**一份，
 *    没有「这个线程的历史在哪、从第几行到第几行」这种可恢复指针；
 * ② 它的每个字段超过 2000 字符就被切掉，而工具输出预算是 6000 字符 ——
 *    「模型可见 ⟺ 已记录」这句话在旧日志上根本不成立：模型看过的正文，日志里查不到。
 *
 * 本文件是**追加式**的第二份：`<configDir>/logs/threads/<threadId>/<YYYY-MM-DD>.jsonl`
 *   ① 行号就是序号（`seq` == 该文件的行号，1-based；第 1 行固定是 metadata）；
 *   ② 正文**不截断**：超过 JOURNAL_BLOB_AFTER_CHARS 的字符串落到 `<configDir>/logs/blobs/<sha1>.txt`，
 *      行里换成自描述指针 `{ blob, chars, sha1 }`（内容寻址 → 同一段正文永远同一份文件）；
 *   ③ 坏文件**读时修复**：截断到最后一个完整行，并写一份**只写一次、永不覆盖**的 `.bak`；
 *   ④ 撤销 / 分支**只追加记录**（例如 `context.undo`），从不改写、从不删除任何已有行。
 *
 * 与旧日志的关系（面板契约不变）：面板的日志页读的还是旧的那份（`/api/logs`），本文件**不改那个契约**。
 * 新日志是「可重放 + 可恢复指针」的权威副本，旧文件暂时留着给面板；等面板切过来之后旧文件才可以退场。
 * 双写由**一处**门面完成（`agent/run-log.ts` 的 RunLog：同一次 append 显式写两份，需要两种载荷形状时
 * 拆成 append + journal 两次调用）。为什么不做成「谁都能随手写两处」：两条记录的形状本来就不同
 * （旧的按天全局、带 project、字段截断；新的按线程、带 seq 行号、正文完整），没有那个门面，
 * 「哪一份是权威」就会被藏进每个调用点的复制粘贴里。
 *
 * 为什么行号是权威、`seq` 字段只是复述：多写入点（`openJournal` 返回的句柄是**每线程每天一份**的
 * 缓存实例，见文件尾的实例表；撤销路径与 runtime 拿到的就是同一个）各自缓存过计数，
 * 行号由文件本身决定，永远没有歧义。
 */
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
// 压缩窗口的标记类型 / 区间计算（纯逻辑与语义说明在 journal-window.ts，那边放得下长注释）
import { JOURNAL_WINDOW_TYPE, windowMarkLine, windowRange } from "./journal-window.ts";
import type { RecoveryPointer, WindowPointer } from "./journal-window.ts";
// 大正文落盘（不截断）：超长字符串 → 内容寻址 blob，实现与阈值在 journal-blob.ts
import { shrinkForBlob } from "./journal-blob.ts";

// 公开面不变：标记类型与两个指针类型改在 journal-window.ts 定义（见那边的语义说明），从这里照旧导出
export { JOURNAL_WINDOW_TYPE } from "./journal-window.ts";
export type { RecoveryPointer, WindowPointer } from "./journal-window.ts";

/** 协议版本：写在第一行 metadata 里，将来迁移按它惰性做 */
export const JOURNAL_PROTOCOL_VERSION = 1;

// 大正文落盘（阈值 / 指针类型 / 递归清洗）在 session/journal-blob.ts；公开面不变，从这里转出
export { JOURNAL_BLOB_AFTER_CHARS } from "./journal-blob.ts";
export type { BlobRef } from "./journal-blob.ts";

/** 落盘屏障（与 event-log.ts 同口径）：这三类记录写完就刷盘，崩溃时它们必须在 */
const DEFAULT_FSYNC_ON: readonly string[] = ["turn_end", "run_end", "tool_result"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface JournalRecord {
  v: 1;
  /** == 本行行号（1-based） */
  seq: number;
  ts: string;
  type: string;
  data?: Record<string, unknown>;
  thread?: string;
  run?: string;
  turn?: number;
  step?: number;
}

export interface JournalCtx { run?: string; turn?: number; step?: number }

/** 一次坏文件修复的收据（`bakWritten === false` = 已经有更早的 `.bak`，这次没覆盖它） */
export interface JournalRepair {
  bakPath: string;
  bakWritten: boolean;
  droppedLines: number;
  droppedBytes: number;
  at: string;
}

export interface JournalOptions {
  configDir: string;
  threadId: string;
  /** 覆盖日期（测试用）；缺省 = 今天（UTC，与 event-log.ts 的按天口径一致） */
  date?: string;
  fsyncOn?: Iterable<string>;
}

const nowIso = (): string => new Date().toISOString();
const today = (): string => nowIso().slice(0, 10);

/** 文件大小（读不到当 0：文件不存在 / 权限问题时不该把打开流程带崩） */
function sizeOf(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

/**
 * 物理行（去掉结尾换行带来的那个空元素，以及尾部的空行）。
 * ⚠️ 不做全局 `.filter(Boolean)`：中间的空行是**行号错位**的现场，必须让扫描抓到它，
 *    否则「行号 == seq」这条契约就在静默中被破坏。
 */
function physicalLines(text: string): string[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

/** 一行 → 记录；解析失败返回 null（这就是「坏行」的判据） */
function parseLine(line: string): JournalRecord | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const v: unknown = JSON.parse(t);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return v as JournalRecord;
  } catch { return null; }
}

/**
 * 线程 id → 目录名：白名单洗字符（`..`、`/` 都不许进路径）+ 洗过就补哈希
 * （两个不同 id 洗成同一个目录 = 两段历史串台，比多几个字符糟得多）。
 */
export function threadLogDir(configDir: string, threadId: string): string {
  const base = threadId
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._]+|_+$/g, "")
    .slice(0, 80);
  const safe = base.length > 0 ? base : "thread";
  const name = safe === threadId ? safe : `${safe}-${createHash("sha1").update(threadId).digest("hex").slice(0, 8)}`;
  return join(configDir, "logs", "threads", name);
}

/** 某线程某天的日志文件路径（date 非法就退回今天，绝不把它拼进路径） */
export function journalFile(configDir: string, threadId: string, date?: string): string {
  return join(threadLogDir(configDir, threadId), (date && DATE_RE.test(date) ? date : today()) + ".jsonl");
}

/**
 * 句柄实例表：**每（configDir + 线程 + 日期）一份**，`openJournal` 返回同一个实例。
 *
 * 为什么必须缓存：构造函数要 readFileSync 整个文件 + 逐行数行号，而调用点一轮至少两次
 * （runtime 的门面 + 压缩时的 markWindowStart），撤销路径还会再要一次 —— 每要一次就整读一遍日志文件，
 * 说好的「日志是线程长驻的追加文件」就变成了「每轮把全量日志读两遍」。
 * 多写入点仍然安全：`#sync()` 每次 append 前按文件大小重数行号，别处（别的进程 / 别的实例）
 * 插了行或截断过都能自愈 —— 缓存省掉的只是「同一进程里重复读同一份文件」。
 */
const JOURNAL_CACHE = new Map<string, Journal>();
/** 上限：一天一个线程一条，长驻进程跑久了不该无限攒；超了丢最老的（丢了只是下次重新读一遍文件） */
const JOURNAL_CACHE_MAX = 64;

/** 打开（必要时创建）某线程当天的日志；**同一进程内同参数返回同一个句柄**（见 JOURNAL_CACHE）
 *  ⚠️ 句柄一旦 `close()` 就废了（缓存不会因此换新的，再要还是它）—— 生产路径没人调 close（靠 fsync 落盘），
 *  测试里要一个全新句柄用 openJournalFresh。 */
export function openJournal(configDir: string, threadId: string, date?: string): Journal {
  const key = `${configDir}\u0000${threadId}\u0000${date ?? ""}`;
  const hit = JOURNAL_CACHE.get(key);
  if (hit) return hit;
  const j = new Journal({ configDir, threadId, date });
  if (JOURNAL_CACHE.size >= JOURNAL_CACHE_MAX) {
    const oldest = JOURNAL_CACHE.keys().next().value;
    if (oldest !== undefined) JOURNAL_CACHE.delete(oldest);
  }
  JOURNAL_CACHE.set(key, j);
  return j;
}

/** 绕开实例表开一个**独立**句柄（测试坏文件修复、模拟「同时存在的第二个写入点」用；生产路径不要用） */
export function openJournalFresh(configDir: string, threadId: string, date?: string): Journal {
  return new Journal({ configDir, threadId, date });
}

export class Journal {
  #configDir: string;
  #thread: string;
  #file: string;
  #blobDir: string;
  #fsyncOn: Set<string>;
  #seq = 0;
  /** 我们写到的字节数：另一个实例插了行/截断过，stat 的 size 就对不上（多写入点防撞） */
  #bytes = 0;
  #repair: JournalRepair | null = null;
  #closed = false;

  constructor(opts: JournalOptions) {
    this.#configDir = opts.configDir;
    this.#thread = opts.threadId;
    this.#file = journalFile(opts.configDir, opts.threadId, opts.date);
    this.#blobDir = join(opts.configDir, "logs", "blobs");
    this.#fsyncOn = new Set(opts.fsyncOn ?? DEFAULT_FSYNC_ON);
    mkdirSync(dirname(this.#file), { recursive: true });
    this.#open();
  }

  get path(): string { return this.#file; }
  /** 当前最后一行行号（= 该文件的物理行数；下次 append 写到 seq + 1） */
  get seq(): number { return this.#seq; }
  get blobDir(): string { return this.#blobDir; }
  get lastRepair(): JournalRepair | null { return this.#repair; }

  // ── 打开 / 修复 ──────────────────────────────────────

  #open(): void {
    if (!existsSync(this.#file)) { this.#writeMetadata(); return; }
    let text = "";
    try { text = readFileSync(this.#file, "utf8"); } catch { return; }
    const lines = physicalLines(text);
    if (lines.length === 0) { this.#writeMetadata(); return; }
    // 找**第一**个坏行（不是最后一个）：行号就是序号，中间断一行，后面所有行的 seq 全都对不上号。
    // 常撞见的形态当然还是「最后一行写了一半」——那时两者是同一行。
    let good = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (parseLine(lines[i]!) === null) { good = i; break; }
    }
    this.#seq = good;
    this.#bytes = sizeOf(this.#file);
    if (good < lines.length) this.#repairOnRead(lines, good, text);
  }

  /** 第 1 行：metadata（protocol_version 是将来惰性迁移的唯一依据） */
  #writeMetadata(): void {
    const rec = {
      v: 1, seq: 1, ts: nowIso(), type: "metadata",
      protocol_version: JOURNAL_PROTOCOL_VERSION, created_at: nowIso(), thread: this.#thread,
    };
    const line = JSON.stringify(rec) + "\n";
    writeFileSync(this.#file, line);
    this.#seq = 1;
    this.#bytes = Buffer.byteLength(line, "utf8");
  }

  /**
   * 坏行修复：把文件截断到**第一个坏行之前**（最常见的形态就是最后一行写了一半），
   * 并把**损坏现场的原始全文**留一份 `.bak`。
   *
   * ⚠️ `.bak` 只写一次、永不覆盖：它保存的是「第一次损坏时」的证据，覆盖它等于把第一次的现场也销毁。
   *    第二次损坏时改把坏行原文放进 `journal.repair` 记录的 `damaged` 字段（超长会走 blob）——
   *    证据换了个地方，但没有丢；`lastRepair.bakWritten === false` 就是「这次没写成 bak」的信号。
   */
  #repairOnRead(lines: string[], good: number, text: string): void {
    const bak = this.#file + ".bak";
    let bakWritten = false;
    if (!existsSync(bak)) {
      try { writeFileSync(bak, text); bakWritten = true; } catch { bakWritten = false; }
    }
    const kept = lines.slice(0, good);
    const keptText = kept.length > 0 ? kept.join("\n") + "\n" : "";
    try { writeFileSync(this.#file, keptText); } catch { /* 写不回去也按已修好的视图继续读 */ }
    this.#seq = kept.length;
    this.#bytes = sizeOf(this.#file);
    const dropped = lines.slice(good).join("\n");
    this.#repair = {
      bakPath: bak, bakWritten,
      droppedLines: lines.length - kept.length,
      droppedBytes: Math.max(0, Buffer.byteLength(text, "utf8") - Buffer.byteLength(keptText, "utf8")),
      at: nowIso(),
    };
    const receipt = this.#repair;
    try {
      this.append("journal.repair", {
        bak, bak_written: bakWritten,
        dropped_lines: receipt.droppedLines, dropped_bytes: receipt.droppedBytes,
        ...(bakWritten ? {} : { damaged: dropped }),
      });
    } catch { /* 追加失败不该让读取挂掉 */ }
  }

  // ── 写 ───────────────────────────────────────────────

  /** 追加一行（`seq` = 追加后的行号）。返回落盘的那条记录。 */
  append(type: string, data: Record<string, unknown> = {}, ctx: JournalCtx = {}): JournalRecord {
    if (this.#closed) throw new Error("Journal closed");
    this.#sync();
    const rec: JournalRecord = {
      v: 1, seq: ++this.#seq, ts: nowIso(), type,
      data: this.#shrink(data) as Record<string, unknown>, thread: this.#thread,
    };
    if (ctx.run !== undefined) rec.run = ctx.run;
    if (ctx.turn !== undefined) rec.turn = ctx.turn;
    if (ctx.step !== undefined) rec.step = ctx.step;
    const line = JSON.stringify(rec) + "\n";
    appendFileSync(this.#file, line);
    this.#bytes += Buffer.byteLength(line, "utf8");
    if (this.#fsyncOn.has(type)) this.fsync();
    return rec;
  }

  /** 另一个实例写过（或截断过）这个文件 → 重数行号，绝不写出重复 seq */
  #sync(): void {
    if (!existsSync(this.#file)) { this.#writeMetadata(); return; }
    const size = sizeOf(this.#file);
    if (size === this.#bytes) return;
    let n = this.#seq;
    try { n = physicalLines(readFileSync(this.#file, "utf8")).length; } catch { /* 读不到就照旧 */ }
    this.#seq = n;
    this.#bytes = size;
  }

  /** 屏障：把已写内容刷到磁盘（失败只影响持久性强度，不影响正确性） */
  fsync(): void {
    try { const fd = openSync(this.#file, "a"); fsyncSync(fd); closeSync(fd); } catch { /* ignore */ }
  }

  close(): void { if (this.#closed) return; this.fsync(); this.#closed = true; }

  // ── 大正文落盘（不截断；实现在 session/journal-blob.ts，本文件由它守住 400 行） ──

  /** 行数据的清洗入口：超长字符串在这里换成 blob 指针（否则原样） */
  #shrink(data: Record<string, unknown>): Record<string, unknown> {
    return shrinkForBlob(data, { blobDir: this.#blobDir, configDir: this.#configDir }) as Record<string, unknown>;
  }

  // ── 读 ───────────────────────────────────────────────

  /** 按**行号**（= seq）读一段，两端都含；坏行跳过。start 从 1 起。 */
  readLines(start: number, end = Number.MAX_SAFE_INTEGER): JournalRecord[] {
    if (!existsSync(this.#file)) return [];
    let lines: string[] = [];
    try { lines = physicalLines(readFileSync(this.#file, "utf8")); } catch { return []; }
    const from = Math.max(1, Math.floor(start));
    const to = Math.min(lines.length, Math.floor(end));
    const out: JournalRecord[] = [];
    for (let i = from - 1; i < to; i++) {
      const r = parseLine(lines[i]!);
      if (r) out.push(r);
    }
    return out;
  }

  readAll(): JournalRecord[] { return this.readLines(1); }

  /** 最近 N 条（与 event-log.ts 的 readRecent 同形，便于替换） */
  readRecent(limit = 200): JournalRecord[] {
    const all = this.readAll();
    return all.slice(-Math.max(1, Math.floor(limit)));
  }

  /**
   * 「本线程日志路径 + 最近 N 行的行号区间」（context/recovery-footer.ts 的 RecoveryInfo 就是这三样）。
   * ⚠️ 这是**估计**（approximate=true）：不管压没压过，它给的都是「最近 N 行」。
   *    压缩后的恢复指针走 lastWindow() —— 它按窗口标记给出真正被摘要的那一段
   *    （assemble-adapter 的 makeCompactor 就这么接的）。
   *
   * ⚠️ 第 1 行是 metadata，不是对话内容：区间从不从第 1 行起。
   *    指针把模型引到一行元数据上，等于让它白跑一趟 —— 这正是「半截指针比没有更坏」。
   * ⚠️ 不返回 spillDir：这个方法给的是**日志**的指针，而 RecoveryInfo.spillDir 的语义是
   *    「工具结果外置目录（<workdir>/.spill，文件名 = 工具调用 id）」。日志里的 blob 是 sha1 命名的，
   *    挂到 spillDir 上会让模型拿着工具调用 id 去 blob 目录里找一个不存在的文件。
   */
  recoveryInfo(n = 200): RecoveryPointer {
    this.#sync();   // 别的实例可能刚追加过：区间多算一行只是旧一点，算少了才是假话
    const end = this.#seq;
    if (end < 2) return { logPath: this.#file };
    return {
      logPath: this.#file,
      startLine: Math.max(2, end - Math.max(1, Math.floor(n)) + 1),
      endLine: end,
      approximate: true,   // 「最近 n 行」永远只是估计：想精确得先 markWindowStart（见 lastWindow）
    };
  }

  // ── 压缩窗口 ─────────────────────────────────────────

  /**
   * 记一条「从这里开始是新窗口」的标记 —— **压缩时由 runtime 调用**，恰在压缩真的改小了
   * 消息序列那一刻（见 agent/runtime.ts 的 compaction 分支）。压缩没生效就别调：
   * 标记一落，「标记之前 = 被摘要的」这句话就生效，把没被摘要的内容说成被摘要的正是假精确。
   *
   * 为什么标记自己也要占一行：本文件的根基是「行号 == seq」；不走 append 就没有行号，
   * 恢复指针的端点只能落在别的记录上 —— 差一行就是「指针指向没被摘要的区间」。
   * ⚠️ 不 fsync：跟相邻的 compaction 记录一样，丢了只让指针退化成近似，不会让结论变错。
   */
  markWindowStart(reason: string): JournalRecord {
    return this.append(JOURNAL_WINDOW_TYPE, { reason });
  }

  /**
   * 被摘要那一段的行号区间；没有窗口标记就退回「最近 n 行」并标 approximate=true。
   *
   * 有标记时给的是标记**之前**的区间（标记之后的行是压缩后新写的，一条都没进摘要）——
   * 这就是它相对 `recoveryInfo(n)` 的区别：后者永远只给「最近 n 行」，压在压缩这个时刻上
   * 几乎整段落在没被摘要的地方。区间取法的取舍见 journal-window.ts 的 windowRange。
   */
  lastWindow(n = 200): WindowPointer {
    this.#sync();
    return { logPath: this.#file, ...windowRange(this.#seq, this.#windowMarkLine(), n) };
  }

  /** 最近一条窗口标记的行号（== seq）；没有 / 读不到返回 null（纯逻辑在 journal-window.ts） */
  #windowMarkLine(): number | null {
    try { return windowMarkLine(physicalLines(readFileSync(this.#file, "utf8"))); } catch { return null; }
  }
}
