/**
 * 输出预算（T3.5 / T3.6）
 * 行内截断 → 三档 + 总预算 6000 字符 + 迭代收缩 + 超长落盘（头尾预览）。
 *
 * ⚠️ 截断标记文案是本模块最重要的产出：它必须明说三件事，
 * 否则模型会对「我读完了」产生虚假认知（Alma 答疑 P2-12 第 2 条，被事故打出来的）。
 *
 * ⚠️ 顺序纪律：**先修超长行，再收缩总预算**。反过来做没有任何补救余地 ——
 * 按总字符砍掉的是尾部，而尾部在 grep/find 这类输出里是「另一批不同的事实」，
 * 不是「某一行的后半截」；先折长行，同样的预算才能覆盖到更多**不同**的行。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "./types.ts";
import {
  OUTPUT_TOTAL_BUDGET, OUTPUT_SHRINK_FACTOR, OUTPUT_SHRINK_FLOOR,
  OUTPUT_FIELD_LIMITS, OUTPUT_DEFAULT_STRING_LIMIT,
  OUTPUT_LINE_MAX_CHARS, OUTPUT_PREVIEW_HEAD_CHARS, OUTPUT_PREVIEW_TAIL_CHARS,
} from "../constants.ts";

export interface BudgetResult { result: unknown; spillPath?: string; truncated: boolean; originalSize: number }

/** 需要原样返回的键（id / path 之类，截断了就没用了） */
const NEVER_TRUNCATE = new Set(["id", "path", "file_path", "spillPath", "url", "ok", "success", "error", "toolCallId"]);

function limitFor(key: string): number {
  return OUTPUT_FIELD_LIMITS[key] ?? OUTPUT_DEFAULT_STRING_LIMIT;
}

function truncateString(s: string, limit: number, key: string): { value: string; cut: number } {
  if (s.length <= limit) return { value: s, cut: 0 };
  return { value: s.slice(0, limit), cut: s.length - limit };
}

/** 按字段限额裁一遍，返回裁掉的总字符数 */
function shrinkOnce(value: unknown, factor: number, key = ""): { value: unknown; cut: number } {
  if (typeof value === "string") {
    const limit = Math.max(80, Math.floor(limitFor(key) * factor));
    const r = truncateString(value, limit, key);
    return { value: r.value, cut: r.cut };
  }
  if (Array.isArray(value)) {
    let cut = 0;
    const out = value.slice(0, Math.max(5, Math.floor(value.length * factor))).map((v) => {
      const r = shrinkOnce(v, factor, key);
      cut += r.cut;
      return r.value;
    });
    if (value.length > out.length) cut += JSON.stringify(value.slice(out.length)).length;
    return { value: out, cut };
  }
  if (value && typeof value === "object") {
    let cut = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (NEVER_TRUNCATE.has(k)) { out[k] = v; continue; }
      const r = shrinkOnce(v, factor, k);
      cut += r.cut;
      out[k] = r.value;
    }
    return { value: out, cut };
  }
  return { value, cut: 0 };
}

// ── ① 行内截断（必须先于总预算收缩） ────────────────────

/** 超长行的标记。必须自报「这里少了多少字符」—— 只写个省略号，模型会以为那行本来就长这样。 */
const lineMarker = (cut: number) => `…[+${cut} 字符]`;

/**
 * 单行整形：超长行只留头部 + 标记，**行数绝对不变**。
 * 为什么死守行数：grep -n / find 的输出里「一行 = 一条独立事实」，
 * 折行（wrap）会让行号与内容错位，模型对不上号；连行数都变了，就更没法引用。
 */
function shapeLine(line: string): { value: string; cut: number } {
  if (line.length <= OUTPUT_LINE_MAX_CHARS) return { value: line, cut: 0 };
  // 标记自己也占字符，必须先从行上限里让出来；只有标记位数进位时才会再变一轮，迭代三次足够收敛
  let keep = OUTPUT_LINE_MAX_CHARS;
  for (let i = 0; i < 3; i++) {
    const next = OUTPUT_LINE_MAX_CHARS - lineMarker(line.length - keep).length;
    if (next === keep) break;
    keep = next;
  }
  const cut = line.length - keep;
  return { value: line.slice(0, keep) + lineMarker(cut), cut };
}

