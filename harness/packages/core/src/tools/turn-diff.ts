/**
 * 回合净 diff（turn net diff）——「这轮改了什么」与「回退这一轮」共用的地基。
 *
 * 形状照抄 OpenAI Codex 的 turn_diff_tracker：**只认工具自报的写操作，绝不回读文件系统**。
 * 回读有两个坑：① 用户在中途手动改的文件会被算成「模型改的」；
 * ② 要算「和什么比」就得先有基线，等于每轮开头扫一遍工作区（慢，还会把 .gitignore 掉的东西算进来）。
 *
 * ⚠️ 已知边界：**只有 Write/Edit 会调 recordFileMutation**。
 * Bash 里的 `> f`、`sed -i`、`git checkout`、RunScript 里脚本改的文件都看不见 ——
 * 工具是自报的，没有自报就没有记录。不假装全覆盖。
 *
 * 净：同一文件一轮内写多次，只留**第一次 before + 最后一次 after**。
 * 中间态对「这轮改了什么」没有意义，合并之后还能省掉一份巨大的拼接 diff。
 *
 * 状态只有一张 Map<threadId, Map<path, Pending>>：线程之间天然隔离，
 * 一个线程取数绝不会看到另一个线程的记录。
 */
import { TURN_DIFF_MAX_FILES, TURN_DIFF_TIMEOUT_MS } from "../constants.ts";

/** 记一次文件写。before/after 都是**内容**（不是路径）；null = 那个时刻文件不存在 */
export interface FileMutation { path: string; before: string | null; after: string | null }

/** 净 diff 里一个文件的汇总（正文在 TurnDiff.diffText 里） */
export interface FileDiff { path: string; added: number; removed: number; created: boolean; deleted: boolean }

export interface TurnDiff {
  files: FileDiff[];
  /** true = 结果不完整：文件条目被 TURN_DIFF_MAX_FILES 截断，或正文被字符上限截断 */
  truncated: boolean;
  /** 近似统一 diff 文本（给人/模型看；回退功能应该用 files + 存下来的正文，别解析这个） */
  diffText: string;
}

/** 单文件正文超过这个字节数就不做行级对比，只给粗计数（避免把大文件逐行拆进内存） */
export const TURN_DIFF_MAX_BYTES = 200 * 1024;

/** diffText 的字符上限：一轮改 200 个文件、每个都整段重写时正文能到几十 MB，这里兜住 */
export const TURN_DIFF_MAX_TEXT_CHARS = 50_000;

/**
 * 软预算折算。TURN_DIFF_TIMEOUT_MS 的本意是「算这轮 diff 最多花多久」，
 * 但**真计时器不可测**：同一份输入在慢机器 / 高负载下会得到不同结果，测试也没法稳定复现。
 * 所以换成一个**可数的量** —— 本轮最多允许扫过多少字符（毫秒 × 这个折算率），
 * 扫超了就停止逐个算行、剩下的文件只给粗计数。
 * 取舍：返回值不会随机器负载抖动，代价是它不是真的时间（折算率是量级估计，不是实测校准）。
 */
const CHARS_PER_MS = 1000;
export const TURN_DIFF_WORK_BUDGET_CHARS = TURN_DIFF_TIMEOUT_MS * CHARS_PER_MS;

/**
 * diffText 的固定开头。为什么不省掉：这份文本是**近似**（下面那套裁剪），
 * 不写清楚就会被当成能直接 apply 的补丁；顺带说明覆盖面，免得读者以为 Bash 改的也在里面。
 */
const DIFF_HEADER = "# 回合净 diff · 近似（Write/Edit 自报，前后缀已裁剪）";

interface Pending { path: string; before: string | null; after: string | null }

const turns = new Map<string, Map<string, Pending>>();

