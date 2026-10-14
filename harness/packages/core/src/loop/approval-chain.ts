/**
 * 审批策略链（从 loop/tool-exec.ts 拆出来：那边贴着 400 行上限）
 *
 * 有序策略表：**第一条给出结论的生效**（返回 undefined 交给下一条）。顺序即语义，别随手重排：
 *   凭证必问 → 会话规则 → 已拒形状 → 写边界 → never 放行 → review 分类器 → always 问 → 本地启发式 → 无需审批档 → 兜底问。
 *
 * 两条轴（tools/permission.ts）落在哪：
 *   · 审批轴（never / risky / review）→ never 放行 / review 分类器两条；
 *   · 沙箱轴（能写哪）→ write-scope。它故意**放在审批链上**而不是塞进工具内部：
 *     ① 批准走的是既有 ask 通道，「同意并记住」白捡（finishApproval 落 `Write(<path>)` 会话规则，
 *        下一轮由 session-rule 命中，所以 session-rule 必须排在它前面）；
 *     ② 排在 never 放行**之前**：完全权限下的越界写也要先留一条 tool:write-escalated 审计事件。
 *   · credential-write 排在最前：凭证写入是唯一一条「所有档位都要问一次」的写侧边界。
 */
import { resolve } from "node:path";
import type { Tool, ToolAccesses, ApprovalRequest, ApprovalResponse } from "../tools/types.ts";
import { classifyLocally, buildApprovalRequest, mightModifyFiles, stripHarmlessRedirects } from "../tools/approval.ts";
import {
  decideWrite, writableRootsOf, isCredentialWriteTarget, extractPaths, isWithinPath,
  denialKey, DEFAULT_PROFILE, type PermissionProfile,
} from "../tools/permission.ts";
import { rememberSessionRule, sessionRuleDecision, type ApprovalResponseRemembered } from "../tools/rule-pattern.ts";
import type { ExecDeps } from "./tool-exec.ts";

/** 一条策略给出的结论；undefined = 交给下一条 */
export type Decision = "allow" | "deny" | "ask";
export interface Outcome {
  decision: Decision;
  /** ask 时用；不给则按「允许执行 <工具>？」构造 */
  request?: ApprovalRequest;
  /** deny 时给用户看的理由 */
  denyReason?: string;
  /** 命中的规则串（会话规则才有），只用于诊断 */
  rule?: string;
}
export interface StrategyCtx { tool: Tool; args: Record<string, unknown>; toolCallId: string; deps: ExecDeps }
export interface Strategy {
  /** 策略名会进 tool:approval_decision 事件 —— 线上排查「这条为什么没问」全靠它 */
  name: string;
  run: (c: StrategyCtx) => Outcome | undefined | Promise<Outcome | undefined>;
}

/** 工具自带的兜底请求（always 档、以及分类器缺席时的保守请求） */
function toolRequest(tool: Tool, args: Record<string, unknown>): ApprovalRequest {
  return { title: `允许执行 ${tool.name}？`, message: JSON.stringify(args).slice(0, 600), riskLevel: "medium" };
}
/** 从参数里取命令串（Bash 用 command，个别工具用 cmd） */
function commandOf(args: Record<string, unknown>): string {
  return typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
}

/** 工具自报的参数形状（会话规则 / 拒绝记忆共用）；算不出来 = undefined（退化成整工具粒度） */
function argPatternOf(tool: Tool, args: Record<string, unknown>): string | undefined {
  try {
    const s = tool.approvalRule?.(args);
    return typeof s === "string" && s.trim() ? s.trim() : undefined;
  } catch { return undefined; }
}

/**
 * 这次调用声明要写的**绝对路径**（来自工具自己的 `accesses`）。
 * 返回 null = 该工具没声明写路径（MCP / 用户自定义 / 声明成 all）→ **不参与**路径策略，保持既有行为。
 */
function declaredWritePaths(tool: Tool, args: Record<string, unknown>, workdir: string): string[] | null {
  if (!tool.accesses) return null;
  let decl: ToolAccesses;
  try { decl = tool.accesses(args, workdir); } catch { return null; }
  if (!decl || decl.kind !== "paths" || !Array.isArray(decl.paths)) return null;
  const out: string[] = [];
  for (const a of decl.paths) {
    if (!a || typeof a.path !== "string" || !a.path) continue;
    if (a.operation !== "write" && a.operation !== "readwrite") continue;
    try { out.push(resolve(workdir, a.path)); } catch { /* 解析不了 → 不参与 */ }
  }
  return out;
}

