/**
 * 全部常量单点（计划 §3.2 / 规格书 §4）
 * 纪律：任何超时 / 步数 / 阈值都不许散落在别处。
 */

// ── 循环 ──────────────────────────────────────────────
export const STEP_CAP = 100;                 // 单 pass 步数上限
export const STEP_CAP_COMPACTION_BONUS = 1;  // 压缩回退时 +1
export const MAX_AUTO_CONTINUE = 10;         // 外层续跑上限
export const COMPLETION_GUARD_RETRIES = 3;   // 完成守卫重试
export const PERMISSION_CONTINUE_RETRIES = 3;// 权限续跑
export const TURN_WATCHDOG_MS = 4 * 60 * 60 * 1000; // 整轮看门狗 4h

// ── 超时 ──────────────────────────────────────────────
export const IDLE_TIMEOUT_MS = 60_000;        // 普通
export const IDLE_TIMEOUT_IMAGE_MS = 180_000; // 生图
export const IDLE_TIMEOUT_REASONING_MS = 240_000;
export const IDLE_TIMEOUT_CRON_MS = 300_000;
export const TOOL_TIMEOUT_MS = 600_000;       // 工具超时 600s
export const TOOL_TIMEOUT_CRON_MS = 1_200_000;

// ── 压缩 ──────────────────────────────────────────────
export const COMPACT_DEFAULT_THRESHOLD = 80;      // 百分比
export const COMPACT_THRESHOLD_RANGE = [60, 95] as const;
export const COMPACT_KEEP_RECENT_TURNS = 4;       // 单位：对话回合
export const COMPACT_KEEP_RECENT_RANGE = [2, 20] as const;
export const COMPACT_MAX_OUTPUT_FALLBACK = 32_000;
export const COMPACT_WIRE_RATIO_MAX = 3;
export const COMPACT_MIN_STEP_GAP = 2;            // 去抖：距上次压缩 step < 2 直接 return
export const COMPACT_TARGET_WINDOW_FRACTION = 0.6;
export const COMPACT_TARGET_MIN_FRACTION = 0.15;

// ── 工具输出预算 ──────────────────────────────────────
export const OUTPUT_TOTAL_BUDGET = 6_000;   // 序列化总预算（字符）
export const OUTPUT_SHRINK_FACTOR = 0.8;    // 迭代收缩
export const OUTPUT_SHRINK_FLOOR = 0.35;    // 下限
export const OUTPUT_FIELD_LIMITS: Record<string, number> = {
  stdout: 1_500, stderr: 1_500, content: 1_800, markdown: 1_500,
  elements: 1_600, preview: 500, summary: 280, snippet: 280, result: 1_000,
};
export const OUTPUT_DEFAULT_STRING_LIMIT = 900;

// ── 审批 ──────────────────────────────────────────────
export const APPROVAL_CLASSIFIER_TIMEOUT_MS = 10_000;

// ── 记忆 ──────────────────────────────────────────────
export const MEMORY_DEFAULTS = {
  enabled: true,
  autoSummarize: true,
  autoRetrieve: true,
  maxRetrievedMemories: 5,
  similarityThreshold: 0.1,
  queryRewriting: true,
} as const;
export const MEMORY_SLEEP_DEFAULTS = {
  dailyTime: "03:00",
  temporaryTtlDays: 30,
  archiveRetentionDays: 30,
  similarityMergeThreshold: 0.95,
  llmMergeLow: 0.75,
  llmEnabled: true,
  llmBatchSize: 20,
} as const;

/**
 * 记忆**注入通道**（不是 recall 工具）的相似度地板。
 * recall 是显式检索，宁可多给；注入是每轮白送的上下文，宁可不给也不要噪声。
 *
 * **必须按后端分档** —— 两代后端的分数尺度差一大截：
 * - 真向量（BGE-small-zh-v1.5，6 条中文记忆实测）：
 *   12 个相关 query 的最高分 0.367~0.750（中位 0.545）；
 *   12 个无关 query 的最高分 0.314~0.446（最高是「hi」0.446、「谢谢」0.433）。
 *   阈值扫描（F1 最优）→ **0.44**：召回 0.92 / 精确 0.92 / F1 0.917。
 *   对照 0.48 只有 召回 0.75 / F1 0.857 —— 0.44 明显更好，所以用 0.44。
 *
 *   ⚠️ 已知局限（别指望调阈值能解决）：
 *   跨语言/概念级的匹配会掉到噪声地板以下 —— 实测「怎么打包」→「构建命令是 npm run build」
 *   只有 **0.367**，比「谢谢」的 0.433 还低。这种对任何单阈值都无解，
 *   属于 embedding 模型的能力边界（bge-small-zh 对「打包/build」这组同义词不够敏感）。
 *   要解决得换更大的模型（bge-base / bge-m3，代价是体积 98MB / 542MB），或加查询改写。
 *
 *   注意「谢谢」这类客套语 isGreeting() 判为 false（它是感谢不是问候），
 *   所以靠「问候走问候通道」并不能把它从记忆通道排除掉。
 * - hash-1024 降级（没装 onnxruntime / 没下模型）：
 *   相关 0.13~0.39，无关 ≤0.064 → 取 **0.12**。
 * 选哪一档由 embedder.id 决定（hash-* → 降级档），见 memory/index.ts 的 injectThresholdFor。
 */
