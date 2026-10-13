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
import { evaluateGates, newCounters, bumpCounter, planToolCalls, countToolPairs } from "./gates.ts";
import type { GateId } from "./gates.ts";
import type { HookRegistry } from "./hooks.ts";
import { createRepeatBreaker } from "./repeat-breaker.ts";
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
  /**
   * **中途以 role:"user" 注入进 wire 的消息**（steering 插话 / 闸门提醒）。
   * 调用方必须把它落进 parts（injection part）—— 不落的话下一轮重建时这一段凭空消失，
   * 缓存前缀从那里断掉，整个「工具之后 / 提醒之后」的历史按全价重付（见 agent/wire-history.ts）。
   */
  onUserInjection?: (text: string) => void;
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
  /** provider 开流之前（每步）的最后一个决策点；`inFlight` = 本轮循环自己推的那些消息（身份集合，见 runTurn 的说明） */
  onBeforeStep?: (state: { step: number; messages: ChatMessage[]; inFlight: ReadonlySet<ChatMessage> }) => Promise<{ messages: ChatMessage[]; compacted: boolean } | void>;
  steerPending: () => boolean;
  drainSteering: () => string[];
  signal?: AbortSignal;
  maxSteps?: number;
  isSubagent?: boolean;
  /** 跳过完成守卫（心跳回合：它的"完成"就是 HEARTBEAT_OK，见 loop/gates.ts 的说明） */
  skipCompletionGuard?: boolean;
  hooks?: TurnHooks;
  /**
   * 有序 hook 注册表（loop/hooks.ts）—— 横切特性的**唯一挂载点**：新能力注册进来，
   * 不再往这个循环里插行、也不再往 gates.ts 里排优先级。
   *
   * ⚠️ 字段名为什么是 `hookRegistry` 而不是 `hooks`：`hooks` 已经被上面的 TurnHooks 占着，
   *    而 TurnHooks 是 agent/runtime.ts 依赖的**流式回调**（onText/onToolStart/onUserInjection…），
   *    语义与这里的「可否决的事件总线」完全不同。两套并存是**刻意的过渡**：
   *    直接改名会让 runtime.ts 全部编译不过，而它正听的是「每个 token / 每个结果」的细粒度事件，
   *    那些事件本来也不该走 veto 通道（流已经推给用户了，否决策略毫无意义）。
   *    等 runtime 把 TurnHooks 的调用点全部迁到 fire() 之后，再谈合并的事。
   *
   * 不传就是「一条监听者都没有」：下面每个 `await hookRegistry?.fire(...)` 都退化成 await undefined，
   * 循环行为与接钩子之前逐字相同（这也是加它不动任何既有测试的原因）。
   */
  hookRegistry?: HookRegistry;
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
  /** 有序 hook 注册表（可选；不传时下面每个 fire 都是 await undefined，行为与之前逐字相同） */
  const hookReg = deps.hookRegistry;
  /** 重复调用断路器：按 (工具 + 规范化参数) 分级干预，每轮 turnStart 重置（见 loop/repeat-breaker.ts） */
  const breaker = createRepeatBreaker();
  const messages: ChatMessage[] = applyTailContext(
    [...deps.history, { role: "user", content: deps.userText }], deps.tailContext, deps.memoriesBlock,
  );
  /**
   * 本轮**循环自己推进去**的消息（assistant / tool / 中途注入的 user）—— 按**对象身份**记，不按下标。
   *
   * ⚠️ 为什么不能按下标（例如「本轮 user 消息的下标 + 1」）：压缩会把 messages **就地**换成压缩结果，
   *    前缀整体前移，同一个消息的下标当场变小 —— 同一轮里压第二次时按下标算出来的边界就错位，
   *    剥不干净的那一段会被写进检查点，下一轮 wire 上同一段出现两遍（本条就是为此立的）。
   *    身份不受重排 / 删减影响：压缩保留下来的消息仍是同一批对象（见 agent/history-assembly.ts 的说明）。
   * 用途：agent/runtime.ts 用它剥检查点 —— 这些消息回合末才落库，留在检查点里就是重发。
   */
  const inFlight = new Set<ChatMessage>();
  const pushMsg = (m: ChatMessage): void => { messages.push(m); inFlight.add(m); };

  /**
   * 每步重算：中途激活的工具要能立刻上 wire。
   *
   * ⚠️ 顺序必须照 **activeToolNames() 自己的顺序**取（registry 的 activeTools()：
   *    CORE + SYSTEM + 激活顺序 + EXTERNAL，天生只追加），**不能**拿这份名单当过滤条件
   *    去筛 deps.tools —— deps.tools 是 bootstrap 按目录序（CORE → SYSTEM → ON_DEMAND →
   *    EXTERNAL）建的 Map，而按需工具的目录序**不是**激活序：目录里靠前的 WebSearch
   *    晚于 TerminalSend 激活时，过滤出来的数组会把它**插在**终端工具前面，
   *    后面每一个元素的 schema 都往后挪一格 —— provider 的前缀缓存从第一个变化的
   *    token 起全部失效，且模型、界面都看不见，只有账单看得见（tools/registry.ts 顶部纪律）。
   *    取哪些工具**不变**（还是与 names 的交集），变的只是先后。
   */
  const buildWireTools = () => {
    const names = deps.activeToolNames?.();
    if (!names) return toWireSchemas([...deps.tools.values()]);
    const list: Tool[] = [];
    for (const name of names) {
      const tool = deps.tools.get(name);
      if (tool) list.push(tool);
    }
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

  /**
   * turnEnd：每一轮（外层 turn —— 「四道闸门 + 计数器」的那一层）收尾时开一次。
   * endReason / steps / gates 都按**这一刻**的真实值给：闸门拉起的续跑轮之后再开一次，
   * 所以监听者看到的是「这一轮是怎么结束的」，不是整段 runTurn 的最终结论。
   */
  const fireTurnEnd = async (turn: number): Promise<void> => {
    await hookReg?.fire("turnEnd", {
      turn, endReason, steps: totalSteps, gates: [...gateLog], aborted, messages,
    });
  };

  for (let turn = 1; ; turn++) {
    let folded = false;
    let reminded = false;

    /**
     * turnStart：**每一轮**都开（包括被闸门拉起的续跑轮）——外层的 turn 才是共享计数器的
     * 那一层，每轮都是不共享计数的独立回合，所以：
     *   ① 重复断路器在这里 reset（新的一轮不该继承上一轮的重复次数）；
     *   ② 监听者按 payload.turn 分辨这是第几轮，别把它当成「一次用户回合」。
     */
    const turnStart = await hookReg?.fire("turnStart", { turn, messages, model: deps.model });
    breaker.reset();

    if (turnStart?.vetoed) {
      // 非工具事件上的 veto 只有一种说得通的含义：别再跑了
      endReason = "hook-veto";
      await fireTurnEnd(turn);
      break;
    }

    for (let step = 1; step <= stepCap + STEP_CAP_COMPACTION_BONUS; step++) {
      if (deps.signal?.aborted) { aborted = true; break; }
      totalSteps++;

      if (deps.onBeforeStep) {
        const r = await deps.onBeforeStep({ step, messages, inFlight: new Set(inFlight) });
        if (r && r.messages) { messages.length = 0; messages.push(...r.messages); }
      }

      // beforeStep：与 onBeforeStep 同一时机（provider 开流之前），但排在它**之后** ——
      // onBeforeStep 可能压缩历史，监听者该看到真正要上 wire 的那份 messages。
      const stepHook = await hookReg?.fire("beforeStep", { turn, step, messages });
      if (stepHook?.vetoed) { endReason = "hook-veto"; break; }

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
      pushMsg({
        role: "assistant", content: stream.text || null,
        ...(stream.toolCalls.length > 0 ? { tool_calls: stream.toolCalls } : {}),
      });

      if (stream.toolCalls.length === 0) {
        endReason = stream.finishReason || "stop";
        // 纯文本步也结束了一次「步」：stepEnd 照开（payload 里 toolCalls 为空）
        const se = await hookReg?.fire("stepEnd", {
          turn, step, messages, toolCalls: [], finishReason: endReason,
        });
        if (se?.vetoed) endReason = "hook-veto";
        break;
      }
      hadToolCalls = true;

      for (const c of stream.toolCalls) deps.hooks?.onToolStart?.(c);

      // 执行前的护栏预判：beforeToolExecute 的 veto + 重复断路器的分级干预。
      // 为什么在这里合成「没执行」的结果、为什么合成结果也要走 onToolResult —— 见 gates.ts 的 planToolCalls。
      const plan = await planToolCalls({ calls: stream.toolCalls, breaker, hookRegistry: hookReg, turn, step });

      // 结果必须按**模型给出的调用顺序**回填（tool-exec.ts 的纪律）：只把该跑的交给 executeBatch
      //（只读并行 / 写类独占的调度原样保留），再按 id 合并回原下标。
      const outcomes: ExecOutcome[] = plan.pre.slice() as ExecOutcome[];
      const at = new Map<string, number>(stream.toolCalls.map((c, i) => [c.id, i]));
      if (plan.runnable.length > 0) {
        const done = await executeBatch(plan.runnable, { ...deps.execDeps, tools: deps.tools });
        for (const o of done) outcomes[at.get(o.toolCallId)!] = o;
      }

      const runnableIds = new Set(plan.runnable.map((c) => c.id));
      for (let i = 0; i < outcomes.length; i++) {
        const o = outcomes[i]!;
        if (o.toolName === "AttemptCompletion") sawAttemptCompletion = true;
        // ⚠️ 这一行以前是 `sawPermissionDenied: false`（写死在 evaluateGates 的入参里），
        //    于是闸门③「权限续跑」**永远不可能开火** —— gates.ts 里那条提醒、
        //    PERMISSION_CONTINUE_RETRIES 计数器、permission-continue 这个 GateId 全是死代码。
        //    实测后果：用户拒绝一次操作后，模型不会被告知（它只看到工具结果里那句
        //    "[权限] 用户拒绝了这次操作"），于是要么原地重试同一条命令、要么直接收尾，
        //    用户看到的就是一个**没有任何产出的回合**。
        if (o.denied) sawPermissionDenied = true;
        deps.hooks?.onToolResult?.(o);
        pushMsg({
          role: "tool", tool_call_id: o.toolCallId, name: o.toolName,
          content: JSON.stringify(o.ok ? (o.output ?? {}) : { error: o.errorText ?? "unknown error" }),
        });
        // 真跑过的调用才发 afterToolExecute：被拦下的那次什么都没执行（合成结果已经配对、入库），
        // 对监听者谎报「执行完了」有害无益。
        if (runnableIds.has(o.toolCallId)) {
          await hookReg?.fire("afterToolExecute", {
            turn, step, call: stream.toolCalls[i], toolName: o.toolName, outcome: o,
          });
        }
      }

      // 重复提醒走**既有的中途注入通道**（user 消息 + onUserInjection → injection part），
      // 位置必须在**这一步的工具结果之后**：插在 assistant(tool_calls) 与 tool 结果之间是
      // 非法消息（provider 会整条请求拒掉），下一轮重建时位置也对不上，前缀缓存断在这里。
      for (const text of plan.reminders) {
        pushMsg({ role: "user", content: text });
        deps.hooks?.onUserInjection?.(text);
      }

      endReason = stream.finishReason || "tool_calls";

      const stepEnd = await hookReg?.fire("stepEnd", {
        turn, step, messages, toolCalls: stream.toolCalls, finishReason: endReason,
      });
      if (step === stepCap) { endReason = "length"; break; }

      if (deps.steerPending()) {
        for (const q of deps.drainSteering()) {
          pushMsg({ role: "user", content: q });
          deps.hooks?.onUserInjection?.(q);
        }
        endReason = "steering";
        break;
      }
      // 优先级：人（steering，上面那条） > 重复护栏终止整轮 > stepEnd 的 hook 否决
      if (plan.fail) { endReason = "repeat-breaker"; break; }
      if (stepEnd?.vetoed) { endReason = "hook-veto"; break; }
    }

    if (aborted || endReason === "error") { await fireTurnEnd(turn); break; }

    const pairs = countToolPairs(messages);
    const decision = evaluateGates({
      steerPending: deps.steerPending(), sawAttemptCompletion, sawPermissionDenied,
      finishReason: endReason, toolCallCount: pairs.calls, toolResultCount: pairs.results,
      sawVisibleOutput, hadToolCalls, aborted,
      skipCompletionGuard: deps.skipCompletionGuard,
    }, counters);

    if (!decision.gate) { await fireTurnEnd(turn); break; }
    gateLog.push({ gate: decision.gate, turn });
    bumpCounter(counters, decision.gate);

    if (decision.gate === "steering") {
      for (const q of deps.drainSteering()) {
        pushMsg({ role: "user", content: q });
        deps.hooks?.onUserInjection?.(q);
      }
      folded = true;
    } else if (decision.reminder) {
      pushMsg({ role: "user", content: decision.reminder });
      deps.hooks?.onUserInjection?.(decision.reminder);
      reminded = true;
      // 提醒过一次就清标记（和完成守卫一样）：否则拒绝是同一次、提醒会重复发，
      // 反而把模型绕进「我是不是又踩了什么」的自我怀疑里。
      if (decision.gate === "permission-continue") sawPermissionDenied = false;
      sawAttemptCompletion = false;
    }
    if (!folded && !reminded) { await fireTurnEnd(turn); break; }
    // 这一轮以闸门续跑收尾：turnEnd 照开（轮 = 外层那一层），但下一轮的 turnStart 紧接着就来
    await fireTurnEnd(turn);
  }

  return { messages, usage: totalUsage, endReason, gates: gateLog, steps: totalSteps, sawVisibleOutput, aborted };
}
