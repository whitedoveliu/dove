/**
 * 线程级工具策略（D8：Home 只读 + 调度，不直接改项目文件）
 *
 * 为什么要在内核层硬拦，而不是只靠提示词：
 * 提示词是「请求」，工具表是「能力」。只靠提示词 = 迟早会写。
 * 这里做的是**能力裁剪**。裁剪落在哪条轴上由 ExposureMode 决定：
 *  - cut（缺省）：被裁的工具**从工具表里删掉** —— Home 线程根本拿不到写类工具；
 *  - visible：工具留在 wire 上、**执行**被拦下（前缀缓存不失效，理由见下面 ExposureMode 的注释）。
 */
import type { Tool } from "../tools/types.ts";

/**
 * 会改动文件系统 / 产生副作用的工具
 *
 * RunScript 与 Bash 同一档：脚本里能写文件、能起进程、能联网 —— 它就是本地代码执行。
 * 所以 Home 线程（没有 Bash）也拿不到它；只读线程同样（见下面的 READONLY_EXTRA_BLOCKED）。
 * 只把 RunScript 放进 READONLY_EXTRA_BLOCKED 是不够的：那会留下
 * 「Home 线程没有 Bash、却有等价的任意代码执行」这个洞。
 *
 * ⚠️ 名单里**只能出现真实存在的工具名**：原来还挂着 "Delete" 与 "QuickEdit"，
 *    这两个工具早就被 Edit/Bash 取代、已经不在工具表里 —— 死名字不会报错，
 *    只会让后来读代码的人以为「还有这两个工具」。加名字前先确认工具存在。
 */
export const MUTATING_TOOLS = new Set([
  "Write", "Edit", "Bash", "KillShell", "RunScript", "TerminalSend",
]);

/** Home 线程额外允许的工具（调度能力） */
export const HOME_EXTRA_TOOLS = new Set(["DispatchToProject"]);

/**
 * 只读模式下**额外**要裁掉的（不是「改文件」，而是「会派活/会留下持久副作用」）：
 * - SendMessage 可以让已结束的子代理续跑，而子代理是有写权限的 → 等于绕开只读；
 * - CronCreate / CronDelete 会留下长期副作用（到点自动跑）；
 * - DispatchToProject / Task 本来就是派活。
 * Home 线程**不裁**这些 —— 调度台本来就是干这个的。
 */
const READONLY_EXTRA_BLOCKED = new Set(["DispatchToProject", "Task", "SendMessage", "CronCreate", "CronDelete"]);

/** 任何线程都必须有的元工具 */
const ALWAYS = new Set(["AttemptCompletion", "AskUserQuestion", "TodoWrite", "ToolSearch", "Skill"]);

/**
 * 暴露模式 —— 两轴模型里的「可见性」轴（执行轴见 PolicyResult.blockedFromExecution）：
 *  - cut（缺省）：从 `tools` 里删掉被裁的工具 —— 模型看不见它，也执行不了（历史行为）；
 *  - visible    ：工具**留在** `tools` 里（wire 上的 schema 一字不变 → provider 前缀缓存不失效），
 *                 由执行器拦下（ExecDeps.blockedFromExecution）。
 *
 * 为什么要有第二档：工具表一改，provider 的前缀缓存就**整段**失效 ——
 * 被缓存的前缀是「system + 全部 tool schema + 消息」这一条连续序列，删掉中间一个工具，
 * 后面所有 token 全部错位。Home / 只读线程每轮都裁，等于这类线程**永远在冷启动**，
 * 而模型只会觉得「我没这个能力」，账单看得见、界面看不见。
 * 对照：OpenAI Codex 的 ToolExposure.direct_model_only（模型看得见、执行不了）、
 * Kimi Code 的 btw 干脆保留完整 schema 只在执行器里否决 —— 理由都是这一条。
 */
export type ExposureMode = "cut" | "visible";

