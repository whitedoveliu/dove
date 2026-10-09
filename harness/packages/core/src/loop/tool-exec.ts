/**
 * 工具执行管线（T3.3）
 * 顺序：调用修复 → 审批 → 执行（超时 + try/catch）→ 输出预算 → 回执
 * 纪律：**任何工具内部抛错都不许冒泡到主循环** —— 一律变成结构化结果交还模型。
 *       工具结果**按模型给出的调用顺序**回填（不是完成顺序）。
 */
import type { Tool, ToolContext, ApprovalRequest, ApprovalResponse, ToolServices } from "../tools/types.ts";
import { applyBudget } from "../tools/budget.ts";
import { repairToolCall } from "../tools/repair-call.ts";
import { classifyLocally, buildApprovalRequest } from "../tools/approval.ts";
import type { ToolCallPayload } from "../providers/types.ts";
import { TOOL_TIMEOUT_MS } from "../constants.ts";

export interface ExecOutcome {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  ok: boolean;
  output?: unknown;
  errorText?: string;
  spillPath?: string;
  denied?: boolean;
  durationMs: number;
  /** 审批事件（如果有） */
  approval?: { request: ApprovalRequest; response: ApprovalResponse };
}

export type ApprovalResolver = (req: ApprovalRequest, toolCallId: string) => Promise<ApprovalResponse>;
export type ClassifierFn = (cmd: string) => Promise<ApprovalRequest | null>;

export interface ExecDeps {
  tools: Map<string, Tool>;
  ctxBase: Omit<ToolContext, "toolCallId" | "requestApproval">;
  resolveApproval: ApprovalResolver;
  /** LLM 审批分类器（可选；缺失时保守要权限） */
  classifier?: ClassifierFn;
  timeoutMs?: number;
  onApprovalNeeded?: (toolCallId: string, req: ApprovalRequest) => void;
  /** 权限模式：full 时不审批任何操作（见 tools/approval.ts 的 PermissionMode） */
  permissionMode?: import("../tools/approval.ts").PermissionMode;
}

/** 把 provider 给的原始调用修复成可用调用；修不了返回 null */
export function prepareCall(
  call: ToolCallPayload,
  tools: Map<string, Tool>,
): { tool: Tool; name: string; args: Record<string, unknown>; repaired: boolean } | { error: string } {
  const rawArgs = (() => {
    try { return JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; }
    catch { return null; }
  })();

  const fixed = repairToolCall(call.function.name, rawArgs ?? call.function.arguments, [...tools.values()]);
  if (!fixed) {
    return { error: `未知工具 "${call.function.name}"，且无法模糊匹配到已有工具。可用工具：${[...tools.keys()].slice(0, 20).join(", ")}` };
  }
  const tool = tools.get(fixed.name);
  if (!tool) return { error: `工具 ${fixed.name} 不存在` };
  return { tool, name: fixed.name, args: fixed.args ?? {}, repaired: fixed.name !== call.function.name };
}

async function decideApproval(
  tool: Tool, args: Record<string, unknown>, deps: ExecDeps, toolCallId: string,
): Promise<{ needed: boolean; request?: ApprovalRequest; response?: ApprovalResponse }> {
  // ── 权限模式优先于单工具策略 ──────────────────────────
  // full = 用户明确授权「任何操作都不审批」→ 直接放行。
  // readonly 由 applyThreadPolicy 在更早的地方把写类工具**从工具表里裁掉**，
  // 走不到这里；这里再兜一层是防御性的。
  // 完全权限：用户明确授权「任何操作都不审批」→ 直接放行
  if (deps.permissionMode === "danger-full-access") return { needed: false };
  // auto（实验）：无沙箱，但**每次**调用都让分类器审一遍 —— 不看本地启发式。
  //
  // ⚠️ fail-safe 而不是 fail-open：没有分类器时**要审批**，不能放行。
  //    这里踩过 —— classifier 在 AgentServices 里声明了但从没实现，
  //    于是 deps.classifier 恒为 undefined，而当时的写法是「没有分类器就放行」，
  //    结果 auto 模式表面说「每次审一遍」、实际是**全部放行**，且毫无提示。
  if (deps.permissionMode === "auto") {
    const cmd = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
    if (!cmd) return { needed: false };
    let req: ApprovalRequest | null = null;
    if (deps.classifier) {
      try { req = await deps.classifier(cmd); }
      catch { req = buildApprovalRequest(cmd, "medium"); }   // 分类器炸了 → 保守要权限
    } else {
      req = buildApprovalRequest(cmd, "medium");             // 没接分类器 → 保守要权限
    }
    if (!req) return { needed: false };      // 分类器明确说没问题 → 放行
    deps.onApprovalNeeded?.(toolCallId, req);
    return { needed: true, request: req, response: await deps.resolveApproval(req, toolCallId) };
  }

  if (tool.approval === "never") return { needed: false };

  if (tool.approval === "always") {
    const req: ApprovalRequest = { title: `允许执行 ${tool.name}？`, message: JSON.stringify(args).slice(0, 600), riskLevel: "medium" };
    return { needed: true, request: req, response: await deps.resolveApproval(req, toolCallId) };
  }

  // heuristic：只对 Bash 类命令做本地规则
  const cmd = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
  if (!cmd) return { needed: false };

  const local = classifyLocally(cmd, deps.ctxBase.workdir);
  if (local === "safe") return { needed: false };
  if (local === "low") return { needed: false };

  let req: ApprovalRequest | null = local === "medium" ? buildApprovalRequest(cmd, "medium") : null;
  if (!req && deps.classifier) {
    try { req = await deps.classifier(cmd); } catch { req = null; }
  }
  if (!req) req = buildApprovalRequest(cmd, "medium");   // 兜底：一律要权限

  deps.onApprovalNeeded?.(toolCallId, req);
  return { needed: true, request: req, response: await deps.resolveApproval(req, toolCallId) };
}

