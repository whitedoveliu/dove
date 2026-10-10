/**
 * 工具注册表（T3.2 / T3.4）
 *
 * ⚠️ 缓存纪律（设计稿 §4.2）：**数组顺序 = 上 wire 的顺序**。
 *    CORE 顺序一旦定下就不要动；动态激活的工具只能**追加到尾部**。
 *    删除或重排会让 provider 的前缀缓存整段失效 —— 模型看不见差别，账单看得见。
 */
import type { Tool, ToolSchema } from "./types.ts";
import { normalizeToolSchema } from "./normalize.ts";

// ── CORE：每轮常驻，顺序固定 ───────────────────────────
import { ReadTool } from "./builtin/read.ts";
import { WriteTool } from "./builtin/write.ts";
import { EditTool } from "./builtin/edit.ts";
import { GlobTool } from "./builtin/glob.ts";
import { GrepTool } from "./builtin/grep.ts";
import { BashTool } from "./builtin/bash.ts";
import { BashOutputTool } from "./builtin/bash-output.ts";
import { KillShellTool } from "./builtin/kill-shell.ts";




import { RecallTool } from "./builtin/recall.ts";
import { RememberTool } from "./builtin/remember.ts";
import { SleepTool } from "./builtin/sleep.ts";
import { CurrentTimeTool } from "./builtin/current-time.ts";
// P0 能力：看图 / 自己的上下文余量（常驻：模型必须知道「我能看图」「我快满了」）
import { ReadImageTool } from "./builtin/read-image.ts";
import { GetContextRemainingTool } from "./builtin/context-remaining.ts";
// 交付物：把「已经写完的文件」声明给界面（渲染成卡片，可点开预览）
import { PresentTool } from "./builtin/present.ts";

// ── SYSTEM：元工具，永远在，不参与激活 ─────────────────
import { AttemptCompletionTool } from "./builtin/attempt-completion.ts";
import { AskUserQuestionTool } from "./builtin/ask-user.ts";
import { TodoWriteTool } from "./builtin/todo-write.ts";
import { ToolSearchTool } from "./builtin/tool-search.ts";
import { SkillTool } from "./builtin/skill.ts";
// 计划模式 / 长期目标：元能力，永远在（各自只在对应状态下真正生效）
import { ExitPlanModeTool } from "./builtin/exit-plan-mode.ts";
import { CreateGoalTool } from "./builtin/goal-create.ts";
import { GetGoalTool } from "./builtin/goal-get.ts";
import { UpdateGoalTool } from "./builtin/goal-update.ts";

// ── ON_DEMAND：检索后追加激活 ──────────────────────────
import { WebSearchTool } from "./builtin/web-search.ts";
import { WebFetchTool } from "./builtin/web-fetch.ts";
import { TaskTool } from "./builtin/task.ts";
import { DispatchToProjectTool } from "./builtin/dispatch.ts";
import { TaskOutputTool } from "./builtin/task-output.ts";
// 持久终端（保持 cwd/环境）：先 ToolSearch 激活再上表
import { TerminalOpenTool } from "./builtin/terminal-open.ts";
import { TerminalSendTool } from "./builtin/terminal-send.ts";
import { TerminalReadTool } from "./builtin/terminal-read.ts";
import { TerminalCloseTool } from "./builtin/terminal-close.ts";
import { TerminalListTool } from "./builtin/terminal-list.ts";
import { ListAgentsTool } from "./builtin/list-agents.ts";
import { SendMessageTool } from "./builtin/send-message.ts";
import { InterruptAgentTool } from "./builtin/interrupt-agent.ts";
import { ListMcpResourcesTool } from "./builtin/list-mcp-resources.ts";
import { ReadMcpResourceTool } from "./builtin/read-mcp-resource.ts";
import { CronCreateTool } from "./builtin/cron-create.ts";
import { CronListTool } from "./builtin/cron-list.ts";
import { CronDeleteTool } from "./builtin/cron-delete.ts";

export const CORE_TOOLS: Tool[] = [
  ReadTool, WriteTool, EditTool, GlobTool, GrepTool,
  BashTool, BashOutputTool, KillShellTool,

  RecallTool, RememberTool,
  // 只追加在 CORE 尾部：既有工具的 wire 顺序不变（缓存纪律）
  SleepTool, CurrentTimeTool,
  ReadImageTool, GetContextRemainingTool,
  PresentTool,
];

export const SYSTEM_TOOLS: Tool[] = [
  AttemptCompletionTool, AskUserQuestionTool, TodoWriteTool, ToolSearchTool, SkillTool,
  // Home 线程的调度能力；项目线程里也用得上（派活给别的项目）
  DispatchToProjectTool,
  // 计划模式 / 目标：常驻，不进检索（模型必须知道「有计划模式这回事」「我有目标」）
  ExitPlanModeTool, CreateGoalTool, GetGoalTool, UpdateGoalTool,
];