export const MEMORY_INJECT_THRESHOLD = 0.44;
export const MEMORY_INJECT_THRESHOLD_HASH = 0.12;

// ── 运行时活动注入：三条通道（问候 / 语义 / 记忆） ─────
export const ACTIVITY_INJECT = {
  /** ① 问候通道：trim 后字符数上限（超过就当普通消息） */
  greetingMaxChars: 30,
  /** ① 问候通道：最近活动摘要回看窗口 */
  greetingWindowMs: 48 * 60 * 60 * 1000,
  /** ① 问候通道：摘要字符上限（每轮都发，必须小） */
  greetingSummaryChars: 900,
  /** ② 语义通道：最短触发长度（字符） */
  semanticMinChars: 4,
  /** ② 语义通道：只搜最近这么久以内的 OCR 帧 */
  semanticWindowMs: 24 * 60 * 60 * 1000,
  /**
   * ② 语义通道 · **向量通道**阈值（真 ONNX 向量，BGE-small-zh-v1.5）。
   * 用真实屏幕 OCR 内容标定：相关 query 最高分 0.539 / 0.472 / 0.387 / 0.670（最低 0.387），
   * 无关 query 最高分 0.217 / 0.287 / 0.399 / 0.245（最高 0.399）——
   * 重叠带 [0.387, 0.399]，取 0.40 卡在带子中间。
   * ⚠️ 别抄 Alma 的 0.75：那是他们模型的尺度；BGE-zh 上正确匹配只有 0.43~0.63，卡 0.75 会全部漏掉。
   */
  semanticThreshold: 0.40,
  /**
   * ② 语义通道 · **词袋降级通道**阈值（没有真向量时用本地 2-gram 打分）。
   * 两个通道的分数不在一个量级，必须分开：
   * relevance = 命中查询词权重 / min(查询词权重, semanticQueryCap)，
   * 实测相关消息 0.33~0.58、仅蹭到一个通用词的消息 0.14 —— 0.25 卡在中间。
   */
  semanticThresholdLexical: 0.25,
  /** ② 向量通道：候选帧上限（按时间倒序取最近 N 帧算余弦） */
  semanticVectorFrames: 40,
  /** ② 向量通道：帧向量内存缓存条数（只缓存，不落库；避免每轮重算同一帧） */
  semanticVectorCache: 400,
  /** ② 语义通道：查询词权重分母的封顶（长消息不该被自身长度惩罚） */
  semanticQueryCap: 12,
  /** ② 语义通道：最多注入几条 */
  semanticTopK: 3,
  /** ② 语义通道：单条片段字符上限 */
  semanticSnippetChars: 180,
  /** ② 语义通道：超时（毫秒）—— 超时即放弃，绝不拖慢发送 */
  semanticTimeoutMs: 350,
  /** 单条查询词权重：单字命中不可靠，降权 */
  singleCharWeight: 0.35,
} as const;

// ── 子代理 ────────────────────────────────────────────
export const SUBAGENT_MAX_STEPS = 100;

// ── 主动性 ────────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * 定时任务「短到会烧钱」的警戒线。
 * 低于这个间隔的 every 任务，启动时会打一条醒目的 warn ——
 * 实测踩过：测试建的「每 2 秒报时」落进生产库 + 重复 4 份 = 25 分钟烧 1080 轮。
 */
export const CRON_MIN_SANE_INTERVAL_MS = 30_000;
export const HEARTBEAT_ACTIVE_HOURS = [8, 23] as const;

// ── 事件日志 ──────────────────────────────────────────
export const EVENT_LOG_FLUSH_INTERVAL_MS = 200;

// ── 段落注册：静态 / 动态纪律（T2.2） ──────────────────
export type SegmentKind = "static" | "semi" | "dynamic";