/**
 * 把结果里所有超长行整形一遍：结构、键、顺序、**行数**都不动，只折短超限的行。
 *
 * 为什么这一步必须在总预算收缩**之前**：grep/find 这类输出「行多、每行信息密度高」，
 * 直接按总字符砍会把模型真正需要的**尾部整段**丢掉（一整批不同的事实）；
 * 先修长行，同样的预算就能覆盖到更多**不同**的行。顺序反了这一步就没有意义 ——
 * 那时尾部早就没了，再从尾部找补是没有的。
 */
export function shapeLongLines(value: unknown, key = ""): { value: unknown; cut: number } {
  if (typeof value === "string") {
    // 整串都没超过单行上限 → 不可能存在超长行，省掉一次 split/join
    if (value.length <= OUTPUT_LINE_MAX_CHARS) return { value, cut: 0 };
    let cut = 0;
    const lines = value.split("\n").map((l) => {
      const r = shapeLine(l);
      cut += r.cut;
      return r.value;
    });
    return { value: lines.join("\n"), cut };
  }
  if (Array.isArray(value)) {
    let cut = 0;
    const out = value.map((v) => {
      const r = shapeLongLines(v, key);
      cut += r.cut;
      return r.value;
    });
    return { value: out, cut };
  }
  if (value && typeof value === "object") {
    let cut = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // 与 shrinkOnce 同一条纪律：这些键截了就废了（路径截一半比不截更糟）
      if (NEVER_TRUNCATE.has(k)) { out[k] = v; continue; }
      const r = shapeLongLines(v, k);
      cut += r.cut;
      out[k] = r.value;
    }
    return { value: out, cut };
  }
  return { value, cut: 0 };
}

// ── ② 外置：元数据 + 头尾预览 ───────────────────────────

/**
 * 头多尾少：开头通常是命令与结论（「我在跑什么」），结尾是错误摘要 / 汇总行（「结果如何」）。
 * 只给头不给尾时，模型看不到「最后一行是 Traceback」「N failed」这类决定性信号，
 * 于是照样以为成功 —— 这正是 head 截断单独用会翻车的地方。
 */
function headTailPreview(text: string): { head: string; tail: string } {
  if (text.length <= OUTPUT_PREVIEW_HEAD_CHARS + OUTPUT_PREVIEW_TAIL_CHARS) return { head: text, tail: "" };
  return { head: text.slice(0, OUTPUT_PREVIEW_HEAD_CHARS), tail: text.slice(-OUTPUT_PREVIEW_TAIL_CHARS) };
}

/** 读回建议。说清「怎么读、读几次」，别让模型对着一个大文件反复试（见 truncationNotice 的教训）。 */
function readBackStep(spillPath: string | undefined): string {
  return spillPath
    ? `Read ${spillPath} 读全文（一次读不完就带 offset/limit 分页；只想找片段就先 Grep 定位）。`
    : "完整内容没有落盘成功；需要全文请重跑这次工具调用，并把参数收窄到能放进预算。";
}

/**
 * 生成截断说明（三要素，缺一不可）。
 *
 * ⚠️ 第 2 条必须报出**存档文件的真实大小**。
 * 原来只写「文件可能很大，要分页读遍所有内容，只读第一页不算读完」——
 * 实测后果：模型看到「省略 8510 字符」+「可能很大」，就去反复 Grep / python 翻那个文件，
 * 而文件其实只有 10KB，**一次 Read 就够**。它翻了四五轮才发现。
 * 报出确切大小，模型才能一次决定「值不值得读、读几次」。
 */
export function truncationNotice(
  spillPath: string | undefined, omitted: number, tier: string, spillBytes?: number,
): string {
  let where: string;
  if (!spillPath) {
    where = "完整内容未能存档（写入失败）。";
  } else if (typeof spillBytes === "number" && spillBytes > 0) {
    const kb = (spillBytes / 1024).toFixed(1);
    // 一次 Read 默认最多 2000 行；这里按「够不够一次读完」给明确建议
    const oneShot = spillBytes <= 60_000;
    where = `完整内容已存档到：${spillPath}（**${kb} KB**）。` +
      (oneShot
        ? "文件不大，**一次 Read 就能读完**，不要反复分段读。"
        : "文件较大，用 Read 分页读（offset/limit），或直接用 Grep 定位你要的片段。");
  } else {
    where = `完整内容已存档到：${spillPath}。`;
  }
  return [
    "",
    "─── 以下内容已被截断 ───",
    `1) 这是**不完整的输出**，共省略约 ${omitted} 个字符。它**不是**一次完整读取的凭证。`,
    `2) ${where}`,
    "3) 如果你的目的是「搜索某个模式」，本次结果只代表**摘录覆盖**，不代表全部匹配。请用更精确的检索（Grep 带更窄的 pattern / 限定路径）确认，不要据此断言「不存在」。",
    "─────────────────────",
  ].join("\n");
}

