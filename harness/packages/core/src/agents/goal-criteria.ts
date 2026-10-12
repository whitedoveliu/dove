/**
 * 目标的验收标准（criteria）与**判定**（纯逻辑，不碰 DB 也不碰模型）
 *
 * 抄的是 Alma Sprint Harness 的工程纪律（§3.5.3）：质量标准由**独立的一次评估**给出，
 * 干活的人不能自己宣布完成。这里落三件硬规矩：
 *  ① 0–100 打分，`score >= threshold` 才算这一项通过（低一分都不行，不做「差不多」）；
 *  ② **空证据 = 自动 FAIL** —— 评估器说得再好听，拿不出可核验的产物就是没做；
 *  ③ 逐项都要有证据引用；缺项 / 空白引用按未通过处理。
 *
 * 为什么判定单独成文件：它必须能被**桩**替掉（冒烟脚本给几条写死的分数就能验完整条闸门链路），
 * 而且判定规则要能从评估器实现里独立读出来 —— 规则写在提示词里就等于没有规则。
 */

export interface GoalCriterion {
  id: string;
  description: string;
  /** 0–100；得分 **>= threshold** 才算通过 */
  threshold: number;
}

/** 没给 threshold 时的默认门槛：宁可偏严，也不让「我觉得还行」混过去 */
export const DEFAULT_CRITERION_THRESHOLD = 80;
/** 一条标准最多这么长 —— 目标行要回读给模型，塞进提示词太长会挤掉正文 */
export const MAX_CRITERION_DESC = 400;
export const MAX_CRITERIA = 12;

/** 评估器对某一项的打分（evidence 是它引用到的证据；空字符串 = 没给引用 = 这一项不算过） */
export interface CriterionScore {
  id: string;
  score: number;
  evidence?: string;
  note?: string;
}

export interface GoalFailureItem {
  id: string;
  description: string;
  threshold: number;
  /** null = 评估器根本没给这一项打分 */
  score: number | null;
  reason: string;
}

export interface GoalVerdict {
  pass: boolean;
  /** 这一轮是目标的第几轮（从 1 起） */
  round: number;
  at: number;
  items: CriterionScore[];
  failures: GoalFailureItem[];
  reason: string;
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 把工具/面板给进来的原始 criteria 规范成标准形状。
 * 不抛异常（调用方要自己决定怎么报错）—— 校验和报错分开，工具层与存储层都能用同一个判定。
 */
export function normalizeCriteria(raw: unknown): { ok: true; criteria: GoalCriterion[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, criteria: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "criteria 必须是数组：[{id, description, threshold}]。" };
  if (raw.length === 0) return { ok: true, criteria: [] };
  if (raw.length > MAX_CRITERIA) return { ok: false, error: "criteria 最多 " + MAX_CRITERIA + " 条：评估要逐项打分，标准太多等于没标准。" };

  const out: GoalCriterion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    if (!it || typeof it !== "object") return { ok: false, error: "criteria[" + i + "] 必须是对象 {id, description, threshold}。" };
    const o = it as Record<string, unknown>;
    const id = String(o.id ?? "").trim();
    const description = String(o.description ?? "").trim();
    if (!id) return { ok: false, error: "criteria[" + i + "] 缺 id。" };
    if (!description) return { ok: false, error: "criteria[" + i + "]（" + id + "）缺 description：标准要写成一句能判对错的话。" };
    if (seen.has(id)) return { ok: false, error: "criteria 里 id 重复：" + id + "（逐项打分要靠它对应，必须唯一）。" };
    seen.add(id);
    const raw_th = o.threshold;
    const th = raw_th === undefined || raw_th === null ? DEFAULT_CRITERION_THRESHOLD : Number(raw_th);
    if (!Number.isFinite(th) || th < 0 || th > 100) {
      return { ok: false, error: "criteria[" + i + "]（" + id + "）的 threshold 必须是 0–100 的数字。" };
    }
    out.push({ id, description: description.slice(0, MAX_CRITERION_DESC), threshold: clampScore(th) });
  }
  return { ok: true, criteria: out };
}

/** 存库/回读的边界：老库里的 JSON 可能被手改坏，读坏数据不能炸掉整个目标 */
export function parseCriteriaJson(text: unknown): GoalCriterion[] {
  if (typeof text !== "string" || !text.trim()) return [];
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  const r = normalizeCriteria(raw);
  return r.ok ? r.criteria : [];
}

export function parseVerdictJson(text: unknown): GoalVerdict | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  try {
    const v = JSON.parse(text) as GoalVerdict;
    if (!v || typeof v !== "object" || typeof v.pass !== "boolean") return undefined;
    return v;
  } catch { return undefined; }
}

/** 给提示词/回读用的逐行渲染 */
export function renderCriteriaLines(criteria: GoalCriterion[]): string[] {
  return criteria.map((c) => "- [" + c.id + "] " + c.description + "（阈值 " + c.threshold + "/100）");
}

/**
 * 判定：把「评估器给的分数」变成「过 / 不过」。
 *
 * 顺序刻意如此 —— 先看证据总量，再看逐项：
 *   · evidenceCount === 0 → **全部**判失败，不管评估器打了多少分（空证据 = 自动 FAIL）；
 *   · 缺这一项的打分 → 失败（评估器漏项不能算默认通过）；
 *   · 有分数但没引用证据 → 失败（说不出依据的分数不可信）；
 *   · score < threshold → 失败。
 */
export function judgeEvaluation(input: {
  criteria: GoalCriterion[];
  scores: CriterionScore[];
  evidenceCount: number;
  round: number;
  /** 评估器整个没跑起来时的原因（网络/解析失败）—— 一律按不过处理 */
  failure?: string;
}): GoalVerdict {
  const { criteria, scores, evidenceCount, round, failure } = input;
  const at = Date.now();
  const byId = new Map<string, CriterionScore>();
  for (const s of scores) if (s.id) byId.set(String(s.id), s);

  const noEvidence = evidenceCount === 0;
  const failures: GoalFailureItem[] = [];
  for (const c of criteria) {
    const s = byId.get(c.id);
    const score = s ? clampScore(s.score) : null;
    const quote = (s?.evidence ?? "").trim();
    let reason: string | null = null;

    if (failure) reason = "评估没能完成：" + failure;
    else if (noEvidence) reason = "证据为空：这一轮没有任何落盘产物或命令输出可核验（空证据一律判 FAIL）";
    else if (!s) reason = "评估器没有给这一项打分";
    else if (!quote) reason = "这一项没有给出证据引用（说不出依据的分数不算数）";
    else if (score! < c.threshold) reason = "得分 " + score + " 低于阈值 " + c.threshold;

    if (reason) failures.push({ id: c.id, description: c.description, threshold: c.threshold, score, reason });
  }

  // 评估器给了标准里没有的 id：忽略（它多写几项不算失败）；**漏项**才是失败，上面已覆盖
  const pass = failures.length === 0 && criteria.length > 0;
  const reason = pass
    ? "全部 " + criteria.length + " 项达标（依据 " + evidenceCount + " 条证据）。"
    : failure
      ? "评估没能完成：" + failure + "（没跑成评估=没验证，一律不给完成）"
      : noEvidence
        ? "证据为空：没有可核验的产物，不能判通过。"
        : "未通过 " + failures.length + "/" + criteria.length + " 项：" + failures.map((f) => f.id).join("、");
  return { pass, round, at, items: scores.map((s) => ({ ...s, score: clampScore(s.score) })), failures, reason };
}
