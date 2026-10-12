/**
 * 采集健康度（Fix 5）—— 以前探测/整图失败都是**完全静默**的：
 * 只 return { skipped }，调用方 void 掉，日志一条没有。
 * 于是「权限被收回 / 磁盘满 / sips 坏掉」时对外依然是 available: true，
 * 没有任何计数或日志能看出采集已经死了。
 * 这里集中记数（probes / stored / deduped / failed）与最近一次成功/失败，
 * 并由 ActivityRecorder.stats() 摊进 /api/activity/status。
 */

export interface CaptureError { at: number; message: string }
export interface CaptureCounters { probes: number; stored: number; deduped: number; failed: number }

export interface CaptureHealthSnapshot {
  /** 最近一次成功落库的快照时间（毫秒）；还没有过就是 null */
  lastOkAt: number | null;
  /** 最近一次真实失败（时间 + 原因）；没失败过就是 null */
  lastError: CaptureError | null;
  counters: CaptureCounters;
}

export class CaptureHealth {
  lastOkAt: number | null = null;
  lastError: CaptureError | null = null;
  counters: CaptureCounters = { probes: 0, stored: 0, deduped: 0, failed: 0 };

  probe(): void { this.counters.probes++; }
  dedupe(): void { this.counters.deduped++; }
  stored(at: number): void { this.counters.stored++; this.lastOkAt = at; }
  fail(at: number, message: string): void { this.counters.failed++; this.lastError = { at, message: message.slice(0, 200) }; }

  snapshot(): CaptureHealthSnapshot {
    return {
      lastOkAt: this.lastOkAt,
      lastError: this.lastError ? { ...this.lastError } : null,
      counters: { ...this.counters },
    };
  }
}

/**
 * 记一次真实采集失败：计数 + lastError + **warn 日志**（这条日志就是以前缺的那条），
 * 并返回结构化 skipped。日志本身失败也不许反过来打断采集。
 */
export function captureFailed(
  health: CaptureHealth, at: number, what: string, error: string | undefined,
  log?: (level: "warn", msg: string, data?: Record<string, unknown>) => void,
): { skipped: string } {
  const message = error && error.trim() ? error.trim() : "未知错误";
  health.fail(at, message);
  try { log?.("warn", what, { error: message.slice(0, 200) }); } catch { /* ignore */ }
  return { skipped: `${what}：${message}` };
}
