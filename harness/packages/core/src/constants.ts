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

// ── PTC：RunScript（模型写代码调用工具，Alma §3.4） ────
/** 脚本默认超时（与 Alma 同值） */
export const PTC_DEFAULT_TIMEOUT_MS = 120_000;
/** 脚本超时上限（与 Alma 同值，10 分钟） */
export const PTC_MAX_TIMEOUT_MS = 600_000;
/**
 * RunScript **工具本身**的超时（executeOne 的 race 上限）。
 * 必须大于脚本自己的超时：否则脚本还没到点就被外层 race 掐掉，
 * 模型拿到的是「工具 RunScript 超时」，而脚本的 stdout / 超时说明全丢 —— 那是静默失败。
 */
export const PTC_PARENT_TIMEOUT_MS = PTC_MAX_TIMEOUT_MS + 60_000;
/**
 * 脚本内 doveTool 等内核的 HTTP 等待上限（兜底值）。
 * 脚本请求会在审批上阻塞，所以执行器会按脚本的 timeout_ms 把它**下调**（见 run-script.ts）：
 * 让脚本在被子进程超时杀掉之前，先自己报一条「等内核等超时了」的错。
 */
export const PTC_INVOKE_TIMEOUT_MS = 600_000;
/**
 * 单条流（stdout / stderr）留在内存里的硬上限，超了就地截断。
 * 256k 与 Alma 的执行器同档；完整内容仍由 budget.ts 落盘回写路径。
 */
export const PTC_STREAM_HARD_CAP = 256_000;

// ── 审批 ──────────────────────────────────────────────
export const APPROVAL_CLASSIFIER_TIMEOUT_MS = 10_000;

/** 等用户点「允许 / 拒绝」的默认上限：5 分钟。**默认值不动**，只是变成可配置。 */
export const APPROVAL_TIMEOUT_MS = 300_000;

/**
 * 生效的审批等待上限。
 *
 * 为什么要有：实测（10-06/07 日志）审批挂满 5 分钟 → 自动拒绝 → 那一轮白跑，
 * 用户回来只看到失败。超时本身可以保留（不能无限等），但**必须能调**：
 * 离开工位前把 DOVE_APPROVAL_TIMEOUT_MS 调大，比回来发现活白干了强。
 * 非法值（NaN / ≤0）一律退回默认，避免一个手滑的环境变量把审批直接掐成 0 毫秒。
 */
