/**
 * 审批规则（会话级「同意并记住」）—— 规则串的解析 / 匹配 / 持久化
 *
 * 规则串形如 `ToolName(argGlob)`，例如 `Bash(rm *)`、`Write(/Users/x/proj/src/*)`。
 * 三条纪律：
 *  ① 参数部分**不在这里猜**：参数模式由工具自己声明的 `Tool.approvalRule(args)` 给出，
 *     本模块只负责把它和规则里的 glob 比对。工具没声明 → 只能整工具匹配（不带括号的规则）。
 *  ② 任何坏格式（缺右括号 / 超长 / 空）**一律当不匹配**，绝不抛 ——
 *     一条坏规则不能让整次工具调用失败，更不能变成「静默放行」。
 *  ③ 存储走**线程 metadata**（`store.getThread(id).metadata`），用既有 API，
 *     不新建表、不动 session/ 层。
 */
import { APPROVAL_RULE_MAX_CHARS, APPROVAL_SESSION_RULE_MAX } from "../constants.ts";
import type { Tool, ApprovalResponse } from "./types.ts";

/**
 * `ApprovalResponse` 的本地扩展：多一个可选的 `remember`。
 *
 * ⚠️ `remember` 还没有进 `tools/types.ts` 的 `ApprovalResponse`（那是父代理的文件，
 *    实现者不许动）。没有它，「用户明确表示记住」这件事**在类型上无法表达**；
 *    这里先用扩展类型接住，等父代理把 `remember?: boolean` 加上后
 *    这份扩展就退化成同义别名、可以删掉。
 */
export interface ApprovalResponseRemembered extends ApprovalResponse {
  /** true = 用户明确要求「同意并记住」（只有它为 true 时才写会话规则） */
  remember?: boolean;
}

/** 解析后的规则 */
export interface ParsedRule {
  /** 工具名 glob（大小写不敏感） */
  name: string;
  /** 括号里的参数 glob；undefined = 整工具匹配 */
  arg?: string;
  /** `!` 前缀：参数**不**匹配 arg glob 时才算命中 */
  negated: boolean;
}

/**
 * 解析规则串；任何坏格式返回 null（不抛）。
 *
 * ⚠️ 取**最后一个** `)` 而不是第一个：参数 glob 里可能带括号（如 `echo (x)`）。
 *    规则以 `)` 结尾是硬要求 —— 这正是「缺右括号」被拒的路径。
 */
export function parseRule(input: string): ParsedRule | null {
  const s = String(input ?? "").trim();
  if (!s || s.length > APPROVAL_RULE_MAX_CHARS) return null;
  const open = s.indexOf("(");
  if (open < 0) return { name: s, negated: false };
  if (!s.endsWith(")")) return null;
  const name = s.slice(0, open).trim();
  let arg = s.slice(open + 1, -1).trim();
  if (!name) return null;
  let negated = false;
  if (arg.startsWith("!")) { negated = true; arg = arg.slice(1).trim(); }
  if (!arg) return null;                       // `Bash()` / `Bash(!)` 不是规则
  return { name, arg, negated };
}

/** 工具名 glob：`*` 通配、大小写不敏感（`bash` 与 `Bash` 同一条规则） */
export function ruleMatchesTool(namePattern: string, toolName: string): boolean {
  const re = new RegExp("^" + namePattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
  return re.test(toolName);
}

/**
 * 规则里的参数 glob：转义正则元字符后，把 `*` / `**` 都换成正则 `.*`（**跨 `/`**）。
 *
 * 为什么用 `.*` 而不是 shell 语义的 `[^/]*`：参数既可能是**命令**（`Bash(rm *)`，里面
 * 天然带 `/tmp/x` 这种路径），也可能是**文件路径**（`Write(/proj/src/*)`）。命令里的 `*`
 * 必须跨 `/` 才能命中，而用 `[^/]*` 会给出一个**静默不匹配**的规则（看起来记住了、其实不生效）。
 * 代价是路径规则会覆盖子目录 —— 那是**多问一次**的方向，不是放行的方向，安全。
 */
export function argGlobMatches(glob: string, target: string): boolean {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + escaped.replace(/\*\*/g, ".*").replace(/\*/g, ".*") + "$");
  return re.test(target);
}

/**
 * 规则 ↔ 一次具体调用是否命中。
 *
 * `!` 语义：`Bash(!git *)` = 「**除了** git *，其余都算命中」。
 * 注意它**不会**反过来匹配 `git *` —— 取反只作用于参数 glob，
 * 所以「先记住 git 都允许」和「再记住非 git 的也要问」是两条独立规则，不会互相覆盖。
 */
