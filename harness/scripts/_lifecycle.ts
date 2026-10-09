/**
 * CLI / 冒烟脚本的统一收尾。
 *
 * 为什么需要它：**bootstrap() 起的服务会吊住事件循环** ——
 * 输入监听的子进程 stdin 管道、cron/heartbeat 的定时器、undici 的连接池，
 * 任何一样都能让 Node 永远不退出。
 *
 * 实测（2026-10-06）：任务本体 13.6s / 42.6s / 82s / 353.6s，
 * 但进程分别挂了 2491s / 3893s / 4442s / 3893s，最后全被 SIGKILL（退出码 137）。
 * **任何用 CLI 跑任务的脚本或 CI 都会永久挂住。**
 *
 * 修法：任务结束后必须调 svc.shutdown()。实测调了之后 3 秒内自然退出，
 * 不需要 process.exit() 兜底 —— 但留着它更保险（比如某个第三方库又开了新句柄）。
 */
import type { Services } from "../packages/server/src/bootstrap.ts";

/** 收尾：关服务 + 兜底强退。可重复调用。 */
export function finish(svc: { shutdown(): void } | null | undefined, code = 0): void {
  try { svc?.shutdown(); } catch { /* 关闭失败不能影响退出码 */ }
  // 给关闭流程一点时间把子进程 / 定时器清干净，然后兜底强退。
  // unref 之后这个定时器本身不会阻止退出。
  const t = setTimeout(() => process.exit(code), 2000);
  t.unref?.();
  process.exitCode = code;
}

/** 包一层：无论成功失败都保证收尾 */
export async function withServices(
  bootstrapFn: () => Promise<Services>,
  fn: (svc: Services) => Promise<number | void>,
): Promise<never> {
  let svc: Services | null = null;
  let code = 0;
  try {
    svc = await bootstrapFn();
    const r = await fn(svc);
    if (typeof r === "number") code = r;
  } catch (e) {
    console.error("\n运行失败:", e instanceof Error ? (e.stack ?? e.message) : e);
    code = 1;
  } finally {
    finish(svc, code);
  }
  process.exit(code);
}