export function approvalTimeoutMs(): number {
  const raw = Number(process.env.DOVE_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : APPROVAL_TIMEOUT_MS;
}

/** 毫秒 → 「5 分钟」/「30 秒」/「1.5 小时」（写给用户看的，不要出现裸毫秒数） */
export function humanDuration(ms: number): string {
  if (ms < 1000) return Math.round(ms) + " 毫秒";
  const s = ms / 1000;
  if (s < 60) return (Number.isInteger(s) ? s : s.toFixed(1)) + " 秒";
  const m = s / 60;
  if (m < 60) return (Number.isInteger(m) ? m : m.toFixed(1)) + " 分钟";
  const h = m / 60;
  return (Number.isInteger(h) ? h : h.toFixed(1)) + " 小时";
}

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
 * - hash-1024 降级（没装 onnxruntime / 没下模型）：
 *   相关 0.13~0.39，无关 ≤0.064 → 取 **0.12**。
 * 选哪一档由 embedder.id 决定（hash-* → 降级档），见 memory/index.ts 的 injectThresholdFor。
 */
export const MEMORY_INJECT_THRESHOLD = 0.44;
export const MEMORY_INJECT_THRESHOLD_HASH = 0.12;

// ── 子代理 ────────────────────────────────────────────
export const SUBAGENT_MAX_STEPS = 100;

// ── 图片（ReadImage / image part 链路） ────────────────
/**
 * 单张图片上限。**单点定义**：ReadImage 工具与 context/images.ts 的装配共用，
 * 两处写两个数就会出现「工具说能读、装配时被静默跳过」的错位。
 */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** 一条消息最多带几张图（超出不发送，避免一次请求把上下文撑爆） */
export const IMAGE_MAX_PER_MESSAGE = 6;
/** 一轮最多允许 ReadImage 挂几张图（防模型一次读几十张把历史撑爆） */
export const IMAGE_MAX_PER_TURN = 8;
/** 上下文「接近压缩线」的判定：used ≥ compactAt × 该比例 */
export const CONTEXT_NEAR_COMPACT_FRACTION = 0.85;

// ── 主动性 ────────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * 心跳自检清单的兜底文本（**单点定义**，两处读它）：
 *   - scheduler/heartbeat.ts：HEARTBEAT.md 缺失时的兜底清单；
 *   - memory/files.ts：首次运行落盘成 <configDir>/HEARTBEAT.md。
 *
 * 纪律：清单里的每一项都必须能用**只读工具**回答（RuntimeStatus / Read / Glob / Grep / Recall）。
 * 实测病灶：清单原来问「有没有没跑完的任务」，而 Home 线程拿不到 Bash、
 * 也没有任何「看运行状态」的工具 —— 模型只能猜，每次心跳 1–4 步就 HEARTBEAT_OK，
 * 自检形同虚设。加问题之前先确认有工具能答。
 */
export const HEARTBEAT_CHECKLIST_TEXT: string = [
  "# HEARTBEAT · 主动性检查单",
  "",
  "> 每次心跳醒来时按这份清单自检；没事做就安静待着，不要刷存在感。",
  "",
  "- 有没有没跑完的任务？（RuntimeStatus：后台任务 / 子代理）",
  "- 有没有快到期、已经过期或该提醒的事？（RuntimeStatus 的定时任务 next_run；今天日记里的约定）",
  "- 有没有已经产出、值得说一句的进展？（Glob/Read 看 outputs/ 与 memory/今天.md 有没有新东西）",
].join("\n");

/**
 * 定时任务「短到会烧钱」的警戒线。
 * 低于这个间隔的 every 任务，启动时会打一条醒目的 warn ——
 * 实测踩过：测试建的「每 2 秒报时」落进生产库 + 重复 4 份 = 25 分钟烧 1080 轮。
 */
export const CRON_MIN_SANE_INTERVAL_MS = 30_000;
export const HEARTBEAT_ACTIVE_HOURS = [8, 23] as const;

// ── 事件日志 ──────────────────────────────────────────
export const EVENT_LOG_FLUSH_INTERVAL_MS = 200;

// ── 工具输出整形（行内截断 → 预算 → 外置） ─────────────
/**
 * 单行上限：先把超长行**折行内截断**，再判总预算。
 * 为什么顺序不能反：grep/find 这类输出「行多、每行信息密度高」，
 * 直接按总字符砍会把模型真正需要的尾部整段丢掉；先修长行能保住更多**不同**的事实。
 */
export const OUTPUT_LINE_MAX_CHARS = 2_000;
/** 外置/预览时保留的头尾（头多尾少：开头通常是命令与结论，结尾是错误摘要） */
export const OUTPUT_PREVIEW_HEAD_CHARS = 4_096;
export const OUTPUT_PREVIEW_TAIL_CHARS = 1_024;
/**
 * 工具结果**老化**：超过这么多步之后，把老结果的正文换成 spill 指针。
 * 四家（CC microcompaction / Codex compact_retained_tool_outputs / Kimi 50k 外置）唯一收敛的省 token 手段。
 * 只换正文、不动结构 —— 配对关系与顺序必须原样保留，否则前缀缓存整段作废。
 */
export const TOOL_RESULT_AGING_AFTER_STEPS = 6;
/** 小于这个长度的结果不值得换成指针（指针本身也要花 token） */
export const TOOL_RESULT_AGING_MIN_CHARS = 1_500;

// ── 读侧路径护栏（写侧是 resolveInsideWorkspace，读侧原先完全没有） ──
/** 路径里出现这些目录名（任意一段）直接拒绝读取：SSH / 云凭证 / 包管理器令牌 */
export const SENSITIVE_DIR_SEGMENTS: readonly string[] = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".netrc", ".config/gcloud",
];
/** 文件名命中即拒绝（跨目录通用） */
export const SENSITIVE_FILE_NAMES: readonly string[] = [
  ".env", ".env.local", ".env.production", "id_rsa", "id_ed25519", "id_ecdsa",
  "credentials", "credentials.json", ".npmrc", ".pypirc", ".htpasswd",
  "shadow", "master.key", "secrets.yml", "secrets.yaml",
  /**
   * 裸名 `env` —— 这条不是通用惯例，是**本仓库自己的惯例**：
   * README 第 1 步就是 `echo 'ANTHROPIC_API_KEY=…' > env`（仓库根一个叫 env 的文件装真钥匙）。
   * 拦了 `.env` 却放着 `env` 不拦，等于护栏有个正好对着自家钥匙的门。
   * 只按「末尾一段全等」命中，`src/env.ts` / `env/foo` 都不受影响。
   */
  "env",
];
/**
 * 这些后缀是**模板/样板**，不是真钥匙 —— 命中即放行（见 sensitiveHitOf 的 ⓪）。
 * `.env.example` 拦下来的唯一效果是模型读不到该配哪些变量。
 */
