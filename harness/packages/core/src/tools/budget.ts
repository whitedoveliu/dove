/**
 * 输出预算（T3.5 / T3.6）
 * 三档 + 总预算 6000 字符 + 迭代收缩 + 超长落盘。
 *
 * ⚠️ 截断标记文案是本模块最重要的产出：它必须明说三件事，
 * 否则模型会对「我读完了」产生虚假认知（Alma 答疑 P2-12 第 2 条，被事故打出来的）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "./types.ts";
import {
  OUTPUT_TOTAL_BUDGET, OUTPUT_SHRINK_FACTOR, OUTPUT_SHRINK_FLOOR,
  OUTPUT_FIELD_LIMITS, OUTPUT_DEFAULT_STRING_LIMIT,
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

  if (originalSize <= budget) return { result: rawResult, truncated: false, originalSize };

  // 迭代收缩
  let factor = 1;
  let current = rawResult;
  let cut = 0;
  while (factor >= OUTPUT_SHRINK_FLOOR) {
    const r = shrinkOnce(rawResult, factor);
    current = r.value;
    cut = r.cut;
    if (JSON.stringify(current).length <= budget) break;
    factor *= OUTPUT_SHRINK_FACTOR;
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

  // 收缩后仍然超预算 → 换成指针 + 前缀预览
  if (JSON.stringify(current).length > budget) {
    current = { _truncated: true, _preview: String(JSON.stringify(rawResult)).slice(0, 1_000) };
    cut = originalSize - 1_000;
  }

  const notice = truncationNotice(spillPath, Math.max(cut, 0), tool.outputTier, spillBytes);
  const result = current && typeof current === "object" && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>), _truncationNotice: notice, _spillPath: spillPath }
    : { _data: current, _truncationNotice: notice, _spillPath: spillPath };

  return { result, spillPath, truncated: true, originalSize };
}