/**
 * 记一次文件写（工具内调用）。
 * 同一个 path 第二次进来只覆盖 after，**before 保持第一次的那个** —— 这就是「净」。
 *
 * 顺序 = 调用顺序（并发批次里就是完成顺序）。这只会影响 diffText 里文件的排列，
 * 不影响合并正确性：**同一个 path 的两次写不可能并发**（两个写工具都声明了该路径的 write 占用，
 * 调度器会串行），所以 before/after 一定对应真实的先后。
 */
export function recordFileMutation(threadId: string, m: FileMutation): void {
  if (!threadId || !m.path) return;
  let bucket = turns.get(threadId);
  if (!bucket) { bucket = new Map(); turns.set(threadId, bucket); }
  const prev = bucket.get(m.path);
  if (prev) { prev.after = m.after; return; }
  bucket.set(m.path, { path: m.path, before: m.before, after: m.after });
}

/**
 * 回合开始：清掉这个线程的累计（父代理应在轮边界调用）。
 * 为什么每次都要显式调：漏调一次不会报错，只会把上一轮的改动重复算进这一轮 —— 静默的错。
 */
export function beginTurnDiff(threadId: string): void {
  turns.set(threadId, new Map());
}

/**
 * 彻底丢弃这个线程的记录（测试 / 线程结束 / 异常路径）。
 * 与 beginTurnDiff 对调用方可见的效果一样（都清空），区别只是这里把 Map 整条删掉、释放内存。
 */
export function resetTurnDiff(threadId: string): void {
  turns.delete(threadId);
}

/**
 * 取本轮净 diff 并**清空**。
 * 先删再算：算的过程中万一抛了，也绝不能把这份记录留到下一轮去重复上报。
 */
export function takeTurnDiff(threadId: string): TurnDiff {
  const bucket = turns.get(threadId);
  turns.delete(threadId);
  if (!bucket || bucket.size === 0) return { files: [], truncated: false, diffText: "" };
  return computeTurnDiff([...bucket.values()]);
}

// ── 计算 ─────────────────────────────────────────────

/**
 * 拆行。末尾换行不算「多一个空行」：否则 "a\n" 与 "a" 会被判成改了一行，
 * 而它们对读者是同一件事（这份东西是给人看的近似，不是给 patch 工具吃的）。
 */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 粗计数（不拆数组）：口径与 splitLines 一致 —— 空串 0 行，末尾换行不额外算一行 */
function coarseLines(s: string | null): number {
  if (s === null || s === "") return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.endsWith("\n") ? n : n + 1;
}

interface Trimmed { pre: number; removed: string[]; added: string[] }

/**
 * 公共前后缀裁剪后取中间段。
 *
 * ⚠️ 这是**近似，不是最小编辑距离**：中间段整段算改动，不做 LCS。
 * 为什么不做：完整 LCS 既慢又长（要维护 DP 表），而这里要回答的问题只是
 * 「这轮大致改了多少、改了哪几行」—— 裁剪之后中间段通常只剩几行，够了。
 * 代价：中间段里没变的行会被同时算成一条 - 和一条 +，计数偏大。别拿它当精确的行数统计。
 */
