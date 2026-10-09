/**
 * Agent 循环（T1.2 / T1.3）
 * 双层：内层 step（streamText + 工具往返）≤100；外层 turn（四道闸门）≤10。
 */
import type { Provider, ChatMessage, ToolCallPayload } from "../providers/types.ts";
import type { Usage } from "../session/types.ts";
import type { Tool } from "../tools/types.ts";
import { toWireSchemas } from "../tools/types.ts";
import { executeBatch } from "./tool-exec.ts";
import type { ExecDeps, ExecOutcome } from "./tool-exec.ts";
import { evaluateGates, newCounters, bumpCounter } from "./gates.ts";
import type { GateId } from "./gates.ts";
import { STEP_CAP, STEP_CAP_COMPACTION_BONUS } from "../constants.ts";

export interface TurnHooks {
  onText?: (delta: string, full: string) => void;
  onReasoning?: (delta: string, full: string) => void;
  onToolStart?: (call: ToolCallPayload) => void;
  onToolResult?: (o: ExecOutcome) => void;
  onAssistantMessage?: (text: string, calls: ToolCallPayload[]) => void;
  /** 每个 step 结束后的真实用量（用于压缩阈值估算） */
  onUsage?: (u: { inputTokens: number; outputTokens: number; cacheReadTokens: number }) => void;
}

export interface TurnDeps {
  provider: Provider;
  model: string;
  systemPrompt: string;
  dualSystem?: boolean;
  history: ChatMessage[];
  userText: string;
  tailContext?: string;
  memoriesBlock?: string;
  /** **全部**可用工具（含未激活的）—— 执行时要能找到任何一个 */
  tools: Map<string, Tool>;
  /**
   * 当前该上 wire 的工具名（每次取，不是快照）。
   *
   * ⚠️ 必须是函数：ToolSearch 会在**一轮中途**激活新工具，而它的描述承诺
   *    「同一步里检索完就能直接调用」。传数组的话是快照，激活要等下一轮才生效，
   *    那句承诺就是假的。实测这个字段以前**根本没人传** —— 声明了、用了，
   *    但 runtime 没接（又一处「建好没接」）。
   */
  activeToolNames?: () => string[];
  execDeps: Omit<ExecDeps, "tools">;
  onBeforeStep?: (state: { step: number; messages: ChatMessage[] }) => Promise<{ messages: ChatMessage[]; compacted: boolean } | void>;
  steerPending: () => boolean;
  drainSteering: () => string[];
  signal?: AbortSignal;
  maxSteps?: number;
  isSubagent?: boolean;
  hooks?: TurnHooks;
}

export interface TurnResult {
  messages: ChatMessage[];
  usage: Usage;
  endReason: string;
  gates: { gate: GateId; turn: number }[];
  steps: number;
  sawVisibleOutput: boolean;
  aborted: boolean;
}

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** 把 mt 与记忆块 prepend 到最后一条 user 消息（缓存友好的关键） */
export function applyTailContext(messages: ChatMessage[], mt?: string, memories?: string): ChatMessage[] {
  if (!mt && !memories) return messages;
  const out = [...messages];
  let idx = -1;
  for (let i = out.length - 1; i >= 0; i--) if (out[i]!.role === "user") { idx = i; break; }
  if (idx < 0) return out;
  const m = out[idx]!;
  const prefix = [mt ? `[Context: ${mt}]` : "", memories ?? ""].filter(Boolean).join("\n\n");
  const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  out[idx] = { ...m, content: prefix + "\n\n" + body };
  return out;
}

/** 系统提示词 → provider 消息（支持双 system 块，供 Anthropic 类 provider 吃缓存） */
export function buildWireMessages(systemPrompt: string, messages: ChatMessage[], dualSystem?: boolean): ChatMessage[] {
  if (dualSystem) {
    const i = systemPrompt.search(/^SYSTEM INFO/m);
    if (i > 0) {
      return [
        { role: "system", content: systemPrompt.slice(0, i) },
        { role: "system", content: systemPrompt.slice(i) },
        ...messages,
      ];
    }
  }
  return [{ role: "system", content: systemPrompt }, ...messages];
}