/**
 * 环境开关：只有 DOVE_TOOL_EXPOSURE=visible 才开新轴，缺省 / 其它值 / 大小写不符 → 老行为。
 * 为什么由环境变量而不是直接改默认：这不是「更好的默认」，是**行为切换** ——
 * visible 下模型能看见写类工具（只是执行不了），提示词措辞、日志、用户观感都会变，得由人来开。
 *
 * ⚠️ 这里**只做取值**，不要拿它当 applyThreadPolicy 的缺省值：可见性与执行拦截是**一对**，
 *    必须由同一个调用方（runtime）原子地一起打开（exposure + ExecDeps.blockedFromExecution）。
 *    只打开可见性那一半 = 工具留在表里、又没人拦 = **静默把权限关掉**（Home 线程能直接写项目文件）；
 *    缺省一律 cut 正是为此：宁可不生效，也不能 silently 放行。接线见 agent/runtime.ts。
 */
export function exposureModeFromEnv(raw: string | undefined = process.env.DOVE_TOOL_EXPOSURE): ExposureMode {
  return raw === "visible" ? "visible" : "cut";
}

export interface PolicyResult {
  tools: Map<string, Tool>;
  /** 被裁掉的工具名（用于告知模型，避免它以为能力不存在） */
  blocked: string[];
  /**
   * 「看得见但不可执行」的名字（visible 模式下非空，cut 模式下恒为空）。
   *
   * 与 `blocked` 的分工：`blocked` 是**策略结论**（提示词与日志用，两种模式完全一致）；
   * `blockedFromExecution` 是**执行器的活**。cut 下它必然为空 —— 那些工具连表都没进，
   * 执行器查不到它们，拦截这一步是多余的。
   */
  blockedFromExecution: string[];
  /** 这次实际生效的暴露模式 —— renderPolicyNotice 必须拿同一个值渲染，措辞才不会与实际行为脱节 */
  exposure: ExposureMode;
  /** 这次裁剪的原因，用于日志与提示词措辞 */
  reason: "home" | "read-only" | "none";
}

export interface PolicyOptions {
  /**
   * 只读权威（T8.2）：用户显式要求「只看不改」时，**一切写入都被禁止** ——
   * 连报告、计划、临时脚本都不许落盘，结果回聊天。
   */
  readOnly?: boolean;
  /** 暴露模式；不传 = cut（历史行为）。visible 必须**连同** ExecDeps.blockedFromExecution 一起接，
   *  否则就是「看得见又没人拦」= 静默把权限关掉（为什么不让本函数自己读环境变量，见 exposureModeFromEnv） */
  exposure?: ExposureMode;
}

/**
 * 按线程类型裁剪工具集。
 * - project 线程：全部可用（除非 readOnly）
 * - home 线程：去掉所有写类工具，保留只读 + 记忆 + 元工具 + 调度
 * - readOnly（任意线程）：连 home 都保留的能力里，凡是有副作用的也去掉
 *
 * ⚠️ cut 与 visible 只差一件事：被裁的工具**在不在返回的 `tools` 里**。
 *    `blocked`/`reason` 两种模式完全一致 —— 提示词与日志不因模式而变，变的只有执行侧。
 */
export function applyThreadPolicy(
  kind: "home" | "project", tools: Map<string, Tool>, opts: PolicyOptions = {},
): PolicyResult {
  const exposure = opts.exposure ?? "cut";   // 缺省 = 历史行为；visible 由调用方连执行侧一起打开
  if (kind !== "home" && !opts.readOnly) {
    return { tools, blocked: [], blockedFromExecution: [], exposure, reason: "none" };
  }

  // 只读模式更严：连 AskUserQuestion / TodoWrite 之外有副作用的都去掉
  const readOnlyBlocked = new Set([...MUTATING_TOOLS, ...READONLY_EXTRA_BLOCKED]);
  const deny = opts.readOnly ? readOnlyBlocked : MUTATING_TOOLS;
  const reason: PolicyResult["reason"] = opts.readOnly ? "read-only" : "home";

  const blocked: string[] = [];
  for (const name of tools.keys()) if (!ALWAYS.has(name) && deny.has(name)) blocked.push(name);

  if (exposure === "visible") {
    // 一个都不删：Map 的**内容与顺序**保持原样（顺序即缓存，见 tools/registry.ts 顶部纪律）。
    // 返回同一个引用是有意的 —— 调用方（runtime）会把它当「工具表」交给 wire 装配，多一次复制只是浪费。
    return { tools, blocked, blockedFromExecution: [...blocked], exposure, reason };
  }

  const allowed = new Map<string, Tool>();
  for (const [name, tool] of tools) {
    if (ALWAYS.has(name) || !deny.has(name)) allowed.set(name, tool);
  }
  return { tools: allowed, blocked, blockedFromExecution: [], exposure, reason };
}

