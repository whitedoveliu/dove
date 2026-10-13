/**
 * 子代理运行时（M6 / T6.1–T6.2）
 * 形态：独立的小循环，复用主循环的 step 语义，但：
 *  - 自己的系统提示词（不问身份，只谈任务）
 *  - 工具表**由调用方按角色 + 父线程策略裁剪好**传进来（这里不再套一层默认白名单）
 *  - 步数上限 100
 *  - **最后一步强制作答**：toolChoice="none" + 明确要求写最终答复
 *  - 过程通过回调广播回主线程
 *
 * 续跑（resume）：带上 `history`（上一次的完整消息序列）就接着跑，新指令追加为一条 user 消息。
 * 为什么放在这里而不是上层：只有这里知道「系统提示词 + 历史 + 新 user」的拼法，
 * 上层负责决定**谁**有资格续跑（作用域缓存 / 归属校验，见 agent/subagent-host.ts）。
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
  /**
   * 工具表。**可以不传** —— 不传就是「只会思考、不会动手」的子代理：
   * 目标验收评估器就是这么跑的（它只对着给定证据打分，不能改产物、也不能自己去"找"证据）。
   */
  tools?: Map<string, Tool>;
  /**
   * 再按名单收一次（可选）。
   * ⚠️ 缺省 = **不再收**（用传进来的工具表）。以前这里缺省套的是「通用子代理白名单」，
   *    那是「一个白名单管所有子代理」的旧设计 —— 现在裁剪由角色表决定（agents/roles.ts），
   *    再套一层会让角色白名单被静默改掉（比如 ["*"] 的角色拿不到任何工具）。
   */
  allowedTools?: string[];
  /** 不传 tools 时也不需要它：没有任何调用会被执行 */
  execDeps?: Omit<ExecDeps, "tools">;
  /**
   * 续跑：上一次跑到结束时的完整消息序列（含 system 与最终答复）。
   * 传了它就不再重建 system/user 头，直接把 prompt 作为新的 user 消息追加在后面 ——
   * 同一段历史继续跑，前缀缓存也还能命中。
   */
  history?: ChatMessage[];
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
   *  看不到它到底在跑什么命令。 */
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
  /**
   * 这一轮跑完时的完整消息序列（system + 全部 user/assistant/tool）。
   * 用途有二：① 续跑要接着它跑；② 父级记账（token 用量之外还能看到它到底跑了多少步）。
   * 不落库（子代理的过程另有 SubagentTranscript 落盘），只是回传给调用方。
   */
  messages: ChatMessage[];
}

/**
 * 默认白名单已经搬走了 —— 现在每个角色有自己的工具白名单，单一来源在
 * `tools/builtin/task.ts` 的 SUBAGENT_ROLES（上层从 agents/roles.ts 取）。
 * 这里刻意**不留**一份「通用白名单」：留了就会和角色表漂移，而漂移的表现是
 * 「模型以为能用的工具实际被裁掉」，只能靠人肉对照两处名单才能发现。
 */

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
  // 工具表由调用方按「父线程策略 ∩ 角色白名单」裁好；allowedTools 只做**显式**再收一次。
  const allow = opts.allowedTools ? new Set(opts.allowedTools) : undefined;
  const tools = new Map([...(opts.tools ?? new Map<string, Tool>())].filter(([name]) => !allow || allow.has(name)));
  const wire = toWireSchemas([...tools.values()]);

  // 续跑：接着上一次的消息序列跑（这条 prompt 作为新的 user 消息追加在后面）。
  // 注意要**复制**数组：下面会往里 push，直接改缓存里那份会把续跑前的历史也污染掉。
  const messages: ChatMessage[] = opts.history && opts.history.length > 0
    ? [...opts.history, { role: "user", content: opts.prompt }]
    : [
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
    const outcomes = opts.execDeps
      ? await executeBatch(stream.toolCalls, { ...opts.execDeps, tools })
      // 没有 execDeps = 这个子代理本来就没有工具权限（评估器）：真收到调用也不能执行，
      // 如实回一条错误让它自己改口，别装作执行成功了。
      : stream.toolCalls.map((c) => ({
        toolCallId: c.id, toolName: c.function.name, input: {}, ok: false,
        errorText: "这个子代理没有工具权限，不能调用工具。", durationMs: 0,
      }));
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
    steps, usage: { inputTokens: totalIn, outputTokens: totalOut }, endReason, messages,
  };
}
