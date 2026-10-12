/**
 * 独立验收评估器 —— 目标续跑里那个「不让干活的人自己宣布完成」的角色。
 *
 * 三条纪律（抄 Alma Sprint Harness §3.5.3，也是这套东西唯一值钱的地方）：
 *  ① **独立**：它只拿到「目标原文 + 验收标准 + 落盘的证据」，拿不到主代理的自我陈述，
 *     也不许去猜。判断依据必须是盘上的东西。
 *  ② **逐项、可引用**：每项 0–100 分，且必须引用证据原文；引用不出来 = 这一项不算过。
 *  ③ **失败关闭（fail-closed）**：模型调用失败、JSON 解析失败、返回不完整 —— 一律判 FAIL。
 *     评估没跑成 ≠ 没评估，不能因为「评估器挂了」就放行完成。
 *
 * 为什么判定不在这里：判定规则放在 goal-criteria.ts（纯逻辑），这样测试能喂写死的分数
 * 验完整条闸门链路，不必把测试绑死在真模型上。这个文件只负责「问模型 + 解析」。
 */
import type { Provider } from "../providers/types.ts";
import { runSubagent } from "./subagent.ts";
import type { EvidenceItem } from "./goal-evidence.ts";
import {
  judgeEvaluation, renderCriteriaLines, DEFAULT_CRITERION_THRESHOLD,
} from "./goal-criteria.ts";
import type { CriterionScore, GoalCriterion, GoalVerdict } from "./goal-criteria.ts";

export interface GoalEvaluationInput {
  /** 目标原文（用户/模型建档时的措辞，评估器不得重新解释） */
  objective: string;
  criteria: GoalCriterion[];
  evidence: EvidenceItem[];
  /** 目标第几轮（从 1 起） */
  round: number;
}

export interface GoalEvaluator {
  /** 冒烟/日志里区分实现用（桩会给 "stub"） */
  readonly id?: string;
  evaluate(input: GoalEvaluationInput): Promise<GoalVerdict>;
}

const SYSTEM_PROMPT = [
  "你是一个**独立验收评估器**。你不是干活的人，也不是他的辩护人 —— 你的唯一职责是",
  "对着给定的证据，逐项判断「目标里的这一条到底做到了没有」。",
  "",
  "纪律（违反其中任何一条，这次评估都算无效）：",
  "- 你**看不到**干活的那个代理说了什么、也不要猜它说了什么。只按下面给的证据判。",
  "- 证据里没有的东西 = 没做到。拿不准就打低分，宁可苛刻，不要替它补全。",
  "- 每一项的 evidence 字段必须**逐字引用**证据里的内容（文件内容片段或命令输出片段）。",
  "  给不出引用就说明这一项无法核验 —— 直接给低于阈值的分。",
  "- 不许改验收标准、不许改阈值、不许把两项合成一项、不许漏项。",
  "",
  "打分口径（0–100 整数）：",
  "- 90–100：证据明确、完整地证明了这一条。",
  "- 阈值上下：证据基本支持，但有不完整或不确定的地方。",
  "- 0–40：证据不足、答非所问，或与这一条无关。",
  "",
  "只输出一个 JSON 对象，不要 markdown 代码围栏、不要任何解释文字：",
  '{"items":[{"id":"<标准 id>","score":0-100,"evidence":"引用的证据原文","note":"可选一句理由"}]}',
].join("\n");

export function renderEvaluatorPrompt(input: GoalEvaluationInput): string {
  const evidenceBlock = input.evidence.length === 0
    ? "（空：这一轮没有任何落盘产物或命令输出）"
    : input.evidence.map((e, i) => {
      const head = e.kind === "file"
        ? "【证据 " + (i + 1) + "｜文件】" + e.ref + (e.exists === false ? "（不存在）" : "")
        : "【证据 " + (i + 1) + "｜命令】";
      return head + "\n" + e.detail;
    }).join("\n\n");

  return [
    "目标原文（用户给出的标准，不得重新解释）：",
    input.objective,
    "",
    "验收标准（逐项打分，不得增删或改阈值；没写阈值的就是 " + DEFAULT_CRITERION_THRESHOLD + "）：",
    ...renderCriteriaLines(input.criteria),
    "",
    "本轮证据（全部取自磁盘与工具结果，**没有**干活代理的自我陈述）：",
    evidenceBlock,
    "",
    "现在逐项打分，只输出 JSON。",
  ].join("\n");
}

/**
 * 解析评估器的 JSON。容错只到「能从一个可能带围栏/前后缀的文本里抠出第一个 JSON 对象」为止，
 * 再宽松就等于替它编分 —— 编出来的分会被当成通过，那正是这套东西要防的事。
 */
export function parseEvaluatorScores(text: string): { ok: true; scores: CriterionScore[] } | { ok: false; error: string } {
  const t = (text ?? "").trim();
  if (!t) return { ok: false, error: "评估器没有输出内容" };
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "评估器没给出 JSON：" + t.slice(0, 200) };
  let obj: unknown;
  try { obj = JSON.parse(t.slice(start, end + 1)); }
  catch (e) { return { ok: false, error: "评估器的 JSON 解析失败：" + (e instanceof Error ? e.message : String(e)) }; }
  const items = (obj as { items?: unknown })?.items;
  if (!Array.isArray(items)) return { ok: false, error: "评估器的 JSON 里没有 items 数组" };
  const scores: CriterionScore[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const id = String(o.id ?? "").trim();
    if (!id) continue;
    const score = Number(o.score);
    if (!Number.isFinite(score)) continue;
    scores.push({
      id, score,
      evidence: typeof o.evidence === "string" ? o.evidence : "",
      ...(typeof o.note === "string" ? { note: o.note } : {}),
    });
  }
  if (scores.length === 0) return { ok: false, error: "评估器一条打分都没给" };
  return { ok: true, scores };
}

export interface ModelEvaluatorDeps {
  provider: Provider;
  model: string;
  signal?: AbortSignal;
  /** 评估器自己的输出（排查用；不写进对话） */
  onText?: (delta: string) => void;
}

/** 真评估器：把证据交给一个**没有工具权限**的独立子代理，取回 JSON 打分 */
export function makeModelEvaluator(deps: ModelEvaluatorDeps): GoalEvaluator {
  return {
    id: "model",
    async evaluate(input: GoalEvaluationInput): Promise<GoalVerdict> {
      const base = { criteria: input.criteria, evidenceCount: input.evidence.length, round: input.round };
      // 空证据直接判 FAIL：省一次模型调用，也不给「评估器心软」留空间
      if (input.evidence.length === 0) return judgeEvaluation({ ...base, scores: [] });
      try {
        const r = await runSubagent({
          provider: deps.provider, model: deps.model,
          prompt: renderEvaluatorPrompt(input),
          systemPrompt: SYSTEM_PROMPT,
          label: "goal-evaluator",
          signal: deps.signal,
          onText: deps.onText,
          // 没有 tools / execDeps：评估器不能改产物、也不能自己去"找"证据
        });
        const parsed = parseEvaluatorScores(r.output);
        if (!parsed.ok) return judgeEvaluation({ ...base, scores: [], failure: parsed.error });
        return judgeEvaluation({ ...base, scores: parsed.scores });
      } catch (e) {
        return judgeEvaluation({ ...base, scores: [], failure: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