/** 越界写审批的请求体（面板拿 metadata 展示目标路径与"记住"的含义） */
function writeScopeRequest(paths: string[], roots: string[]): ApprovalRequest {
  return {
    title: "允许写入工作区之外的文件吗？",
    message: [
      "这次调用要写这些**可写根之外**的路径：", "", paths.slice(0, 5).join("\n"), "",
      "当前可写根：", roots.join("\n"), "",
      "允许一次 = 只放行这一次；勾「同意并记住」= 本会话放行同一形状（逐字路径）。",
      "想永久放宽：在权限弹层里把目标目录加进「额外可写目录」。",
    ].join("\n"),
    riskLevel: "medium",
    metadata: { kind: "write-scope", path: paths[0], paths },
  };
}

/**
 * 命令里**明确出现**的越界写目标 / 凭证目标 → 提级成一次提问。
 *
 * ⚠️ **这不是边界**：shell 解析不可能严谨（heredoc、变量展开、`sh -c` 都绕得过去），
 *    它只把"静默越界"变成一次可见的裁决点。真正的边界要么是工具层（Write/Edit 的 write-scope），
 *    要么是 OS 沙箱（尚未接入，见 docs/HANDOFF.md 的残留缺口）。
 */
function outsideWriteTarget(cmd: string, workdir: string, profile?: PermissionProfile): string | undefined {
  if (!mightModifyFiles(cmd)) return undefined;
  const scan = stripHarmlessRedirects(cmd);        // `2>/dev/null` 这类无害重定向不算写目标
  const roots = writableRootsOf(profile, workdir);
  for (const p of extractPaths(scan, workdir)) {
    if (p.startsWith("/dev/")) continue;
    if (isCredentialWriteTarget(p)) return p;
    if (!roots.some((r) => isWithinPath(p, r))) return p;
  }
  return undefined;
}