export async function runTurn(deps: TurnDeps): Promise<TurnResult> {
  const counters = newCounters();
  const gateLog: { gate: GateId; turn: number }[] = [];
  const messages: ChatMessage[] = applyTailContext(
    [...deps.history, { role: "user", content: deps.userText }], deps.tailContext, deps.memoriesBlock,
  );

  /** 每步重算：中途激活的工具要能立刻上 wire */
  const buildWireTools = () => {
    const names = deps.activeToolNames?.();
    const list = names
      ? [...deps.tools.values()].filter((t) => names.includes(t.name))
      : [...deps.tools.values()];
    return toWireSchemas(list);
  };
  const stepCap = deps.maxSteps ?? STEP_CAP;

  let totalUsage = ZERO;
  let totalSteps = 0;
  let sawVisibleOutput = false;
  let sawAttemptCompletion = false;
  let aborted = false;
  let endReason = "stop";
  let hadToolCalls = false;

  for (let turn = 1; ; turn++) {
    let folded = false;
    let reminded = false;

    for (let step = 1; step <= stepCap + STEP_CAP_COMPACTION_BONUS; step++) {
      if (deps.signal?.aborted) { aborted = true; break; }
      totalSteps++;

      if (deps.onBeforeStep) {
        const r = await deps.onBeforeStep({ step, messages });
        if (r && r.messages) { messages.length = 0; messages.push(...r.messages); }
      }

      let fullText = "";
      let fullReasoning = "";
      const stream = await deps.provider.stream({
        model: deps.model,
        messages: buildWireMessages(deps.systemPrompt, messages, deps.dualSystem),
        tools: buildWireTools(),
        toolChoice: deps.isSubagent && step >= stepCap ? "none" : "auto",
        signal: deps.signal,
        reasoningEffort: "high",
        onUsage: (u) => deps.hooks?.onUsage?.(u),
        onTextDelta: (d) => { fullText += d; deps.hooks?.onText?.(d, fullText); },
        onReasoningDelta: (d) => { fullReasoning += d; deps.hooks?.onReasoning?.(d, fullReasoning); },
      });

      totalUsage = mergeUsage(totalUsage, {
        inputTokens: stream.usage.inputTokens, outputTokens: stream.usage.outputTokens,
        cacheReadTokens: stream.usage.cacheReadTokens, cacheWriteTokens: stream.usage.cacheWriteTokens,
      });
      if (stream.text) sawVisibleOutput = true;
      if (stream.error) { endReason = "error"; break; }

      deps.hooks?.onAssistantMessage?.(stream.text, stream.toolCalls);
      messages.push({
        role: "assistant", content: stream.text || null,
        ...(stream.toolCalls.length > 0 ? { tool_calls: stream.toolCalls } : {}),
      });

      if (stream.toolCalls.length === 0) { endReason = stream.finishReason || "stop"; break; }
      hadToolCalls = true;

      for (const c of stream.toolCalls) deps.hooks?.onToolStart?.(c);

      const outcomes = await executeBatch(stream.toolCalls, { ...deps.execDeps, tools: deps.tools });
      for (const o of outcomes) {
        if (o.toolName === "AttemptCompletion") sawAttemptCompletion = true;
        deps.hooks?.onToolResult?.(o);
        messages.push({
          role: "tool", tool_call_id: o.toolCallId, name: o.toolName,
          content: JSON.stringify(o.ok ? (o.output ?? {}) : { error: o.errorText ?? "unknown error" }),
        });
      }
      endReason = stream.finishReason || "tool_calls";
      if (step === stepCap) { endReason = "length"; break; }

      if (deps.steerPending()) {
        for (const q of deps.drainSteering()) messages.push({ role: "user", content: q });
        endReason = "steering";
        break;
      }
    }

    if (aborted || endReason === "error") break;

    const pairs = countToolPairs(messages);
    const decision = evaluateGates({
      steerPending: deps.steerPending(), sawAttemptCompletion, sawPermissionDenied: false,
      finishReason: endReason, toolCallCount: pairs.calls, toolResultCount: pairs.results,
      sawVisibleOutput, hadToolCalls, aborted,
    }, counters);

    if (!decision.gate) break;
    gateLog.push({ gate: decision.gate, turn });
    bumpCounter(counters, decision.gate);

    if (decision.gate === "steering") {
      for (const q of deps.drainSteering()) messages.push({ role: "user", content: q });
      folded = true;
    } else if (decision.reminder) {
      messages.push({ role: "user", content: decision.reminder });
      reminded = true;
      sawAttemptCompletion = false;
    }
    if (!folded && !reminded) break;
  }

  return { messages, usage: totalUsage, endReason, gates: gateLog, steps: totalSteps, sawVisibleOutput, aborted };
}

function countToolPairs(messages: ChatMessage[]): { calls: number; results: number } {
  let calls = 0, results = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) calls += m.tool_calls.length;
    if (m.role === "tool") results++;
  }
  return { calls, results };
}
