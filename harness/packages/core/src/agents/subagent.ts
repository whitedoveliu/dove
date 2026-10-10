/**
 * 子代理运行时（M6 / T6.1–T6.2）
 * 形态：独立的小循环，复用主循环的 step 语义，但：
 *  - 自己的系统提示词（不问身份，只谈任务）
 *  - 工具白名单
 *  - 步数上限 100
 *  - **最后一步强制作答**：toolChoice="none" + 明确要求写最终答复
 *  - 过程通过回调广播回主线程
 */
import type { Provider, ChatMessage } from "../providers/types.ts";
import type { Tool } from "../tools/types.ts";
import { toWireSchemas } from "../tools/types.ts";
import { executeBatch } from "../loop/tool-exec.ts";
import type { ExecDeps } from "../loop/tool-exec.ts";
import { SUBAGENT_MAX_STEPS } from "../constants.ts";

export interface SubagentOptions {
  provider: Provider;
  model: string;
  prompt: string;
  label?: string;
  tools: Map<string, Tool>;
  /** 允许使用的工具名；缺省 = general-purpose 白名单 */
  allowedTools?: string[];
  execDeps: Omit<ExecDeps, "tools">;
  systemPrompt?: string;
  signal?: AbortSignal;
  /**
   * 取出「主代理中途追加的消息」（SendMessage 注入）。
   * 每个 step 开头取一次：取到的内容以 user 消息追加进对话，子代理下一步就能看到。
   * 注意：如果它正好在收尾那一步之后，可能来不及读 —— 调用方要在返回值里如实说明。
   */
  drainSteering?: () => string[];
  onText?: (delta: string) => void;
  /** 工具调用。**带参数** —— 只给名字的话界面上只能看到「subagent 调用了 Bash」，
   *  看不到它到底在跑什么命令（用户明确要求要看这个）。 */
  onToolUse?: (name: string, args: Record<string, unknown>) => void;
  /** 思考过程（provider 的 reasoning_content）。子代理是黑盒跑很久，
   *  不把思考流出来的话界面上只有一个转圈。 */
  onReasoning?: (delta: string) => void;
}

export interface SubagentResult {
  output: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number };
  endReason: string;
}

/** 默认白名单（T6.5）：通用目的子代理 */
export const GENERAL_PURPOSE_TOOLS = [
  "Bash", "Glob", "Grep", "Read", "Write", "Edit",
  "WebSearch", "WebFetch", "Skill", "TodoWrite",
];

const DEFAULT_SYSTEM = [
  "你是一个通用子代理，被主代理派来独立完成一个明确的任务。",
  "",
  "工作方式：",
  "- 直接动手，不要反问（你无法和用户对话）。",
  "- 用工具收集证据，不要凭印象下结论。",
  "- 完成后写一份**自包含**的最终答复：你做了什么、发现了什么（带具体文件路径与行号）、还有什么没做完。",
  "- 主代理看不到你的中间过程，只看到你的最终答复，所以要写全。",
  "- 不要编造任何你没实际验证过的结论。",
].join("\n");

export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const allow = new Set(opts.allowedTools ?? GENERAL_PURPOSE_TOOLS);
  const tools = new Map([...opts.tools].filter(([name]) => allow.has(name)));
  const wire = toWireSchemas([...tools.values()]);

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt ?? DEFAULT_SYSTEM },
    { role: "user", content: opts.prompt },
  ];

  let totalIn = 0, totalOut = 0, steps = 0;
  let endReason = "stop";

  for (let step = 1; step <= SUBAGENT_MAX_STEPS; step++) {
    steps = step;
    if (opts.signal?.aborted) { endReason = "aborted"; break; }

    // 主代理中途追加的消息（SendMessage）：下一步就能读到。
    // 放在 step 开头而不是工具执行之后 —— 无论它当时在跑工具还是在思考，下一轮都能拿到。
    if (opts.drainSteering) {
      for (const extra of opts.drainSteering()) {
        if (extra && extra.trim()) messages.push({ role: "user", content: extra });
      }
    }

    // 最后一步：禁止再调工具，强制写最终答复
    const lastStep = step >= SUBAGENT_MAX_STEPS;
    const stream = await opts.provider.stream({
      model: opts.model,
      messages,
      tools: lastStep ? [] : wire,
      toolChoice: lastStep ? "none" : "auto",
      signal: opts.signal,
      onTextDelta: (d) => opts.onText?.(d),
      onReasoningDelta: (d) => opts.onReasoning?.(d),
    });

    totalIn += stream.usage.inputTokens;
    totalOut += stream.usage.outputTokens;
    if (stream.error) { endReason = "error"; break; }

    messages.push({
      role: "assistant", content: stream.text || null,
      ...(stream.toolCalls.length ? { tool_calls: stream.toolCalls } : {}),
    });

    if (stream.toolCalls.length === 0) {
      endReason = stream.finishReason || "stop";
      break;
    }

    for (const c of stream.toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>; }
      catch { args = { _raw: c.function.arguments }; }
      opts.onToolUse?.(c.function.name, args);
    }
    const outcomes = await executeBatch(stream.toolCalls, { ...opts.execDeps, tools });
    for (const o of outcomes) {
      messages.push({
        role: "tool", tool_call_id: o.toolCallId, name: o.toolName,
        content: JSON.stringify(o.ok ? (o.output ?? {}) : { error: o.errorText ?? "失败" }),
      });
    }

    if (lastStep) {
      // ⚠️ 光 push 这条指令没用 —— 循环马上因 step 超限退出，模型**从来没机会回**。
      //    实测后果：子代理最后一步若是「工具调用 + 旁白」，那段旁白就成了它的"结论"，
      //    主代理收到的是「数据出来了，让我去拿收盘价」这种半句话。
      //    所以这里必须**再问一次**，把最终答复真正取回来。
      messages.push({ role: "user", content: "不要再调用任何工具。现在写你的最终答复：你做了什么、发现了什么、还有什么没做完。" });
      try {
        const fin = await opts.provider.stream({
          model: opts.model, messages, tools: [], toolChoice: "none",
          signal: opts.signal, onTextDelta: (d) => opts.onText?.(d),
        });
        totalIn += fin.usage.inputTokens;
        totalOut += fin.usage.outputTokens;
        if (fin.text) messages.push({ role: "assistant", content: fin.text });
      } catch { /* 拿不到就用上一轮的文本兜底 */ }
    }
  }

  // 取最后一条 assistant 文本作为答复
  const finalText = [...messages].reverse().find((m) => m.role === "assistant" && m.content)?.content;
  return {
    output: typeof finalText === "string" ? finalText : "(子代理没有产出最终答复)",
    steps, usage: { inputTokens: totalIn, outputTokens: totalOut }, endReason,
  };
}