export const ON_DEMAND_TOOLS: Tool[] = [
  WebSearchTool, WebFetchTool, TaskTool, TaskOutputTool,
  // P0：子代理控制面 / MCP 资源 / 定时任务 —— 都要先 ToolSearch 激活（顺序只追加）
  ListAgentsTool, SendMessageTool, InterruptAgentTool,
  ListMcpResourcesTool, ReadMcpResourceTool,
  CronCreateTool, CronListTool, CronDeleteTool,
  TerminalOpenTool, TerminalSendTool, TerminalReadTool, TerminalCloseTool, TerminalListTool,
];

/** 依赖闭包：激活左边的工具时，右边必须一起激活 */
export const DEPENDENCY_CLOSURE: Record<string, string[]> = {
  Bash: ["BashOutput", "KillShell"],
  // 会派子代理，就一并给出「看/追加/中断」的控制面（否则模型只能干等）
  Task: ["TaskOutput", "ListAgents", "SendMessage", "InterruptAgent"],
  // 终端四件套：激活 send 的必然也要 open/read/close，否则拿到 id 也没用
  TerminalSend: ["TerminalOpen", "TerminalRead", "TerminalClose", "TerminalList"],
};

/** 必带补充集：任何情况下都不能被裁掉 */
export const ALWAYS_INCLUDED = new Set(SYSTEM_TOOLS.map((t) => t.name));

/**
 * 把 ToolSearch 自己的描述**从按需工具列表生成**。
 *
 * 为什么必须生成而不是手写：按需工具不在模型的默认工具表里，
 * 模型只能靠读这句描述知道「有什么可搜」。原来手写的那句列了
 * 「网页搜索 / 网页抓取 / 生成 PPT / 版本管理」——**漏了子代理**，
 * 而且「版本管理」在工具删掉之后还留着。实测后果：用户让模型派子代理，
 * 模型压根不知道有这个能力，全程自己搜网页。
 *
 * 放在这里回填是因为 tool-search.ts 与 registry.ts 有循环引用
 * （见那边的注释），模块体里读不到 ON_DEMAND_TOOLS；到这里已经全部就绪。
 */
function renderToolSearchDescription(): string {
  const list = ON_DEMAND_TOOLS
    .map((t) => "- " + t.name + "：" + (t.discoverable ?? t.description.split("。")[0] ?? ""))
    .join("\n");
  return [
    "按关键词检索「未常驻」的工具并激活它们。",
    "",
    "**这些工具不在你当前的工具表里** —— 需要下面任何一项能力时，先用本工具检索：",
    list,
    "",
    "检索完**同一步就能直接调用**（不用等下一轮）。常驻工具不需要检索。",
  ].join("\n");
}
ToolSearchTool.description = renderToolSearchDescription();

/** 目录超过这个数就必须显式传 activeTools，否则强制最小集 */
export const TOOL_COUNT_INVARIANT = 40;

// ── EXTERNAL：MCP 等外部工具（T3.12），**永远追加在尾部** ──
let externalToolList: Tool[] = [];

/**
 * 注册/替换外部工具（MCP）。
 * 纪律：
 *  - 只追加在尾部，绝不插队 —— 前缀缓存靠顺序稳定（设计稿 §4.2）
 *  - 与内置工具重名的直接丢弃（内置优先，否则 wire 上会出现重名函数）
 */
export function registerExternalTools(list: Tool[]): void {
  const builtin = new Set([...CORE_TOOLS, ...SYSTEM_TOOLS, ...ON_DEMAND_TOOLS].map((t) => t.name));
  const seen = new Set<string>();
  const kept: Tool[] = [];
  for (const t of list) {
    if (!t || !t.name) continue;
    if (builtin.has(t.name) || seen.has(t.name)) {
      console.warn("[tools] 外部工具名冲突或重复，已忽略：" + t.name);
      continue;
    }
    seen.add(t.name);
    kept.push(t);
  }
  externalToolList = kept;
}

/** 当前外部工具（MCP），顺序 = 注册顺序（尾部追加） */
export function externalTools(): Tool[] { return [...externalToolList]; }

// ── 动态激活状态（进程级） ─────────────────────────────
const activated = new Set<string>();

/** 检索：按名字与描述打分 */
export function searchTools(query: string, limit = 8): Tool[] {
  const q = query.toLowerCase().trim();
  if (!q) return ON_DEMAND_TOOLS.slice(0, limit);
  const raw = q.split(/\s+/).filter(Boolean);
  // 中文无空格：把含中文的整词再拆成 2-gram（"网页搜索" → "网页","页搜","搜索"）
  const terms = new Set<string>();
  for (const t of raw) {
    terms.add(t);
    if (/[\u4e00-\u9fff]/.test(t) && t.length > 2) for (const g of cjkGrams(t)) terms.add(g);
  }
  const scored = allTools().map((t) => {
    const name = t.name.toLowerCase();
    const desc = t.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name === term) score += 100;
      else if (name.includes(term)) score += 40;
      if (desc.includes(term)) score += 10;
    }
    for (const kw of TOOL_KEYWORDS[t.name] ?? []) {
      const k = kw.toLowerCase();
      for (const term of terms) if (k.includes(term) || term.includes(k)) score += 30;
    }
    if (isAlwaysActive(t.name)) score -= 1_000;
    return { t, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.t);
}