export async function applyBudget(
  tool: Tool, rawResult: unknown, workdir: string, toolCallId: string,
): Promise<BudgetResult> {
  const serialized = JSON.stringify(rawResult ?? {});
  const originalSize = serialized.length;

  // passthrough：原样返回（截图 / 渲染类）
  if (tool.outputTier === "passthrough") {
    if (originalSize <= OUTPUT_TOTAL_BUDGET) return { result: rawResult, truncated: false, originalSize };
  }

  const budget = tool.outputTier === "exact"
    ? Math.floor(OUTPUT_TOTAL_BUDGET * 1.0)
    : OUTPUT_TOTAL_BUDGET;

  // 没超预算就一根手指都不碰：行内整形也会丢字符，丢了就得报「已截断」+ 落盘，
  // 给一个本来就放得下的结果加这些噪声，只会让模型对「到底丢没丢东西」更迷糊。
  if (originalSize <= budget) return { result: rawResult, truncated: false, originalSize };

  // ① 行内截断 —— 必须先做，且做在收缩的上游（顺序理由见 shapeLongLines）
  const shaped = shapeLongLines(rawResult);
  const shapedSize = JSON.stringify(shaped.value).length;

  // ② 无条件先跑一遍 factor=1 的收缩 —— 那一档就是**按字段限额**截断。
  //    为什么不能「整形后放得下就跳过」：整形把总长度压回预算内，**不等于**字段自己没超限。
  //    stdout 的限额是 1500，而整形只保证每行 ≤ 2000；于是整形到 2014 就收工，
  //    「每个字段最多多少」这句承诺就变成了看运气（实测：smoke-ptc 的 stdout 从 1500 涨到 2014 被抓到）。
  let current: unknown = shaped.value;
  let cut = shaped.cut;
  {
    const first = shrinkOnce(shaped.value, 1);
    current = first.value;
    cut = shaped.cut + first.cut;
  }
  // 还超预算才继续收缩（整形 + 字段限额通常已经够了，这个循环经常一次都不转）
  let fits = JSON.stringify(current).length <= budget;
  for (let factor = OUTPUT_SHRINK_FACTOR; !fits && factor >= OUTPUT_SHRINK_FLOOR; factor *= OUTPUT_SHRINK_FACTOR) {
    const r = shrinkOnce(shaped.value, factor);
    current = r.value;
    cut = shaped.cut + r.cut;
    fits = JSON.stringify(current).length <= budget;
  }

  // 只要发生了截断，就**总是**把完整原文存档 —— 否则模型永远拿不回丢掉的那部分内容。
  let spillPath: string | undefined;
  let spillBytes: number | undefined;
  try {
    const dir = join(workdir, ".spill");
    mkdirSync(dir, { recursive: true });
    spillPath = join(dir, `${toolCallId}.txt`);
    const payload = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult, null, 2);
    writeFileSync(spillPath, payload);
    spillBytes = Buffer.byteLength(payload, "utf8");
  } catch { spillPath = undefined; spillBytes = undefined; }

  // ③ 收缩后仍然超预算 → 换成「元数据 + 头尾预览」的指针。
  //    以前只给 1000 字符的头，模型既看不到尾部（错误摘要就在那儿），
  //    也不知道这份输出到底多大、原文在哪 —— 只能靠猜。
  if (!fits) {
    const rawText = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult, null, 2);
    const { head, tail } = headTailPreview(rawText);
    current = {
      _truncated: true,
      tool_name: tool.name,
      tool_call_id: toolCallId,
      output_size_chars: originalSize,
      output_path: spillPath ?? null,
      preview_head: head,
      preview_tail: tail,
      next_step: readBackStep(spillPath),
    };
    cut = originalSize - (head.length + tail.length);
  }

  const notice = truncationNotice(spillPath, Math.max(cut, 0), tool.outputTier, spillBytes);
  const result = current && typeof current === "object" && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>), _truncationNotice: notice, _spillPath: spillPath }
    : { _data: current, _truncationNotice: notice, _spillPath: spillPath };

  return { result, spillPath, truncated: true, originalSize };
}