export async function executeOne(
  call: ToolCallPayload,
  deps: ExecDeps,
): Promise<ExecOutcome> {
  const started = Date.now();
  const prepared = prepareCall(call, deps.tools);
  if ("error" in prepared) {
    return { toolCallId: call.id, toolName: call.function.name, input: {}, ok: false, errorText: prepared.error, durationMs: Date.now() - started };
  }
  const { tool, name, args } = prepared;

  // 审批
  const appr = await decideApproval(tool, args, deps, call.id);
  if (appr.needed && !appr.response?.approved) {
    const reason = appr.response?.reason;
    const text = reason === "timeout"
      ? "[权限] 审批超时，命令已被自动拒绝。"
      : reason === "no-window"
        ? "[权限] 没有可用的审批窗口，命令已被自动拒绝。"
        : "[权限] 用户拒绝了这次操作。";
    return {
      toolCallId: call.id, toolName: name, input: args, ok: false, errorText: text, denied: true,
      durationMs: Date.now() - started, approval: appr.request ? { request: appr.request, response: appr.response! } : undefined,
    };
  }

  // 执行（超时 + 全包 try/catch）
  const ctx: ToolContext = { ...deps.ctxBase, toolCallId: call.id, requestApproval: deps.resolveApproval };
  const timeout = tool.timeoutMs ?? deps.timeoutMs ?? TOOL_TIMEOUT_MS;
  let raw: unknown; let ok = true; let errorText: string | undefined;
  try {
    raw = await Promise.race([
      tool.execute(args, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`工具 ${name} 超时（${timeout}ms）`)), timeout)),
    ]);
  } catch (e) {
    ok = false;
    errorText = e instanceof Error ? e.message : String(e);
    raw = { error: errorText };
  }

  // 输出预算
  let output = raw; let spillPath: string | undefined;
  try {
    const b = await applyBudget(tool, raw, deps.ctxBase.workdir, call.id);
    output = b.result; spillPath = b.spillPath;
  } catch (e) {
    output = { error: "输出预算处理失败：" + (e instanceof Error ? e.message : String(e)) };
  }

  return {
    toolCallId: call.id, toolName: name, input: args, ok, output, errorText, spillPath,
    durationMs: Date.now() - started,
    approval: appr.request && appr.response ? { request: appr.request, response: appr.response } : undefined,
  };
}

/** 并行执行：只读工具并行，写类独占；结果按传入顺序返回（= 模型给出的调用顺序） */
export async function executeBatch(calls: ToolCallPayload[], deps: ExecDeps): Promise<ExecOutcome[]> {
  const results = new Array<ExecOutcome>(calls.length);
  const parallel: number[] = [];
  let exclusiveChain: Promise<void> = Promise.resolve();

  calls.forEach((call, i) => {
    const prep = prepareCall(call, deps.tools);
    const safe = !("error" in prep) && prep.tool.concurrencySafe;
    if (safe) { parallel.push(i); return; }
    exclusiveChain = exclusiveChain.then(async () => { results[i] = await executeOne(call, deps); });
  });

  if (parallel.length > 0) {
    const settled = await Promise.all(parallel.map((i) => executeOne(calls[i]!, deps)));
    parallel.forEach((idx, k) => { results[idx] = settled[k]!; });
  }
  await exclusiveChain;
  return results;
}
