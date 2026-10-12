/**
 * Agent 循环（T1.2 / T1.3）
 * 双层：内层 step（streamText + 工具往返）≤100；外层 turn（四道闸门）≤10。
 */
import type { Provider, ChatMessage, ToolCallPayload, StreamResult } from "../providers/types.ts";
import type { Usage } from "../session/types.ts";
import type { Tool } from "../tools/types.ts";
import { toWireSchemas } from "../tools/types.ts";
import { executeBatch } from "./tool-exec.ts";
import type { ExecDeps, ExecOutcome } from "./tool-exec.ts";
import { evaluateGates, newCounters, bumpCounter } from "./gates.ts";
import type { GateId } from "./gates.ts";
import { STEP_CAP, STEP_CAP_COMPACTION_BONUS } from "../constants.ts";
// mt / 记忆块注入只有这一个正确实现（第一条 text part），循环层不再自己拼字符串
import { injectIntoLastUser } from "../context/tail-context.ts";

export interface TurnHooks {
  onText?: (delta: string, full: string) => void;
  onReasoning?: (delta: string, full: string) => void;
  onToolStart?: (call: ToolCallPayload) => void;
  onToolResult?: (o: ExecOutcome) => void;
  /**
   * **每个 step 的 provider 流结束时**调用（不论成功失败）。
   * 为什么必须按 step 而不是按轮：调用方的流式缓冲（脱敏回看窗口）会把短回复整段扣住，
   * 只在整轮结束才放的话，多个 step 的文本会被拼成一条、且日志里看不到中间说过什么
   * （见 agent/text-collector.ts 顶部）。
   */
  onStreamEnd?: () => void;
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
  /** 跳过完成守卫（心跳回合：它的"完成"就是 HEARTBEAT_OK，见 loop/gates.ts 的说明） */
  skipCompletionGuard?: boolean;
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

/**
 * 把 mt 与记忆块 prepend 到最后一条 user 消息（缓存友好的关键）
 *
 * ⚠️ 一律转交 context/tail-context.ts 的 injectIntoLastUser —— 它是「贴进最后一条 user
 *    消息的**第一个 text part**」的唯一正确实现。这里原来自己又写了一遍字符串拼接版，
 *    而且对块状 content 走 `JSON.stringify`：一旦最后一条 user 消息带 image_url 块
 *    （ReadImage 之后的历史就是这种形态），注入的就不是「前缀 + 原文」，
 *    而是把整条消息**压平成一串假 JSON 文本**，图片和文本边界全丢 —— provider 侧要么
 *    直接报非法消息，要么模型看到一堆它没说过的话。
 */
export function applyTailContext(messages: ChatMessage[], mt?: string, memories?: string): ChatMessage[] {
  return injectIntoLastUser(messages, mt ?? "", memories);
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
  let sawPermissionDenied = false;
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
      // ⚠️ provider.stream **会抛**：fetch 的 DNS/连接错误、流中途断开、
      //    abort 都不是「返回一个带 error 的结果」，而是直接 reject
      //    （见 providers/openai-compat.ts —— 只有 HTTP 非 2xx 才走 stream.error）。
      //    这里不兜住的话异常会穿过整个 runTurn 冒到 AgentRuntime.run，
      //    于是**收尾那一段全被跳过**：没有 turn_end、没有 interrupted、没有落库的
      //    assistant 消息、也没有回合后的记忆写入 —— 用户那边就是「发了消息什么都没发生」
      //    （清单 B⑫：回合结束是唯一的收尾触发点，异常路径不能绕过它）。
      let stream: StreamResult;
      try {
        stream = await deps.provider.stream({
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
      } catch (e) {
        stream = {
          text: "", reasoning: "", toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          finishReason: "error",
          error: e instanceof Error ? e.message : String(e),
        };
      }

      totalUsage = mergeUsage(totalUsage, {
        inputTokens: stream.usage.inputTokens, outputTokens: stream.usage.outputTokens,
        cacheReadTokens: stream.usage.cacheReadTokens, cacheWriteTokens: stream.usage.cacheWriteTokens,
      });
      if (stream.text) sawVisibleOutput = true;
      // 先放尾巴再判错误：流失败也要把已经吐出来的那部分交给调用方
      deps.hooks?.onStreamEnd?.();
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
        // ⚠️ 这一行以前是 `sawPermissionDenied: false`（写死在 evaluateGates 的入参里），
        //    于是闸门③「权限续跑」**永远不可能开火** —— gates.ts 里那条提醒、
        //    PERMISSION_CONTINUE_RETRIES 计数器、permission-continue 这个 GateId 全是死代码。
        //    实测后果：用户拒绝一次操作后，模型不会被告知（它只看到工具结果里那句
        //    "[权限] 用户拒绝了这次操作"），于是要么原地重试同一条命令、要么直接收尾，
        //    用户看到的就是一个**没有任何产出的回合**。
        if (o.denied) sawPermissionDenied = true;
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
      steerPending: deps.steerPending(), sawAttemptCompletion, sawPermissionDenied,
      finishReason: endReason, toolCallCount: pairs.calls, toolResultCount: pairs.results,
      sawVisibleOutput, hadToolCalls, aborted,
      skipCompletionGuard: deps.skipCompletionGuard,
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
      // 提醒过一次就清标记（和完成守卫一样）：否则拒绝是同一次、提醒会重复发，
      // 反而把模型绕进「我是不是又踩了什么」的自我怀疑里。
      if (decision.gate === "permission-continue") sawPermissionDenied = false;
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
