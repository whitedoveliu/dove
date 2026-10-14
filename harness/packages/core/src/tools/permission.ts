/**
 * 权限模型：两根正交轴（沙箱 × 审批）—— **全应用唯一的定义处**
 *
 * 为什么拆轴（历史在这里说清，别再合回去）：
 *   以前只有一个 `permissionMode` 枚举（read-only / workspace-write / danger-full-access / auto），
 *   它被迫同时表达三件事 —— 能写哪、要不要问、裁不裁工具。结果是四档其实打在四个**不同**机制上
 *   （裁工具表 / 命令启发式 / 不弹窗 / LLM 分类器），用户建立不起"我现在会被问什么"的心智模型；
 *   更要命的是 danger-full-access 只关掉了审批，没关掉 Write/Edit 的工作区围栏 ——
 *   "完全权限"下模型写不了工作区外的文件，只好回头问用户（实测踩过，就是这一轮的起因）。
 *
 * 新模型（对齐 Codex 的 SandboxPolicy × AskForApproval、DSH 的 preset = {sandbox, approval} 命名绑定）：
 *   sandbox       能碰到什么：read-only / workspace-write / danger-full-access
 *   approval      要不要问：  never / risky（本地启发式+分类器）/ review（每条带命令的调用都过分类器）
 *   writableRoots 工作区之外**额外**允许写的目录（"这个项目要顺手改 ~/.kimi-code"就靠它）
 *
 * UI 上那四个档位只是给这两根轴**取个名字**（PERMISSION_PRESETS），不加第五档、不上开关矩阵。
 * 纪律：预设表只此一份 —— server 的 /api/permission-presets 从这里 re-export，面板只在拿不到主机数据时兜底。
 */
import * as path from "node:path";
import * as os from "node:os";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "never" | "risky" | "review";

export interface PermissionProfile {
  sandbox: SandboxMode;
  approval: ApprovalPolicy;
  writableRoots: string[];
}

/** 缺省档 = 工作区内修改：工作区可写，命令按风险逐条问 */
export const DEFAULT_PROFILE: PermissionProfile = { sandbox: "workspace-write", approval: "risky", writableRoots: [] };

/** 旧机值（一个枚举）+ 旧别名 —— 双读用，新写回不再产生 */
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access" | "auto";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "workspace-write";

const MODE_ALIASES: Record<string, PermissionMode> = {
  full: "danger-full-access", workspace: "workspace-write", readonly: "read-only",
};
const MODES: PermissionMode[] = ["read-only", "workspace-write", "danger-full-access", "auto"];

/**
 * 旧档位 → 新两轴。行为等价是刻意的：
 *   workspace-write / read-only / auto 与本轮之前**逐字节等价**（策略链顺序不变，只换了判定条件）；
 *   唯一的语义变更是 danger-full-access —— 越界写从「硬拒」变成「放行」，这正是要修的 bug。
 */
const LEGACY_PROFILE: Record<PermissionMode, PermissionProfile> = {
  "read-only": { sandbox: "read-only", approval: "never", writableRoots: [] },
  "workspace-write": { sandbox: "workspace-write", approval: "risky", writableRoots: [] },
  "danger-full-access": { sandbox: "danger-full-access", approval: "never", writableRoots: [] },
  "auto": { sandbox: "danger-full-access", approval: "review", writableRoots: [] },
};

export function normalizePermissionMode(v: unknown): PermissionMode {
  if (typeof v !== "string") return DEFAULT_PERMISSION_MODE;
  if (v in MODE_ALIASES) return MODE_ALIASES[v]!;
  return MODES.includes(v as PermissionMode) ? (v as PermissionMode) : DEFAULT_PERMISSION_MODE;
}

const SANDBOXES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const APPROVALS: ApprovalPolicy[] = ["never", "risky", "review"];

function rootsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim());
}

/**
 * 线程 metadata → profile（双读）。
 * 优先级：metadata.permission（新）→ metadata.permissionMode / metadata.readOnly（旧）→ 默认档。
 * 坏值一律退回默认 —— 权限解析绝不许因为脏数据变成"更宽"。
 */
export function normalizeProfile(metadata: Record<string, unknown> | null | undefined): PermissionProfile {
  const meta = metadata ?? {};
  const raw = meta.permission as Record<string, unknown> | undefined;
  if (raw && typeof raw === "object") {
    const sandbox = SANDBOXES.includes(raw.sandbox as SandboxMode) ? (raw.sandbox as SandboxMode) : DEFAULT_PROFILE.sandbox;
    const approval = APPROVALS.includes(raw.approval as ApprovalPolicy) ? (raw.approval as ApprovalPolicy) : DEFAULT_PROFILE.approval;
    return { sandbox, approval, writableRoots: rootsOf(raw.writableRoots) };
  }
  // 旧字段：readOnly 是更老的一位布尔，permissionMode 是上一版的枚举（可能还是 full/workspace/readonly 三个别名）
  const legacy = meta.readOnly === true ? "read-only" : normalizePermissionMode(meta.permissionMode);
  return { ...LEGACY_PROFILE[legacy] };
}

