/**
 * 工具结果**老化**（microcompaction）
 *
 * 四家（CC microcompaction / Codex compact_retained_tool_outputs / Kimi 50k 外置）唯一收敛的省 token 手段：
 * 谁都没把老结果从历史里删掉，只是把**正文**换成一行指针。原因是同一个 ——
 * 历史就是前缀缓存的本体，删一条 / 换一条 / 重排一条，从那儿往后的缓存全部全价重付。
 *
 * 铁律（wire-history.ts「铁律二」）在这里有一个**唯一**的例外，而它就是本模块存在的理由：
 * 老化确实会改历史 —— 但只改**正文**，**结构 / 顺序 / 配对**一个字节都不动（这三样永远不许动，
 * 它们才是铁律二真正统治的东西）。为什么这一条可以例外：每条结果**只被换一次**、换完就稳定
 * （幂等判据见 session/store-rows.ts 的 isAgedBody），代价是**从最新老化点起**前缀重付一次 ——
 * 用一次可预期的重付，换掉此后每一轮都要重付的那段大正文。除此之外，历史只追加、不改写。
 * ⚠️ 边界（有意）：已经进压缩检查点的正文不再老化（payload 是已上过 wire 的前缀字节，改写它代价更大），
 * 详见 session/store.ts 的 ageToolParts。
 *
 * 所以这里是规划函数而不是执行器：它只回答「哪个 key 该换成什么文本、正文存到哪」，
 * 真正去改历史的是调用方 —— 本模块不认识 store / loop / wire，也就不可能自作主张地动结构。
 *
 * 输出顺序 == 输入顺序（调用方按这个顺序原地替换；这里若重排就等于换了消息顺序，缓存作废）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TOOL_RESULT_AGING_AFTER_STEPS, TOOL_RESULT_AGING_MIN_CHARS } from "../constants.ts";

export interface AgingCandidate { key: string; text: string; step: number; toolCallId?: string }

export interface AgingPlan {
  /** 原样透传：调用方拿它定位要替换的那条结果 */
  key: string;
  spillPath: string;
  /** 被换下来的正文本体（落盘内容也是它，除非目标文件已存在 —— 见 planAging 里那条注释） */
  body: string;
  /** 替换正文用的指针文本 */
  pointerText: string;
  savedChars: number;
}

/**
 * 文件名白名单：key 里可能带 `/`、`:`、空格，不洗一遍就会写到 .spill 目录外面去。
 * `..` 连排也要压掉 —— 目录名里留一段 `..`，人类读日志时会误以为这是一次路径穿越。
 */
function safeName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._]+|_+$/g, "")
    .slice(0, 80);
}

function fileNameFor(c: AgingCandidate): string | undefined {
  const id = c.toolCallId ? safeName(c.toolCallId) : "";
  // 有 toolCallId 就用它，与 budget.ts 的命名一字不差：同一次调用的原文永远在同一个文件里，
  // 模型在指针里读到的路径和历史里别处出现过的路径就不会打架。
  if (id) return `${id}.txt`;
  const key = safeName(c.key);
  if (!key) return undefined;
  // 退回用 key 命名时必须补哈希：两个不同的 key 可能洗成同一串，
  // 后写的会盖掉先写的，指针就指到别人的正文上了。
  return `${key}-${createHash("sha1").update(c.key).digest("hex").slice(0, 8)}.txt`;
}

/**
 * 指针文本：**路径 + 怎么读回来**两件事缺一不可。
 *
 * ⚠️ 别在这里复述原文：指针会在**之后每一步**重复上 wire，
 *    多写 200 字符 = 每个后续请求都多付 200 字符，正好抵消掉老化省下的量。
 */
function pointerFor(spillPath: string, chars: number): string {
  return [
    `[工具结果已老化] 正文已换成这行指针（被换下的正文 ${chars} 字符）；历史里的位置、配对、顺序都没变。`,
    `- 取回全文：Read ${spillPath}（归档里是完整那份，可能比上面的字数更多；读不完就带 offset/limit 分页，找片段先 Grep）。`,
    "- 若这条结果当时已标注「不完整」，归档文件里也一样不完整 —— 指针不改变这一点。",
  ].join("\n");
}

/**
 * 挑出该老化的结果，并把正文落盘。
 *
 * 选中的条件缺一不可：① 够老（超过 TOOL_RESULT_AGING_AFTER_STEPS 步）；② 够大（正文 ≥ 下限）。
 * 小的不换：指针本身也要花 token，换完省不下几个字，还白搭一次落盘。
 *
 * 落盘失败就**整条放弃**：半截 plan（指针指向一个没写成功的文件）比不老化更糟 ——
 * 模型会照着指针去读一个不存在的文件。
 */
export function planAging(cands: AgingCandidate[], currentStep: number, workdir: string): AgingPlan[] {
  const plans: AgingPlan[] = [];
  for (const c of cands) {
    if (currentStep - c.step <= TOOL_RESULT_AGING_AFTER_STEPS) continue;
    if (c.text.length < TOOL_RESULT_AGING_MIN_CHARS) continue;
    const name = fileNameFor(c);
    if (!name) continue;
    const spillPath = join(workdir, ".spill", name);
    if (!existsSync(spillPath)) {
      // ⚠️ 目标文件已存在就不覆盖：同名文件多半是 budget.ts 落的**全量原文**，
      // 而这里手里的正文是模型可见的那份（可能已经被裁过）。盖下去等于把模型唯一的回读路径变小。
      // 已有文件只多不少，指针照旧指它。
      try {
        mkdirSync(join(workdir, ".spill"), { recursive: true });
        writeFileSync(spillPath, c.text);
      } catch { continue; }
    }
    const pointerText = pointerFor(spillPath, c.text.length);
    plans.push({
      key: c.key, spillPath, body: c.text, pointerText,
      savedChars: Math.max(0, c.text.length - pointerText.length),
    });
  }
  return plans;
}
