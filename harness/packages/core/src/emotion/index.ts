/**
 * 情绪 + 疲劳门面（M6 / T6.6）：上层只 import 这个目录。
 * 两者都是「每轮都变」的块，渲染结果交给 context/tail-context.ts 的 mt，绝不进系统提示词。
 */
export {
  EmotionService,
  clampValence,
  decayValence,
  fuseEmotions,
  toneHint,
  EMOTION_MIN,
  EMOTION_MAX,
  EMOTION_NEUTRAL,
  EMOTION_BASE_DECAY_MS,
  EMOTION_CONTEXT_DECAY_MS,
  EMOTION_FUSION_BASE,
  EMOTION_FUSION_CONTEXT,
  EMOTION_DEFAULT_LABEL,
} from "./emotion.ts";
export type { Emotion, EmotionState, EmotionServiceOptions } from "./emotion.ts";

export {
  FatigueService,
  FATIGUE_MIN,
  FATIGUE_MAX,
  FATIGUE_AWAKE_PER_HOUR,
  FATIGUE_SLEEP_PER_HOUR,
  FATIGUE_REST_PER_HOUR,
  FATIGUE_TIRED_AT,
  FATIGUE_SLEEPY_AT,
  FATIGUE_WAKE_AT,
  FATIGUE_DEFAULT_REST_MINUTES,
  FATIGUE_STATE_LABEL,
} from "./fatigue.ts";
export type { FatigueRecord, FatigueSnapshot, FatigueState, FatigueServiceOptions } from "./fatigue.ts";

export {
  atomicWriteText,
  parseFrontmatter,
  readMarkdown,
  safeId,
  serializeFrontmatter,
  writeMarkdownAtomic,
} from "./frontmatter.ts";
export type { FrontmatterValue, MarkdownDoc } from "./frontmatter.ts";