/**
 * 给「看得见但不可执行」的工具生成拦截理由（**给模型看**，不是给日志看）。
 *
 * 为什么第一句必须明说「不是不存在」：visible 下工具真的挂在 wire 上，模型能从 schema 读到它。
 * 只说「不许用」的话，它很可能去 ToolSearch 里反复搜同一个工具（搜到的还是这个被拦的），
 * 或者以为自己记错了名字、换个拼法再试一次 —— 一句「工具在、但本轮执行不了」能省掉整轮空转。
 * （反面教训在 renderPolicyNotice 那边：措辞与实际行为不一致，比功能缺失更危险。）
 */
export function executionBlockedReason(
  name: string, blocked: ReadonlySet<string>, reason: "home" | "read-only" | "none",
): string | undefined {
  if (reason === "none" || !blocked.has(name)) return undefined;
  return reason === "read-only"
    ? `工具 ${name} 本轮被权限策略裁掉（只读线程：用户要求只看不改）。它**不是不存在**，只是这轮不许执行 —— 别去 ToolSearch 里翻它。如果你想写东西，请先在回复里说明需要什么改动。`
    : `工具 ${name} 本轮被权限策略裁掉（Home 线程：调度台不直接改项目）。它**不是不存在**，只是这轮不许执行 —— 别去 ToolSearch 里翻它。要改代码/跑命令，用 DispatchToProject 把活派到项目线程。`;
}

/** 给模型的提示：告诉它哪些能力被裁掉了，以及应该怎么绕；`exposure` 必须传**实际生效**的那个值 */
export function renderPolicyNotice(
  kind: "home" | "project", blocked: string[], projectIds: string[], reason: PolicyResult["reason"] = "home",
  exposure: ExposureMode = "cut",   // 缺省跟着 applyThreadPolicy 的缺省走：没接线就不许说「不存在的工具只是执行不了」
): string {
  if (blocked.length === 0) return "";

  // ⚠️ 措辞必须与**实际行为**一致。visible 下这些工具还挂在工具表里，说它「不存在」就是假话 ——
  //    模型会以为自己没这能力（于是不去用），或者反过来试一次才发现被拦，白烧一步。
  //    措辞与实际行为不一致比功能缺失更危险：功能缺失只是一次失败，假话会让模型照着**错的世界模型**规划。
  const listed = exposure === "visible" ? "存在但不可执行" : "不存在";
  // visible 还要额外说清「别绕路」：被裁名单里的 Bash 也还在表上，模型很容易想
  // 「那我用 Bash 写文件」—— 那条路同样会被执行器拦下，得提前堵住。
  const noDetour = exposure === "visible"
    ? ["- 这些工具本轮**一个都执行不了**：不要拿其中一个去绕另一个（比如用 Bash 写文件），同样会被拦下。"]
    : [];

  if (reason === "read-only") {
    return [
      "<system-reminder>",
      "用户这次要求的是**只读**：查清楚、说清楚，不要动任何东西。",
      `写类工具（${blocked.join("、")}）在你的工具表里**${listed}**。`,
      "",
      "所以：",
      "- 结果直接写在回复里，**不要**生成报告文件、计划文件、副本或临时脚本（哪怕用户没明说，只读就是只读）。",
      "- 需要给用户看代码时，在回复里贴关键片段并指明 `文件:行号`。",
      "- 如果真的必须改点什么才能继续，**停下来问用户**，不要自作主张。",
      ...noDetour,
      "</system-reminder>",
    ].join("\n");
  }

  if (kind !== "home") return "";
  return [
    "<system-reminder>",
    "你现在在 Home 线程 —— 这里是「调度台」，不是工作区。",
    `为了让「Home 不会误改项目」，写类工具（${blocked.join("、")}）在你的工具表里**${listed}**。`,
    "",
    "所以：",
    "- 你可以读文件、查记忆、看版本、回答用户的问题。",
    "- 需要改代码/跑构建/生成图片时，**不要自己动手**，用 DispatchToProject 把活派到对应项目线程。",
    projectIds.length > 0 ? `- 当前可用项目：${projectIds.join("、")}` : "- 目前还没有项目，可以先用面板新建一个。",
    ...noDetour,
    "</system-reminder>",
  ].join("\n");
}