export const SENSITIVE_NAME_EXEMPT_SUFFIXES: readonly string[] = [".example", ".sample", ".template", ".dist"];
/** 文件名的前后缀命中即拒绝（如 xxx.pem / service-account-yyy.json） */
export const SENSITIVE_FILE_SUFFIXES: readonly string[] = [".pem", ".key", ".p12", ".pfx", ".keystore"];
export const SENSITIVE_FILE_PREFIXES: readonly string[] = ["service-account-"];

// ── 审批规则（会话级「同意并记住」） ────────────────────
/** 一条会话规则最长多少个字符（防模型/用户塞进来一个巨型 glob） */
export const APPROVAL_RULE_MAX_CHARS = 200;
/** 单个线程最多记住多少条会话规则（超出丢最老的一条） */
export const APPROVAL_SESSION_RULE_MAX = 100;

// ── 工具并发调度（路径冲突图） ────────────────────────
/** 未声明 accesses 的工具一律按「与所有工具冲突」处理（串行）—— 保守优先 */
export const SCHEDULER_DEFAULT_SERIAL = true;

// ── 重复断路器（同一工具 + 同一参数反复重试） ──────────
/**
 * 分级干预门槛：到第 3 次先提醒、第 5 次再提醒一次（措辞更硬）、
 * 第 8 次强制停批、第 12 次直接失败。四家都有一版这种东西，dove 之前只有「续跑次数」计数。
 */
export const REPEAT_BREAKER_LEVELS = [3, 5, 8, 12] as const;

// ── 子代理角色（白名单 + 能力） ───────────────────────
/** 子代理默认 2 小时超时（抄 Kimi；后台任务本来就是长活） */
export const SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** 子代理作用域缓存：超过这个数就淘汰最老的（被占用的会顺延） */
export const SUBAGENT_SCOPE_CACHE_SIZE = 32;
/** 一次派发最多允许同时跑几个子代理 */
export const SUBAGENT_MAX_CONCURRENT = 6;

// ── 回合净 diff（「这轮改了什么」+ 「回退这一轮」的地基） ──
export const TURN_DIFF_TIMEOUT_MS = 100;
/** 净 diff 最多记住多少个文件（防一轮改几百个文件把内存撑爆） */
export const TURN_DIFF_MAX_FILES = 200;

// ── 压缩：保住「用户真正说过的话」 ─────────────────────
/**
 * 压缩后保留的**真实用户消息**总 token 预算。
 * 20_000 这个数不是我拍的：Kimi（COMPACT_USER_MESSAGE_MAX_TOKENS）与
 * Codex（COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000）两份独立实现收敛到同一个值。
 * 头预算小的那部分用来保住**最早**那条需求（否则工具密集的回合会把最初诉求挤掉）。
 */
export const COMPACT_KEEP_USER_TOKENS = 20_000;
export const COMPACT_KEEP_USER_HEAD_TOKENS = 2_000;
/** 压缩后重新挂一遍「当前回合的提醒」（plan / goal / 未注入的 AGENTS.md） */
export const COMPACT_REARM_REMINDERS = true;

// ── 项目指令文件（AGENTS.md） ─────────────────────────
/** 与 Codex 同值：32 KiB，超出**警告**（不硬截断，否则模型看到半截规则更危险） */
export const AGENTS_MD_MAX_BYTES = 32 * 1024;
export const AGENTS_MD_PLAIN_NAMES: readonly string[] = ["AGENTS.md", "agents.md"];
/** 每个文件前面加的来源锚点，也是「反查某段指令来自哪个文件」的依据 */
export const AGENTS_MD_ANCHOR = (p: string): string => `<!-- From: ${p} -->`;

// ── 段落注册：静态 / 动态纪律（T2.2） ──────────────────
export type SegmentKind = "static" | "semi" | "dynamic";
