/**
 * 回合结局判定（问题 ④：回合在工具调用后直接结束，用户什么也看不到）
 *
 * 实测证据（~/.dove/logs/2026-10-09.jsonl，13:13:33 → 13:14:41）：
 *   turn_start → step_start ×11 → tool_call / tool_result ×N → turn_end endReason=tool_calls aborted=true
 *   **整轮没有一条 assistant_text**。用户那边就是「转了半天，什么都没发生」。
 *
 * 为什么会有这种结局：客户端断开 / 看门狗 abort 时，turn.ts 内层循环在**下一个 step 开头**
 *   就 `aborted = true; break` 了（见 loop/turn.ts 的 `if (deps.signal?.aborted)`），
 *   而 endReason 停在上一轮工具调用后写下的 `"tool_calls"` —— 于是「停在工具调用上」这个
 *   中间态变成了回合的最终结局，且没有任何东西告诉用户。
 *
 * 这里只做判定与文案：真正发事件、落库在 agent/runtime.ts。
 * 放独立文件的原因：runtime.ts 贴着 400 行硬约束，再塞就超。
 */
import type { Part } from "../session/types.ts";

/** 用户能看见的产出：非空 assistant 文本，或一个 AttemptCompletion（面板会渲染成完成卡片） */
export function hasVisibleOutcome(parts: readonly Part[]): boolean {
  for (const p of parts) {
    // 空的 text part（只有流式占位、没有内容）不算产出
    if (p.type === "text" && p.text.trim().length > 0) return true;
    // AttemptCompletion 的 summary 会渲染成完成卡片，算用户看得见的产出
    if (p.type.startsWith("tool-") && p.toolName === "AttemptCompletion") return true;
  }
  return false;
}

/**
 * 空回合的说明文案。
 * 必须写得**像人话**：这是用户唯一能看到的解释，不要出现 endReason 之类的内核黑话
 * （真实的机器原因会随 interrupted 事件一起给面板 / 日志）。
 *
 * ⚠️ 兜底分支原来直接 `endReason=${endReason}` 插进正文 —— 结果 endReason=error 时
 *    用户看到的是「模型这一轮没有产出答复（endReason=error）」。`endReason=` 是内核字段名，
 *    用户既不懂也不知道能拿它干什么；而 error / length 这两种**最常见**的失败都恰好
 *    走不到前面两个分支，所以那句话出现的频率还不低。这里把已知原因各给一句人话，
 *    只有真正没见过的原因才退回泛化措辞（机器可读的那份仍在事件的 endReason 字段里，没丢）。
 */
export function noOutputNote(endReason: string, aborted: boolean): string {
  const why = aborted
    ? "这一轮被中断了（连接断开或超时）"
    : endReason === "tool_calls"
      ? "模型在工具调用之后就结束了这一轮，没有留下答复"
      : endReason === "error"
        ? "这一轮出错了（模型或网络没能返回结果）"
        : endReason === "length"
          ? "这一轮被长度上限截断，没来得及写下答复"
          : "模型这一轮没有产出答复";
  return `⚠️ ${why}。你可以直接重试，或补充一句你想让我做什么。`;
}
