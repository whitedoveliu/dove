/**
 * 通道①：问候通道（仿 Alma 的 greeting injection）
 *
 * 触发：消息 trim 后 ≤ greetingMaxChars 且**整句**就是问候语（中/英/日/韩/西五组）。
 * 动作：把最近 48h 的活动摘要 + 一段**硬性指令块**注入 mt。
 *
 * 为什么判定必须是「整句」：`你好，帮我看下 index.html` 不是问候，是任务 ——
 * 错判会把一个具体请求降级成寒暄，还会白白吃掉问候块的位置。
 * 所以这里不用「命中子串」判定，而是把整句拆成问候原子后要求完全消耗（^…+$）。
 */
import { ACTIVITY_INJECT } from "../constants.ts";

/** 问候原子：中文 / 英文 / 日文 / 韩文 / 西文 + 称呼与语气词 */
const GREETING_ATOMS = [
  // 中文
  "你好", "您好", "哈喽", "哈啰", "嗨", "嘿", "喂", "在吗", "在么", "在不在", "忙吗",
  "早上好", "早安", "中午好", "下午好", "晚上好", "晚安", "好久不见", "幸会", "别来无恙",
  // 英文
  "hi", "hello", "hey", "heya", "hiya", "yo", "howdy", "sup", "greetings",
  "good\\s*(?:morning|afternoon|evening|day)", "morning", "afternoon", "evening",
  "what'?s\\s*up", "how\\s*are\\s*you", "nice\\s*to\\s*meet\\s*you", "long\\s*time\\s*no\\s*see",
  // 日文
  "こんにちは", "こんばんは", "おはよう(?:ございます)?", "やあ", "どうも", "はじめまして", "おやすみ(?:なさい)?",
  // 韩文
  "안녕하세요", "안녕하십니까", "안녕", "반가워요?", "좋은\\s*아침",
  // 西文
  "hola", "buenos\\s*d[ií]as", "buenas\\s*(?:tardes|noches)", "buenas", "qu[eé]\\s*tal", "saludos", "aló",
  // 称呼 / 语气词：允许「你好啊」「hi there」「hey dove」
  "there", "everyone", "all", "folks", "dove", "各位", "大家", "亲", "啊", "呀", "哦", "喔", "嘛", "呢", "啦",
];

/**
 * 原子之间的分隔符：空白 + 中英标点（含西语的倒问号 / 倒感叹号）。
 * ⚠️ 波浪号有两种：ASCII 的 `~` (U+007E) 和**全角 `～` (U+FF5E)**。
 * 中文/日文输入法打出来的是全角那个 —— 只写 ASCII 会导致「嗨～」判不出问候（实测踩过）。
 * 同理补上日文的 `〜` (U+301C) 和间隔号。
 */
const GREETING_SEP = "[\\s,.!?~、。！？…\\-—¿¡，；：'“”～〜·・]";
const GREETING_RE = new RegExp("^" + GREETING_SEP + "*(?:(?:" + GREETING_ATOMS.join("|") + ")" + GREETING_SEP + "*)+$");

/** emoji / 变体选择符 / 零宽连接符：问候里常见，判定前先剥掉 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

/** 按码点数长度（emoji 在 UTF-16 里算 2，这里不该算 2） */
export function charLength(text: string): number {
  return Array.from(text ?? "").length;
}

/** 整句是否只是一句问候 */
export function isGreeting(text: string): boolean {
  try {
    const raw = (text ?? "").replace(EMOJI_RE, "").trim();
    if (!raw) return false;
    if (charLength(raw) > ACTIVITY_INJECT.greetingMaxChars) return false;
    return GREETING_RE.test(raw.toLowerCase().trim());
  } catch {
    return false;   // 判定失败一律当普通消息：宁可不注入，不可错判
  }
}

/**
 * 硬性指令块。措辞必须是命令句 —— 软话（"可以聊聊…"）模型会当建议忽略。
 * 三条铁律对应 Alma 的原设计：必须具体、禁止空话、禁止复述。
 */
export const GREETING_PROTOCOL = [
  "## Greeting protocol（硬性指令，逐条执行）",
  "- 必须提到一件具体的事：从上面的活动摘要、你最近参与的对话或项目、或你在屏幕上看到过的具体内容里挑**一件**，",
  "  用你自己的话点出来（例：「你昨天一直在调登录页那个按钮的间距」）。挑不出具体的事，就不要说自己在打招呼。",
  '- 禁止 "How can I help?" / "有什么可以帮你的吗" / "需要我做什么" 这类空话 —— 它们等于什么都没说。',
  "- 禁止复述摘要原文：不要照抄上面的句子、条目或数字，用你自己的话转述，一次只提一件。",
  "- 问候归问候：不要借着打招呼顺手把任务做了，也不要列清单。",
].join("\n");

/** 没有摘要时的兜底：仍然要求具体，但把「具体」的来源换成记忆与最近对话 */
export const GREETING_PROTOCOL_NO_SUMMARY = [
  "## Greeting protocol（硬性指令，逐条执行）",
  "- 最近 48 小时没有可用的活动摘要 —— 那就从你的记忆或最近几轮对话里挑**一件**具体的事来提（某次对话、某个项目、某个文件）。",
  '- 禁止说 "How can I help?" / "有什么可以帮你的吗" 这类空话。',
  "- 禁止编造活动记录：摘要为空时不要假装看到了什么。",
].join("\n");

/** 渲染问候块；摘要为空串/NULL 时只给兜底指令块 */
export function buildGreetingBlock(summary: string | null | undefined): string {
  const text = (summary ?? "").trim();
  if (!text) return GREETING_PROTOCOL_NO_SUMMARY;
  const clipped = text.length > ACTIVITY_INJECT.greetingSummaryChars
    ? text.slice(0, ACTIVITY_INJECT.greetingSummaryChars) + "…（摘要已截断）"
    : text;
  return ["## Recent activity (last 48h)", clipped, "", GREETING_PROTOCOL].join("\n");
}