let strategiesCache: Strategy[] | undefined;
function approvalStrategies(): Strategy[] {
  return (strategiesCache ??= [
    {
      name: "credential-write",
      // ⚠️ 排在**第一条**（在 approval=never 之前）：凭证类写目标**任何档位都要问一次，且不给「记住」**。
      // 这是刻意的例外 —— 放行即提权（写 authorized_keys = 种后门）。范围极窄
      // （见 permission.ts 的 isCredentialWriteTarget）：**不含** ~/.kimi-code/config.toml 之类的配置目录。
      // 为什么不是硬拒：硬拒让模型学不到发生了什么、只能换条路试探；必问一次有明确的用户裁决点。
      run: (c) => {
        const paths = declaredWritePaths(c.tool, c.args, c.deps.ctxBase.workdir);
        const hit = paths?.find((p) => isCredentialWriteTarget(p));
        if (!hit) return undefined;
        return {
          decision: "ask",
          request: {
            title: "允许写这个凭证文件吗？",
            message: [
              "目标：" + hit, "",
              "写这里等于给本机提权（登录凭据 / 授权密钥）。",
              "这条**没有「同意并记住」**：每次都要单独确认一次。",
            ].join("\n"),
            riskLevel: "high",
            metadata: { kind: "credential-write", path: hit, noRemember: true },
          },
        };
      },
    },
    {
      name: "session-rule",    // 命中用户明确记住的规则（按「后记的优先」倒序匹配）
      // ⚠️ 必须排在 write-scope **之前**：越界写弹一次、勾「记住」之后，下一轮由这条直接放行 ——
      //    顺序反了就会每次都问（「同意并记住」当场变成一句谎话）。
      run: (c) => {
        if (!c.deps.store) return undefined;
        const hit = sessionRuleDecision(c.deps.store, c.deps.ctxBase.threadId, c.tool.name, c.args, c.tool, c.deps.ctxBase.workdir);
        return hit ? { decision: hit.decision, rule: hit.rule, denyReason: "会话规则" } : undefined;
      },
    },
    {
      name: "denied-shape",
      // 同一形状在本会话被**用户**拒过一次 → 不再重复打扰（DSH 的同档不重复弹）。
      // 位置：session-rule 之后（用户明确 allow 的规则优先）、write-scope 之前（否则第二次还会弹）。
      run: (c) => {
        const mem = c.deps.denials;
        if (!mem) return undefined;
        const key = denialKey(c.deps.ctxBase.threadId, c.tool.name, argPatternOf(c.tool, c.args));
        return mem.has(key) ? { decision: "deny", denyReason: "同一形状在本会话已被你拒绝过（不重复询问）" } : undefined;
      },
    },    {
      name: "write-scope",
      // 沙箱轴：可写根之外 → 问一句；只对**声明了写路径**的工具生效（Write/Edit，见各自的 accesses），
      // MCP / 用户自定义工具不参与，保持既有行为。
      // 批准之后 finishApproval 会落一条 `Write(<path>)` 会话规则，下一轮由 session-rule 命中。
      run: (c) => {
        const paths = declaredWritePaths(c.tool, c.args, c.deps.ctxBase.workdir);
        if (!paths || paths.length === 0) return undefined;
        const workdir = c.deps.ctxBase.workdir;
        const profile = c.deps.permission ?? DEFAULT_PROFILE;
        const roots = writableRootsOf(profile, workdir);
        const outside: string[] = [];
        const escalated: string[] = [];
        for (const p of paths) {
          const d = decideWrite(p, profile, workdir);
          if (d.kind === "deny") return { decision: "deny", denyReason: d.reason };
          if (d.kind === "ask") outside.push(p);
          else if (d.escalated) escalated.push(p);
        }
        if (outside.length > 0) return { decision: "ask", request: writeScopeRequest(outside, roots) };
        // 完全权限下的越界放行留一条审计痕迹：真的放行 ≠ 没人知道（对齐 Codex 的 sandbox_requested/actual 诚实度）
        if (escalated.length > 0) {
          try {
            c.deps.ctxBase.emit("tool:write-escalated", {
              toolCallId: c.toolCallId, tool: c.tool.name, paths: escalated, sandbox: profile.sandbox,
            });
          } catch { /* 事件发不出去不影响放行 */ }
        }
        return undefined;
      },
    },
    {
      name: "approval-never-allow",
      // 审批轴 = never：任何操作都不再问。**排在这里**（write-scope 之后）是刻意的：
      // 完全权限下的越界写要先经过 write-scope 留一条审计事件，再放行；否则那条事件永远发不出来。
      run: (c) => (c.deps.permission?.approval === "never" ? { decision: "allow" } : undefined),
    },
    {
      name: "approval-review-classifier",
      // approval=review（实验档 Auto review）：无沙箱，但**每次**调用都让分类器审一遍 —— 不看本地启发式。
      // ⚠️ fail-safe 而不是 fail-open：没有分类器 / 分类器抛错时**要审批**。这里踩过 —— 分类器
      //    只声明没实现，而当时的写法是「没有分类器就放行」：auto 表面说「每次审一遍」、实际**全放行**。
      run: async (c) => {
        if (c.deps.permission?.approval !== "review") return undefined;
        const cmd = commandOf(c.args);
        if (!cmd) return { decision: "allow" };      // 没有命令串（写类工具）→ review 管不着，放行（写侧另有 write-scope）
        let req: ApprovalRequest | null = null;
        if (c.deps.classifier) {
          try { req = await c.deps.classifier(cmd); }
          catch { req = buildApprovalRequest(cmd, "medium"); }   // 分类器炸了 → 保守要权限
        } else req = buildApprovalRequest(cmd, "medium");         // 没接分类器 → 保守要权限
        if (!req) return { decision: "allow" };      // 分类器明确说没问题 → 放行
        return { decision: "ask", request: req };
      },
    },
    {
      name: "tool-always-ask",
      // 工具声明了 always → 每次都问。⚠️ 必须走 onApprovalNeeded 通知：通知不发出去，界面/日志
      // 就不知道有人在等，只能干等到 DOVE_APPROVAL_TIMEOUT_MS（5 分钟）自动拒绝 —— 用户从没看见弹窗。
      run: (c) => (c.tool.approval === "always" ? { decision: "ask", request: toolRequest(c.tool, c.args) } : undefined),
    },
    {
      name: "local-heuristic",
      // 只对**带命令**的工具做本地规则；没有命令串就交棒给下一条
      // （这是 Write/Edit 的必经之路：它们标了 heuristic 却只接受 file_path/content，没有 command）。
      run: async (c) => {
        if (c.tool.approval !== "heuristic") return undefined;
        const cmd = commandOf(c.args);
        if (!cmd) return undefined;
        const local = classifyLocally(cmd, c.deps.ctxBase.workdir);
        if (local === "safe" || local === "low") {
          // 可见性补丁（**不是边界**）：命令里明确出现的越界写目标 / 凭证目标 → 提级成一次提问。
          // 见 outsideWriteTarget 的说明：shell 解析不可能严谨，它只把"静默越界"变成一个可见的裁决点。
          const bump = outsideWriteTarget(cmd, c.deps.ctxBase.workdir, c.deps.permission);
          if (bump) {
            const credential = isCredentialWriteTarget(bump);
            const req = buildApprovalRequest(cmd, credential ? "high" : "medium");
            req.message += "\n\n命中：命令里出现的" + (credential ? "凭证路径" : "工作区外写目标") + "：\n" + bump;
            req.metadata = { kind: "outside-write", path: bump, noRemember: credential };
            return { decision: "ask", request: req };
          }
          return { decision: "allow" };
        }
        let req: ApprovalRequest | null = local === "medium" ? buildApprovalRequest(cmd, "medium") : null;
        if (!req && c.deps.classifier) { try { req = await c.deps.classifier(cmd); } catch { req = null; } }
        if (!req) req = buildApprovalRequest(cmd, "medium");   // 兜底：一律要权限
        return { decision: "ask", request: req };
      },
    },
    {
      name: "tool-never-allow",
      // never 档：工具自己声明「不用审批」→ 放行。
      // ⚠️ 第二半（heuristic 却没有 command）**是刻意保留**的既有行为，别改成「问一句」：Write/Edit
      //    的档位就是 heuristic、参数里从来没有 command，写侧安全靠 write-scope 策略 + 工具内的
      //    resolveWritablePath 兜底（见 builtin/util.ts 的踩坑史），不靠审批。这里必须放行，否则每个 Write/Edit 都弹窗。
      run: (c) => {
        if (c.tool.approval === "never") return { decision: "allow" };
        // 只对**声明了参数模式**的工具放行（Write/Edit 的参数语义由它自己写清）；没声明 approvalRule
        // 的启发式工具可能把命令塞在任意字段里 —— 那些一律不放行，避免变成「猜不到就放」。
        if (c.tool.approval === "heuristic" && c.tool.approvalRule && !commandOf(c.args)) return { decision: "allow" };
        return undefined;
      },
    },
    { name: "fallback-ask", run: (c) => ({ decision: "ask", request: toolRequest(c.tool, c.args) }) },
  ]);
}