/** 反推一个最接近的旧档位值（老面板 / CLI 只认 mode 时用；新前端读 profile） */
export function legacyModeOf(p: PermissionProfile): PermissionMode {
  if (p.sandbox === "read-only") return "read-only";
  if (p.sandbox === "danger-full-access") return p.approval === "review" ? "auto" : "danger-full-access";
  return "workspace-write";
}

/** 完全权限/实验档要过一道确认闸（UI 用） */
export function requiresConfirm(mode: PermissionMode): boolean {
  return mode === "danger-full-access" || mode === "auto";
}

export interface PermissionPreset {
  value: PermissionMode;
  label: string;
  description: string;
  requiresConfirm: boolean;
  experimental: boolean;
  /** 这一档真正生效的两根轴 —— 前端不再自己推语义 */
  profile: PermissionProfile;
}

/**
 * 预设目录（主机下发）。
 * ⚠️ 描述文案必须与**实际行为**一致（P8：以前"工作区内修改"暗示了文件系统边界，而 Bash 根本没沙箱）：
 *    还没接入沙箱这件事写在描述里，别让档位名字说谎。
 */
export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    value: "read-only", label: "仅可查看", requiresConfirm: false, experimental: false,
    description: "只查不动：写文件、执行命令这些工具直接不给",
    profile: LEGACY_PROFILE["read-only"],
  },
  {
    value: "workspace-write", label: "工作区内修改", requiresConfirm: false, experimental: false,
    description: "工作区内直接改；越界（装依赖、访问工作区外）才问你。注意：命令仍在本机直接执行，沙箱尚未接入",
    profile: LEGACY_PROFILE["workspace-write"],
  },
  {
    value: "danger-full-access", label: "完全权限", requiresConfirm: true, experimental: false,
    description: "任何操作都不再询问，工作区外的文件也能直接改 —— 只在信任的任务上用",
    profile: LEGACY_PROFILE["danger-full-access"],
  },
  {
    value: "auto", label: "Auto review", requiresConfirm: true, experimental: true,
    description: "无沙箱运行，但每次工具调用前由模型审一遍；审查拒绝的转你批准",
    profile: LEGACY_PROFILE["auto"],
  },
];

// ── 路径判定 ──────────────────────────────────────────
const SEP = path.sep;

/**
 * 受保护的元数据目录：**写进去等于提权**（.git/hooks 是可执行代码、.codex/.agents 会进下一轮上下文）。
 * 只影响 Write/Edit 这一层（Bash 未接沙箱前绕得过去，见 docs/HANDOFF.md 的残留缺口）。
 */
export const READONLY_SUBPATH_NAMES = [".git", ".codex", ".agents"];

export function normalizeRoot(p: string): string {
  let abs = path.resolve(String(p ?? ""));
  while (abs.length > 1 && abs.endsWith(SEP)) abs = abs.slice(0, -1);
  return abs;
}

/** 可写根 = 工作区 + 额外可写目录（去重、解析成绝对路径） */
export function writableRootsOf(profile: PermissionProfile | undefined, workdir: string): string[] {
  const roots = [normalizeRoot(workdir)];
  for (const r of profile?.writableRoots ?? []) roots.push(normalizeRoot(r));
  return [...new Set(roots)];
}

/** 大小写不敏感（macOS / Windows 默认不敏感），且不能裸用 startsWith（"/a/bc" 不是 "/a/b" 的子路径） */
function within(target: string, dir: string): boolean {
  const a = target.toLowerCase();
  const b = dir.toLowerCase();
  return a === b || a.startsWith(b.endsWith(SEP) ? b : b + SEP);
}

export type WriteDecision =
  | { kind: "allow"; escalated: boolean }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; path: string; suggestedRoot: string };

/**
 * 一次写操作该放行 / 硬拒 / 问一句。
 *
 * 判定顺序（每条都有理由）：
 *   ① 只读沙箱 → 拒（工具本该被裁，走到这儿说明策略没接线，fail-closed）
 *   ② danger-full-access → 放行（escalated = 越界了才标 true，调用方据此发审计事件）。
 *      ⚠️ 这一条**必须在受保护子路径之前**：「完全权限」就是完全 —— 与 Codex/DSH 一致；
 *      受保护子路径是 workspace-write 那一档的护栏，不是全局禁令。
 *   ③ 可写根**之内**命中受保护元数据目录（.git/.codex/.agents）→ 硬拒，不可审批
 *   ④ 在任一可写根之内 → 放行
 *   ⑤ 越界 + 其它档位 → 问一句（建议的可写根 = 目标所在目录）
 */