/** 追加激活（含依赖闭包）；返回实际激活的名字 */
export function activateTools(names: string[]): string[] {
  const out: string[] = [];
  const queue = [...names];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (activated.has(n) || isAlwaysActive(n)) continue;
    if (!getTool(n)) continue;
    activated.add(n);
    out.push(n);
    for (const dep of DEPENDENCY_CLOSURE[n] ?? []) queue.push(dep);
  }
  return out;
}

export function deactivateAll(): void { activated.clear(); }

function isAlwaysActive(name: string): boolean {
  return CORE_TOOLS.some((t) => t.name === name) || ALWAYS_INCLUDED.has(name)
    || externalToolList.some((t) => t.name === name);   // MCP 工具常驻，不需要检索激活
}

/** 当前应该上 wire 的工具集合：CORE + SYSTEM + 已激活（追加在尾部，顺序稳定） */
export function activeTools(): Tool[] {
  const tail = [...activated]
    .map((n) => getTool(n))
    .filter((t): t is Tool => !!t && !isAlwaysActive(t.name));
  // 外部工具（MCP）永远在最后一段：即使中途 disconnect/connect 也不动前面的顺序
  return [...CORE_TOOLS, ...SYSTEM_TOOLS, ...tail, ...externalToolList];
}

export function currentActiveNames(): string[] { return activeTools().map((t) => t.name); }
export function onDemandTools(): Tool[] { return ON_DEMAND_TOOLS; }
export function coreTools(): Tool[] { return CORE_TOOLS; }
export function systemTools(): Tool[] { return SYSTEM_TOOLS; }

/** ON_DEMAND 工具的中文关键词表（中文没空格，整词 substring 匹配不上） */
export const TOOL_KEYWORDS: Record<string, string[]> = {
  WebSearch: ["搜索", "网页", "联网", "查资料", "最新", "百度", "google", "搜一下"],
  WebFetch: ["抓取", "网页", "链接", "文档", "打开网址", "url", "读取网页"],
  // GenerateImage / GeneratePPT / GenerateVideo 已移除 —— 生成类需求走技能（office-* / 图像技能）
  Task: ["子代理", "子任务", "派一个", "独立完成", "subagent"],
  TaskOutput: ["子代理", "后台任务", "进度", "task"],
  ListAgents: ["子代理", "后台任务", "列表", "有哪些", "agent", "进度"],
  SendMessage: ["子代理", "追加", "补充", "续跑", "消息", "send"],
  InterruptAgent: ["中断", "停止", "取消", "掐掉", "子代理", "interrupt"],
  ListMcpResources: ["mcp", "资源", "外部", "服务器", "resource"],
  ReadMcpResource: ["mcp", "资源", "读取", "uri", "resource"],
  CronCreate: ["定时", "计划", "cron", "提醒", "每天", "每隔", "schedule"],
  CronList: ["定时", "计划", "cron", "任务列表", "什么时候跑"],
  CronDelete: ["定时", "删除", "取消", "cron", "别跑了"],
  TerminalOpen: ["终端", "shell", "命令行", "常驻", "持久", "pty", "terminal"],
  TerminalSend: ["终端", "shell", "命令", "执行", "发命令", "terminal"],
  TerminalRead: ["终端", "输出", "看结果", "回显", "terminal"],
  TerminalClose: ["终端", "关闭", "杀掉", "结束会话", "terminal"],
  TerminalList: ["终端", "会话列表", "有哪些终端", "terminal"],
};

/** CJK 2-gram：把无空格中文长词切成二元组，提升召回 */
function cjkGrams(term: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= term.length; i++) out.push(term.slice(i, i + 2));
  return out;
}

export function getTool(name: string): Tool | undefined {
  return allTools().find((t) => t.name === name);
}

/** 全部工具（CORE + SYSTEM + ON_DEMAND + EXTERNAL），顺序固定：**外部工具只追加在尾部** */
export function allTools(): Tool[] {
  return [...CORE_TOOLS, ...SYSTEM_TOOLS, ...ON_DEMAND_TOOLS, ...externalToolList];
}

/**
 * 上 wire 的 schema。
 * 不变量守卫：目录 > TOOL_COUNT_INVARIANT 且调用方没传 limitTo → 强制最小集。
 * （否则 provider 会把全部工具塞上 wire，token 爆炸）
 */
export function wireSchemas(limitTo?: string[]): ToolSchema[] {
  const catalog = allTools();
  if (catalog.length > TOOL_COUNT_INVARIANT && !limitTo) {
    console.warn("[INVARIANT] 工具目录 " + catalog.length + " 且未指定 activeTools，已强制最小集");
    return [...CORE_TOOLS, ...SYSTEM_TOOLS].map(normalizeToolSchema);
  }
  const list = limitTo ? catalog.filter((t) => limitTo.includes(t.name)) : activeTools();
  // T3.3：上 wire 前必须归一化（MCP 动态注册的工具会带脏字段）
  return list.map(normalizeToolSchema);
}