function trimCommon(before: string[], after: string[]): Trimmed {
  const min = Math.min(before.length, after.length);
  let pre = 0;
  while (pre < min && before[pre] === after[pre]) pre++;
  // 后缀要留出已被前缀吃掉的部分，否则中间段会重叠、两边都数重
  let suf = 0;
  while (suf < min - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;
  return {
    pre,
    removed: before.slice(pre, before.length - suf),
    added: after.slice(pre, after.length - suf),
  };
}

interface Built { diff: FileDiff; chunk: string }

function buildLineDiff(p: Pending): Built {
  const before = p.before === null ? [] : splitLines(p.before);
  const after = p.after === null ? [] : splitLines(p.after);
  const t = trimCommon(before, after);
  const diff: FileDiff = {
    path: p.path,
    added: t.added.length,
    removed: t.removed.length,
    created: p.before === null,
    deleted: p.after === null,
  };
  // 净零（写了又改回去 / 同内容重写）：条目保留（能解释「这个文件被碰过」），但不占正文
  if (t.added.length === 0 && t.removed.length === 0) return { diff, chunk: "" };
  const head = [
    p.before === null ? "--- /dev/null" : "--- a/" + p.path,
    p.after === null ? "+++ /dev/null" : "+++ b/" + p.path,
    `@@ -${t.pre + 1},${t.removed.length} +${t.pre + 1},${t.added.length} @@`,
  ];
  const body = [...t.removed.map((l) => "-" + l), ...t.added.map((l) => "+" + l)];
  return { diff, chunk: head.concat(body).join("\n") };
}

/** 粗计数：只数行，不拆数组、不逐行对比（大文件 / 预算用尽 / 正文封顶时走这里） */
function buildCoarseDiff(p: Pending, why: string): Built {
  const removed = coarseLines(p.before);
  const added = coarseLines(p.after);
  const diff: FileDiff = {
    path: p.path, added, removed, created: p.before === null, deleted: p.after === null,
  };
  if (p.before === p.after) return { diff, chunk: "" };
  const head = [
    p.before === null ? "--- /dev/null" : "--- a/" + p.path,
    p.after === null ? "+++ /dev/null" : "+++ b/" + p.path,
    `(粗计数：${why}；-${removed} +${added} 行)`,
  ];
  return { diff, chunk: head.join("\n") };
}

function computeTurnDiff(pendings: Pending[]): TurnDiff {
  const countTruncated = pendings.length > TURN_DIFF_MAX_FILES;
  const kept = countTruncated ? pendings.slice(0, TURN_DIFF_MAX_FILES) : pendings;
  const files: FileDiff[] = [];
  const chunks: string[] = [];
  const tail: string[] = [];
  let chars = 0;
  let spent = 0;
  let budgetOut = false;
  let textCapped = false;
  let coarseUsed = false;

  for (const p of kept) {
    const beforeChars = p.before?.length ?? 0;
    const afterChars = p.after?.length ?? 0;
    const oversize = beforeChars > TURN_DIFF_MAX_BYTES || afterChars > TURN_DIFF_MAX_BYTES;
    const coarse = oversize || budgetOut || textCapped;
    const why = oversize ? "单文件超过 200KB，未做行级对比"
      : budgetOut ? "本轮 diff 软预算已用尽，未做行级对比"
      : "diff 正文字数已达上限，未做行级对比";
    const built = coarse ? buildCoarseDiff(p, why) : buildLineDiff(p);
    if (coarse) coarseUsed = true;
    files.push(built.diff);

    // 预算按「扫过的字符」累加；用掉额度的这一个文件仍然给完整行级结果（下一个才开始降级），
    // 这样「预算用尽」不会让越界的那个文件半途变成粗计数
    spent += beforeChars + afterChars;
    if (spent > TURN_DIFF_WORK_BUDGET_CHARS) budgetOut = true;

    if (!built.chunk || textCapped) continue;
    if (chars + built.chunk.length > TURN_DIFF_MAX_TEXT_CHARS) { textCapped = true; continue; }
    chunks.push(built.chunk);
    chars += built.chunk.length + 1;
  }

  if (countTruncated) tail.push(`# ⚠️ 本轮改动文件数 ${pendings.length} 超过上限 ${TURN_DIFF_MAX_FILES}：只列了前 ${kept.length} 个`);
  if (textCapped) tail.push(`# ⚠️ diff 正文超过 ${TURN_DIFF_MAX_TEXT_CHARS} 字符：后面的文件只保留计数，没列正文`);
  if (coarseUsed) tail.push("# ⚠️ 带「粗计数」的文件没有逐行对比，-/+ 是两侧总行数");

  const truncated = countTruncated || textCapped;
  if (chunks.length === 0) return { files, truncated, diffText: "" };
  return { files, truncated, diffText: [DIFF_HEADER, ...chunks, ...tail].join("\n") };
}