export function decideWrite(abs: string, profile: PermissionProfile, workdir: string): WriteDecision {
  const target = path.resolve(abs);
  const roots = writableRootsOf(profile, workdir);
  if (profile.sandbox === "read-only") {
    return { kind: "deny", reason: "当前是「仅可查看」：写类工具本轮不可用" };
  }
  const insideRoot = roots.some((r) => within(target, r));
  if (profile.sandbox === "danger-full-access") return { kind: "allow", escalated: !insideRoot };
  if (insideRoot) {
    const protection = protectedSubpathHit(target, roots);
    if (protection) return { kind: "deny", reason: `受保护路径（${protection}）：写进去等于提权，工作区模式下不放行` };
    return { kind: "allow", escalated: false };
  }
  return { kind: "ask", path: target, suggestedRoot: path.dirname(target) };
}

/** 命中受保护元数据目录时返回目录名（只在**可写根之内**判定：根外的东西是"越界"那一档的事） */
export function protectedSubpathHit(abs: string, roots: string[]): string | undefined {
  for (const root of roots) {
    for (const name of READONLY_SUBPATH_NAMES) {
      if (within(abs, path.join(root, name))) return name;
    }
  }
  return undefined;
}

/** abs 是否落在 root 之内（含 root 自身；大小写不敏感）——给「命令里出现的路径」判定复用 */
export function isWithinPath(abs: string, root: string): boolean {
  return within(path.resolve(abs), normalizeRoot(root));
}

/**
 * 从命令串里**粗提**绝对路径 / `~/` 路径。
 *
 * ⚠️ 刻意只认明显的 token（不做 shell 解析）：引号、变量、heredoc 都能绕过去。
 * 它只服务于「把静默越界变成一次可见的提问」，**不是边界**（见 tool-exec 的 outsideWriteTarget）。
 */
export function extractPaths(cmd: string, workdir: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s"'`=(>:|;,])((?:~\/|\/)[^\s"'`|;><)]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const raw = m[1];
    if (!raw || raw === "/") continue;
    const abs = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
    out.push(path.resolve(abs));
  }
  return out;
}

/**
 * 凭证类**写**目标：放行即提权（写 authorized_keys = 种后门；写 credentials = 直接拿凭据）。
 *
 * ⚠️ 范围刻意极窄，且**不含配置目录**（~/.kimi-code/config.toml、~/.codex/**、~/.dove/**）——
 *    那些是正常干活的目标（实测的真实任务就是改 ~/.kimi-code/config.toml），
 *    OpenHarness 式黑名单硬拒会第一个挡掉正常用例。
 * 行为见 loop/tool-exec.ts 的 credential-write 策略：**必问一次，且不给「记住」**。
 * 这是"名单"不是"边界"：Bash heredoc 绕得过去；它的价值是提高误操作/提示注入的成本 + 给用户裁决点。
 */
export function isCredentialWriteTarget(abs: string): boolean {
  const home = os.homedir();
  const rel = path.relative(home, path.resolve(abs));
  if (!rel || path.isAbsolute(rel) || rel.startsWith("..")) return false;
  const segs = rel.split(SEP).map((s) => s.toLowerCase());
  const name = segs[segs.length - 1] ?? "";
  const parent = segs.slice(0, -1).join("/");
  if (parent === ".ssh") {
    if (name === "authorized_keys" || name === "authorized_keys2") return true;
    if (name.endsWith(".pub")) return false;                      // 公钥不是秘密，写它无害
    return name.startsWith("id_") || name.endsWith("_key");
  }
  if (rel.toLowerCase() === ".aws/credentials") return true;
  if (rel.toLowerCase() === ".config/gcloud/application_default_credentials.json") return true;
  if (parent === ".gnupg" || parent.startsWith(".gnupg/")) return true;
  return false;
}

/**
 * 本会话「同一形状不再重复打扰」的记忆（内存，进程级）。
 * 用户点过一次拒绝之后，模型换个写法再问第二次是纯噪音 —— DSH 有同款 note（same-mode 不重复弹）。
 * key 由调用方拼（线程 + 工具 + 参数形状），见 denialKey。
 */
export class DenialMemory {
  #denied = new Map<string, number>();
  #max = 200;
  deny(key: string): void {
    this.#denied.delete(key);
    this.#denied.set(key, Date.now());
    while (this.#denied.size > this.#max) {
      const oldest = this.#denied.keys().next().value;
      if (oldest === undefined) break;
      this.#denied.delete(oldest);
    }
  }
  has(key: string): boolean { return this.#denied.has(key); }
}

/** 拒绝记忆的 key：有参数形状就用形状，没有就退化成整个工具 */
export function denialKey(threadId: string, tool: string, argPattern?: string): string {
  return argPattern ? `${threadId}|${tool}(${argPattern})` : `${threadId}|${tool}`;
}