export function ruleMatches(
  rule: ParsedRule, toolName: string, tool: Tool, args: Record<string, unknown>,
): boolean {
  if (!ruleMatchesTool(rule.name, toolName)) return false;
  if (rule.arg === undefined) return true;          // 不带括号 → 整工具匹配
  const declared = tool.approvalRule?.(args) ?? null;
  if (declared === null) return false;              // 工具没声明参数模式 → 带括号的规则接不上
  const hit = argGlobMatches(rule.arg, declared);
  return rule.negated ? !hit : hit;
}

// ── 会话规则持久化 ────────────────────────────────────

/**
 * 持久化端口（结构型）—— **不是** `session/store.ts` 的 Store 类型。
 *
 * 为什么用结构型：依赖方向是 `session → tools`（tools 不能 import session），
 * 而 `Store` 的形状天然满足这两个方法，直接传进去即可。
 * 单测里给个普通对象也能跑，不需要真库。
 */
export interface RuleStorePort {
  getThread(id: string): { metadata?: Record<string, unknown> } | undefined;
  updateThread(id: string, patch: { metadata?: Record<string, unknown> }): void;
}

/** 线程 metadata 里放会话规则的键 */
export const SESSION_RULES_KEY = "approvalRules";

export interface SessionRule {
  /** 规则串，形如 `Bash(rm *)` */
  rule: string;
  /** 命中后给什么结论（「同意并记住」= allow；「拒绝并记住」= deny） */
  decision: "allow" | "deny";
  at: number;
}

/** 读线程上记住的规则；坏数据一律当没有（metadata 是 JSON 列，可能被手改坏） */
export function readSessionRules(store: RuleStorePort, threadId: string): SessionRule[] {
  const raw = store.getThread(threadId)?.metadata?.[SESSION_RULES_KEY];
  if (!Array.isArray(raw)) return [];
  const out: SessionRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Partial<SessionRule>;
    if (typeof r.rule !== "string") continue;
    if (r.decision !== "allow" && r.decision !== "deny") continue;
    out.push({ rule: r.rule, decision: r.decision, at: typeof r.at === "number" ? r.at : 0 });
  }
  return out;
}

/**
 * 工具这次调用对应的规则串。
 *
 * 三种情况分开处理，不能糊在一起：
 *  · 工具**没声明** approvalRule → 只能整工具匹配（返回工具名）——MCP / 用户自定义工具走这条；
 *  · 声明了但返回 undefined（如 Write 的路径越界解析不出来）→ **null，不允许落规则**。
 *    这里绝不能退回整工具匹配：那会把「只记住这个文件」悄悄放大成「这个工具随便用」；
 *  · 声明了且给了值 → `Tool(argGlob)`。
 */
function ruleFor(tool: Tool, args: Record<string, unknown>): string | null {
  if (!tool.approvalRule) return tool.name;
  let arg: unknown;
  try { arg = tool.approvalRule(args); } catch { arg = undefined; }
  return typeof arg === "string" && arg.trim() ? `${tool.name}(${arg})` : null;
}

/** 新规则集 = 老规则 + 本次；超上限丢**最老**的一条 */
export function nextRuleSet(rules: SessionRule[], rule: string, decision: "allow" | "deny", now = Date.now()): SessionRule[] {
  const next = [...rules.filter((r) => !(r.rule === rule && r.decision === decision)), { rule, decision, at: now }];
  return next.length > APPROVAL_SESSION_RULE_MAX ? next.slice(next.length - APPROVAL_SESSION_RULE_MAX) : next;
}

/**
 * 写入一条会话规则（只有在用户明确表示「记住」时才该被调用）。
 * 返回写入的规则串；写不了（工具没声明参数模式 / 线程不存在）返回 null。
 */
export function rememberSessionRule(
  store: RuleStorePort, threadId: string, toolName: string, args: Record<string, unknown>,
  tool: Tool, decision: "allow" | "deny" = "allow",
): string | null {
  const thread = store.getThread(threadId);
  if (!thread) return null;
  const rule = ruleFor(tool, args);
  if (!rule || rule.length > APPROVAL_RULE_MAX_CHARS || !parseRule(rule)) return null;
  const existing = readSessionRules(store, threadId);
  const metadata = { ...(thread.metadata ?? {}), [SESSION_RULES_KEY]: nextRuleSet(existing, rule, decision) };
  store.updateThread(threadId, { metadata });
  return rule;
}

/**
 * 重放已记住的规则：**后记的优先**（用户后来改主意，以最近的表态为准）。
 * 命中时返回规则结论，否则 null。
 */
export function sessionRuleDecision(
  store: RuleStorePort, threadId: string, toolName: string, args: Record<string, unknown>,
  tool: Tool, workdir: string,
): { decision: "allow" | "deny"; rule: string } | null {
  void workdir;                       // 参数位保留：规则串本身已由工具解析成绝对路径
  const rules = readSessionRules(store, threadId);
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!;
    const parsed = parseRule(r.rule);
    if (!parsed) continue;
    if (ruleMatches(parsed, toolName, tool, args)) return { decision: r.decision, rule: r.rule };
  }
  return null;
}
