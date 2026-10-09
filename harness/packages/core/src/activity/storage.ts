/**
 * 快照存储与轮转（T7.7）
 * 目录：<configDir>/activity/snapshots/<YYYY-MM-DD>/<id>.jpg
 * 分级：hot（1 天内）→ warm（7 天内，重压 1280×720 q40）→ cold（30 天内，640×360 q30）→ 删除
 * 总量：上限 10GB，超限从最老删到 7.5GB；30 分钟巡检一次。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { convert, imageSize } from "./capture.ts";
import { DAY_MS, dateKey, type ActivityStore } from "./store.ts";

export const TIER_HOT = "hot";
export const TIER_WARM = "warm";
export const TIER_COLD = "cold";

export const HOT_DAYS = 1;
export const WARM_DAYS = 7;
export const COLD_DAYS = 30;
/** warm 档重压参数（1280×720 / q40） */
export const WARM_SPEC = { maxWidth: 1280, quality: 40 };
/** cold 档重压参数（640×360 / q30） */
export const COLD_SPEC = { maxWidth: 640, quality: 30 };
export const TOTAL_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
export const TRIM_TARGET_BYTES = 7.5 * 1024 * 1024 * 1024;
export const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

export interface SweepStats {
  scanned: number;
  tiered: number;
  deleted: number;
  freedBytes: number;
  errors: string[];
}

/** 某天的快照目录 */
export function snapshotDir(configDir: string, date: string): string {
  return join(configDir, "activity", "snapshots", date);
}

/** 新快照的落盘路径 */
export function snapshotPath(configDir: string, id: string, ts: number): string {
  return join(snapshotDir(configDir, dateKey(ts)), `${id}.jpg`);
}

export interface StorageOptions {
  configDir: string;
  totalLimitBytes?: number;
  trimToBytes?: number;
  now?: () => number;
}

export class ActivityStorage {
  #store: ActivityStore;
  #configDir: string;
  #totalLimit: number;
  #trimTo: number;
  #now: () => number;

  constructor(store: ActivityStore, opts: StorageOptions) {
    this.#store = store;
    this.#configDir = opts.configDir;
    this.#totalLimit = opts.totalLimitBytes ?? TOTAL_LIMIT_BYTES;
    this.#trimTo = opts.trimToBytes ?? TRIM_TARGET_BYTES;
    this.#now = opts.now ?? (() => Date.now());
  }

  get configDir(): string { return this.#configDir; }

  ensureDirs(ts = this.#now()): void {
    try { mkdirSync(snapshotDir(this.#configDir, dateKey(ts)), { recursive: true }); } catch { /* ignore */ }
  }

  /** 一次巡检：分级重压 + 过期删除 + 总量收敛 */
  async sweep(): Promise<SweepStats> {
    const stats: SweepStats = { scanned: 0, tiered: 0, deleted: 0, freedBytes: 0, errors: [] };
    const now = this.#now();
    for (const row of this.#store.tierRows()) {
      stats.scanned++;
      const age = now - row.timestamp;
      try {
        if (age > COLD_DAYS * DAY_MS) {
          stats.freedBytes += this.#removeFile(row.filePath);
          this.#store.deleteSnapshot(row.id);
          stats.deleted++;
          continue;
        }
        const target = age > WARM_DAYS * DAY_MS ? TIER_COLD : age > HOT_DAYS * DAY_MS ? TIER_WARM : TIER_HOT;
        if (target === TIER_HOT || row.storageTier === target || (row.storageTier === TIER_COLD && target === TIER_WARM)) continue;
        if (!existsSync(row.filePath)) { this.#store.deleteSnapshot(row.id); continue; }
        const spec = target === TIER_COLD ? COLD_SPEC : WARM_SPEC;
        const before = statSync(row.filePath).size;
        const next = await this.#recompress(row.filePath, spec);
        if (!next) continue;
        this.#store.updateSnapshotFile(row.id, {
          sizeBytes: next.bytes, width: next.width, height: next.height, storageTier: target,
        });
        stats.tiered++;
        if (before > next.bytes) stats.freedBytes += before - next.bytes;
      } catch (e) {
        stats.errors.push(`${row.id}: ${String(e).slice(0, 120)}`);
      }
    }
    const trim = await this.trimToLimit();
    stats.deleted += trim.deleted;
    stats.freedBytes += trim.freed;
    return stats;
  }

  /** 超总量上限：从最老删到 7.5GB */
  async trimToLimit(): Promise<{ deleted: number; freed: number }> {
    let total = this.#store.totalBytes();
    if (total <= this.#totalLimit) return { deleted: 0, freed: 0 };
    let deleted = 0;
    let freed = 0;
    for (const row of this.#store.tierRows()) {
      if (total <= this.#trimTo) break;
      freed += this.#removeFile(row.filePath);
      this.#store.deleteSnapshot(row.id);
      total -= row.sizeBytes;
      deleted++;
    }
    return { deleted, freed };
  }

  stats(): { snapshots: number; bytes: number; lastCaptureAt?: number; totalLimitBytes: number; trimTargetBytes: number } {
    return { ...this.#store.snapshotStats(), totalLimitBytes: this.#totalLimit, trimTargetBytes: this.#trimTo };
  }

  #removeFile(path: string): number {
    try {
      const size = statSync(path).size;
      unlinkSync(path);
      return size;
    } catch { return 0; }
  }

  /** 原地重压：先写临时文件，比原图大就放弃（不浪费空间） */
  async #recompress(path: string, spec: { maxWidth: number; quality: number }): Promise<{ bytes: number; width?: number; height?: number } | null> {
    const tmp = `${path}.tmp-${process.pid}`;
    const r = await convert(path, tmp, { format: "jpeg", maxWidth: spec.maxWidth, quality: spec.quality });
    if (!r.ok || !existsSync(tmp)) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
      return null;
    }
    const before = statSync(path).size;
    const after = statSync(tmp).size;
    if (after >= before) { try { unlinkSync(tmp); } catch { /* ignore */ } return null; }
    try { renameSync(tmp, path); } catch { try { unlinkSync(tmp); } catch { /* ignore */ } return null; }
    const dims = await imageSize(path);
    return { bytes: after, ...(dims ? { width: dims.width, height: dims.height } : {}) };
  }
}

/** 30 分钟巡检；返回句柄（stop / 手动跑一次） */
export function startStorageSweeper(
  storage: ActivityStorage,
  opts: { intervalMs?: number; onSweep?: (stats: SweepStats) => void } = {},
): { stop(): void; runNow(): Promise<SweepStats | null> } {
  let busy = false;
  const run = async (): Promise<SweepStats | null> => {
    if (busy) return null;
    busy = true;
    try {
      const stats = await storage.sweep();
      opts.onSweep?.(stats);
      return stats;
    } catch { return null; }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void run(); }, opts.intervalMs ?? SWEEP_INTERVAL_MS);
  timer.unref?.();
  return { stop(): void { clearInterval(timer); }, runNow: run };
}

/** 删文件但绝不抛（采集路径上任何异常都不该中断主流程） */
export function safeUnlink(path: string): void {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore */ }
}

/** 读文件但绝不抛；读不到返回空 */
export function safeRead(path: string): Uint8Array {
  try { return readFileSync(path); } catch { return new Uint8Array(0); }
}