/** 决定 → 最终回执；ask 在这里变成真正的阻塞等待 */
async function finishApproval(out: Outcome, c: StrategyCtx): Promise<{ needed: boolean; request?: ApprovalRequest; response?: ApprovalResponse }> {
  if (out.decision === "allow") return { needed: false };
  if (out.decision === "deny") {
    // 保持 agent/pending.ts 的既有措辞类别：reason="user" → 工具结果说「用户拒绝了这次操作」。
    // 区别只是这次拒绝是**记住的规则**代用户表的态，denyReason 写清是哪条规则。
    return { needed: true, response: { approved: false, reason: "user", decision: "deny", denyReason: out.denyReason } };
  }
  const req = out.request ?? toolRequest(c.tool, c.args);
  c.deps.onApprovalNeeded?.(c.toolCallId, req);
  const response = await c.deps.resolveApproval(req, c.toolCallId);
  // 「同意并记住」→ 写会话规则。**只在 remember === true 时写**：默认不问自记 = 偷偷扩大授权。
  if ((response as ApprovalResponseRemembered).remember === true && c.deps.store) {
    rememberSessionRule(c.deps.store, c.deps.ctxBase.threadId, c.tool.name, c.args, c.tool, response.approved ? "allow" : "deny");
  }
  // 拒绝要记进「同一形状不再重复弹」——只记**用户自己的拒绝**：超时 / 无窗口不是用户的决定，不该改变后续行为。
  if (!response.approved && response.reason === "user" && c.deps.denials) {
    c.deps.denials.deny(denialKey(c.deps.ctxBase.threadId, c.tool.name, argPatternOf(c.tool, c.args)));
  }
  return { needed: true, request: req, response };
}

export async function decideApproval(
  tool: Tool, args: Record<string, unknown>, deps: ExecDeps, toolCallId: string,
): Promise<{ needed: boolean; request?: ApprovalRequest; response?: ApprovalResponse }> {
  const ctx: StrategyCtx = { tool, args, toolCallId, deps };
  let out: Outcome | undefined; let by = "";
  for (const s of approvalStrategies()) { out = await s.run(ctx); if (out) { by = s.name; break; } }   // 第一条给出结论的生效
  // 诊断：这条是**哪条策略**决定的。以前这里是一串 if，出问题只能靠 printf 猜。
  try {
    deps.ctxBase.emit("tool:approval_decision", { toolCallId, tool: tool.name, by, decision: out?.decision ?? "allow", rule: out?.rule });
  } catch { /* 事件发不出去不影响审批本身 */ }
  return await finishApproval(out ?? { decision: "ask" }, ctx);
}
