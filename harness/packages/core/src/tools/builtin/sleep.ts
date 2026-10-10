/**
 * Sleep —— 等待一段时间
 * 用途：等后台任务 / 等构建 / 等限流恢复，避免空转轮询把上下文刷满。
 * 上限 60 秒：再长应该用 BashOutput 的 block 或 run_in_background，而不是干等。
 */
import { defineTool, S } from "../types.ts";
import { guarded, optNum } from "./util.ts";

export const MAX_SLEEP_SECONDS = 60;

export const SleepTool = defineTool({
  name: "Sleep",
  description:
    "等待指定秒数（上限 " + MAX_SLEEP_SECONDS + " 秒）。等后台任务、等构建、等限流恢复时用；"
    + "比反复空转查询省 token。等待期间可以随时被打断。",
  parameters: S.obj({
    seconds: S.num("等待秒数（1–" + MAX_SLEEP_SECONDS + "，超出按上限算）"),
    reason: S.str("为什么要等（一句话，写给用户看）"),
  }, ["seconds"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const requested = optNum(input, "seconds") ?? 1;
    const seconds = Math.max(0, Math.min(MAX_SLEEP_SECONDS, requested));
    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000);
      const onAbort = (): void => { clearTimeout(timer); resolve(); };
      if (ctx.signal?.aborted) onAbort();
      else ctx.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const aborted = ctx.signal?.aborted === true;
    return {
      slept_seconds: seconds,
      requested_seconds: requested,
      capped: requested > MAX_SLEEP_SECONDS,
      interrupted: aborted,
      elapsed_ms: Date.now() - startedAt,
      at: new Date().toISOString(),
      note: aborted ? "等待被中断（用户停止或回合取消）。" : undefined,
    };
  }),
});
