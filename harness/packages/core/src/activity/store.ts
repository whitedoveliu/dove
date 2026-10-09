/**
 * 活动表 CRUD（M7）：activity_snapshots / activity_ocr_frames / activity_events /
 * activity_sessions / activity_summaries —— 表结构在 session/schema.ts 里定义。
 * 只做数据搬运，不含业务判断。
 */
import { randomUUID } from "node:crypto";
import { ACTIVITY_INJECT } from "../constants.ts";
import { ScreenIndex } from "../memory/screen-index.ts";
import type { Db } from "../session/db.ts";
import type { ActivityEventRow, ActivitySessionRow, AnalysisResult, OcrFrameRow, SnapshotRow } from "./types.ts";

export const DAY_MS = 86_400_000;

/** 向量通道的候选帧（结构上兼容 context/activity-inject.ts 的 ScreenFrame） */
export interface RecentOcrFrame {
  frameId: string;
  snapshotId: string;
  text: string;
  at: number;
  appName: string | null;
  windowTitle: string | null;
}

/** 本地时区的 YYYY-MM-DD */
export function dateKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 某个本地日期的 [00:00, 次日 00:00) 毫秒区间 */
export function dayRange(date: string): { from: number; to: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m) {
    const from = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
    return { from, to: from + DAY_MS };
  }
  const t = new Date(date).getTime();
  const base = Number.isFinite(t) ? t : Date.now();
  const d = new Date(base);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return { from, to: from + DAY_MS };
}

function toSnapshot(r: Record<string, unknown>): SnapshotRow {
  let histogram: number[] | null = null;
  if (r.histogram) { try { histogram = JSON.parse(String(r.histogram)) as number[]; } catch { histogram = null; } }
  return {
    id: String(r.id),
    sessionId: r.session_id == null ? null : String(r.session_id),
    timestamp: Number(r.timestamp),
    filePath: String(r.file_path),
    width: Number(r.width ?? 0),
    height: Number(r.height ?? 0),
    sizeBytes: Number(r.size_bytes ?? 0),
    trigger: String(r.trigger ?? "heartbeat"),
    appName: r.app_name == null ? null : String(r.app_name),
    windowTitle: r.window_title == null ? null : String(r.window_title),
    hashHex: r.hash_hex == null ? null : String(r.hash_hex),
    histogram,
    diffPct: r.diff_pct == null ? null : Number(r.diff_pct),
    storageTier: String(r.storage_tier ?? "hot"),
    createdAt: Number(r.created_at ?? r.timestamp),
  };
}

function toSession(r: Record<string, unknown>): ActivitySessionRow {
  let summary: AnalysisResult | null = null;
  if (r.summary) { try { summary = JSON.parse(String(r.summary)) as AnalysisResult; } catch { summary = null; } }
  return {
    id: String(r.id),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    triggerKind: String(r.trigger_kind ?? "heartbeat"),
    summary,
    analyzedAt: r.analyzed_at == null ? null : Number(r.analyzed_at),
    ...(r.snapshot_count == null ? {} : { snapshotCount: Number(r.snapshot_count) }),
  };
}

export class ActivityStore {
  #db: Db;
  #index: ScreenIndex;
  constructor(db: Db) { this.#db = db; this.#index = new ScreenIndex(db); }

  // ── 快照 ───────────────────────────────────────────────
  insertSnapshot(row: Omit<SnapshotRow, "createdAt"> & { createdAt?: number }): void {
    this.#db.run(
      `INSERT OR REPLACE INTO activity_snapshots
       (id, session_id, timestamp, file_path, width, height, size_bytes, trigger, app_name, window_title,
        hash_hex, histogram, diff_pct, storage_tier, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id, row.sessionId, row.timestamp, row.filePath, row.width, row.height, row.sizeBytes, row.trigger,
      row.appName, row.windowTitle, row.hashHex,
      row.histogram ? JSON.stringify(row.histogram) : null,
      row.diffPct, row.storageTier, row.createdAt ?? row.timestamp,
    );
  }

  getSnapshot(id: string): SnapshotRow | undefined {
    const r = this.#db.get("SELECT * FROM activity_snapshots WHERE id = ?", id);
    return r ? toSnapshot(r) : undefined;
  }

  listSnapshots(date?: string, limit = 200): SnapshotRow[] {
    if (date) {
      const { from, to } = dayRange(date);
      return this.#db.all("SELECT * FROM activity_snapshots WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?", from, to, limit).map(toSnapshot);
    }
    return this.#db.all("SELECT * FROM activity_snapshots ORDER BY timestamp DESC LIMIT ?", limit).map(toSnapshot);
  }

  latestSnapshot(): SnapshotRow | undefined {
    const r = this.#db.get("SELECT * FROM activity_snapshots ORDER BY timestamp DESC LIMIT 1");
    return r ? toSnapshot(r) : undefined;
  }

  snapshotsForSession(sessionId: string, limit = 500): SnapshotRow[] {
    return this.#db.all("SELECT * FROM activity_snapshots WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?", sessionId, limit).map(toSnapshot);
  }

  /** 轮转用：按时间升序拿全部快照的轻量字段 */
  tierRows(): { id: string; timestamp: number; filePath: string; sizeBytes: number; storageTier: string }[] {
    return this.#db.all("SELECT id, timestamp, file_path, size_bytes, storage_tier FROM activity_snapshots ORDER BY timestamp ASC")
      .map((r) => ({
        id: String(r.id), timestamp: Number(r.timestamp), filePath: String(r.file_path),
        sizeBytes: Number(r.size_bytes ?? 0), storageTier: String(r.storage_tier ?? "hot"),
      }));
  }

  updateSnapshotFile(id: string, patch: { filePath?: string; sizeBytes?: number; width?: number; height?: number; storageTier?: string }): void {
    const cur = this.getSnapshot(id);
    if (!cur) return;
    this.#db.run(
      "UPDATE activity_snapshots SET file_path=?, size_bytes=?, width=?, height=?, storage_tier=? WHERE id=?",
      patch.filePath ?? cur.filePath, patch.sizeBytes ?? cur.sizeBytes,
      patch.width ?? cur.width, patch.height ?? cur.height,
      patch.storageTier ?? cur.storageTier, id,
    );
  }

  deleteSnapshot(id: string): void {
    this.#db.run("DELETE FROM activity_ocr_frames WHERE snapshot_id = ?", id);
    this.#db.run("DELETE FROM activity_snapshots WHERE id = ?", id);
  }

  totalBytes(): number {
    const r = this.#db.get("SELECT COALESCE(SUM(size_bytes),0) AS total FROM activity_snapshots");
    return Number(r?.total ?? 0);
  }

  snapshotStats(): { snapshots: number; bytes: number; lastCaptureAt?: number } {
    const r = this.#db.get("SELECT COUNT(1) AS n, COALESCE(SUM(size_bytes),0) AS total, MAX(timestamp) AS last FROM activity_snapshots");
    const last = r?.last == null ? undefined : Number(r.last);
    return {
      snapshots: Number(r?.n ?? 0), bytes: Number(r?.total ?? 0),
      ...(last !== undefined && Number.isFinite(last) ? { lastCaptureAt: last } : {}),
    };
  }

  // ── OCR ────────────────────────────────────────────────
  /**
   * OCR 落库。**顺手建倒排索引** —— 这是「截图 → OCR → SQLite → 检索」那条链的关键：
   * 以前只写 activity_ocr_frames，检索那一环是断的（agent 根本查不到屏幕内容）。
   */
  insertOcrFrame(input: { snapshotId: string; sessionId?: string | null; text: string }): string {
    const id = `ocr_${randomUUID().slice(0, 12)}`;
    const at = Date.now();
    this.#db.run(
      "INSERT OR REPLACE INTO activity_ocr_frames(id, snapshot_id, session_id, text, char_count, created_at) VALUES (?,?,?,?,?,?)",
      id, input.snapshotId, input.sessionId ?? null, input.text, input.text.length, at,
    );
    try {
      this.#index.index({ id, snapshotId: input.snapshotId, sessionId: input.sessionId ?? null, text: input.text, at });
    } catch { /* 索引失败不能影响采集本身 */ }
    return id;
  }

  /** 屏幕内容检索（agent 的 Recall 会用到） */
  searchScreen(query: string, opts?: { limit?: number; since?: number; sessionId?: string }) {
    return this.#index.search(query, opts);
  }

  screenIndexStats() { return this.#index.stats(); }

  /** 把老库里没索引的 OCR 帧补齐 */
  rebuildScreenIndex(batch = 500) { return this.#index.rebuild(batch); }

  listOcrFrames(sessionId: string, limit = 500): OcrFrameRow[] {
    return this.#db.all("SELECT * FROM activity_ocr_frames WHERE session_id = ? ORDER BY created_at ASC LIMIT ?", sessionId, limit)
      .map((r) => ({
        id: String(r.id), snapshotId: String(r.snapshot_id),
        sessionId: r.session_id == null ? null : String(r.session_id),
        text: String(r.text ?? ""), charCount: Number(r.char_count ?? 0), createdAt: Number(r.created_at),
      }));
  }

  countOcrFrames(): number {
    const r = this.#db.get("SELECT COUNT(1) AS n FROM activity_ocr_frames");
    return Number(r?.n ?? 0);
  }

  /**
   * 最近 OCR 帧（按时间倒序）：语义注入的**向量通道候选池**。
   * 只读、带窗口元信息（app / 窗口标题），注入块靠这些元信息才有「具体的事」可提。
   */
  listRecentOcrFrames(since: number, limit: number = ACTIVITY_INJECT.semanticVectorFrames): RecentOcrFrame[] {
    return this.#db.all(
      `SELECT f.id AS frame_id, f.snapshot_id, f.text, f.created_at, s.app_name, s.window_title
         FROM activity_ocr_frames f
         LEFT JOIN activity_snapshots s ON s.id = f.snapshot_id
        WHERE f.created_at >= ? ORDER BY f.created_at DESC LIMIT ?`,
      since, Math.max(1, Math.min(200, limit)),
    ).map((r) => ({
      frameId: String(r.frame_id), snapshotId: String(r.snapshot_id ?? ""), text: String(r.text ?? ""),
      at: Number(r.created_at),
      appName: r.app_name == null ? null : String(r.app_name),
      windowTitle: r.window_title == null ? null : String(r.window_title),
    }));
  }

  // ── 事件 ───────────────────────────────────────────────
  insertEvent(input: { sessionId?: string | null; kind: string; appName?: string | null; data?: Record<string, unknown>; timestamp?: number }): string {
    const id = `ev_${randomUUID().slice(0, 12)}`;
    const ts = input.timestamp ?? Date.now();
    this.#db.run(
      "INSERT OR REPLACE INTO activity_events(id, session_id, timestamp, kind, app_name, data, created_at) VALUES (?,?,?,?,?,?,?)",
      id, input.sessionId ?? null, ts, input.kind, input.appName ?? null, JSON.stringify(input.data ?? {}), Date.now(),
    );
    return id;
  }

  listEvents(sessionId: string, limit = 500): ActivityEventRow[] {
    return this.#db.all("SELECT * FROM activity_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?", sessionId, limit)
      .map((r) => ({
        id: String(r.id), sessionId: r.session_id == null ? null : String(r.session_id),
        timestamp: Number(r.timestamp), kind: String(r.kind),
        appName: r.app_name == null ? null : String(r.app_name),
        data: safeJson(String(r.data ?? "{}")), createdAt: Number(r.created_at),
      }));
  }

  // ── 会话 ───────────────────────────────────────────────
  openSession(triggerKind = "heartbeat", at = Date.now()): ActivitySessionRow {
    const id = `act_${randomUUID().slice(0, 12)}`;
    this.#db.run("INSERT INTO activity_sessions(id, started_at, trigger_kind) VALUES (?,?,?)", id, at, triggerKind);
    return { id, startedAt: at, endedAt: null, triggerKind, summary: null, analyzedAt: null };
  }

  closeSession(id: string, at = Date.now()): void {
    this.#db.run("UPDATE activity_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL", at, id);
  }

  getSession(id: string): ActivitySessionRow | undefined {
    const r = this.#db.get(`SELECT s.*, (SELECT COUNT(1) FROM activity_snapshots a WHERE a.session_id = s.id) AS snapshot_count
      FROM activity_sessions s WHERE s.id = ?`, id);
    return r ? toSession(r) : undefined;
  }

  /** 最近一个未关闭的会话（活动记录器续接用） */
  latestOpenSession(): ActivitySessionRow | undefined {
    const r = this.#db.get(`SELECT s.*, (SELECT COUNT(1) FROM activity_snapshots a WHERE a.session_id = s.id) AS snapshot_count
      FROM activity_sessions s WHERE s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1`);
    return r ? toSession(r) : undefined;
  }

  #sessionQuery(where: string, params: unknown[], limit: number): ActivitySessionRow[] {
    return this.#db.all(
      `SELECT s.*, (SELECT COUNT(1) FROM activity_snapshots a WHERE a.session_id = s.id) AS snapshot_count
       FROM activity_sessions s WHERE ${where} ORDER BY s.started_at ASC LIMIT ?`,
      ...params, limit,
    ).map(toSession);
  }

  listSessions(date: string, limit = 200): ActivitySessionRow[] {
    const { from, to } = dayRange(date);
    return this.#sessionQuery("COALESCE(s.ended_at, ?) >= ? AND s.started_at < ?", [Date.now(), from, to], limit);
  }

  sessionsBetween(from: number, to: number, limit = 500): ActivitySessionRow[] {
    return this.#sessionQuery("COALESCE(s.ended_at, ?) >= ? AND s.started_at < ?", [Date.now(), from, to], limit);
  }

  saveAnalysis(sessionId: string, result: AnalysisResult, at = Date.now()): void {
    this.#db.run("UPDATE activity_sessions SET summary = ?, analyzed_at = ? WHERE id = ?", JSON.stringify(result), at, sessionId);
  }

  // ── 汇总 ───────────────────────────────────────────────
  upsertSummary(input: { kind: string; dateKey: string; summary: string; stats?: Record<string, unknown>; model?: string; isPartial?: boolean }): void {
    this.#db.run(
      `INSERT INTO activity_summaries(id, kind, date_key, summary, stats, model, is_partial, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(kind, date_key) DO UPDATE SET summary=excluded.summary, stats=excluded.stats,
         model=excluded.model, is_partial=excluded.is_partial, created_at=excluded.created_at`,
      `sum_${input.kind}_${input.dateKey}`, input.kind, input.dateKey, input.summary, JSON.stringify(input.stats ?? {}),
      input.model ?? null, input.isPartial ? 1 : 0, Date.now(),
    );
  }

  getSummary(kind: string, dateKey: string): { summary: string; stats: Record<string, unknown>; model: string | null; isPartial: boolean } | undefined {
    const r = this.#db.get("SELECT * FROM activity_summaries WHERE kind = ? AND date_key = ?", kind, dateKey);
    if (!r) return undefined;
    return {
      summary: String(r.summary ?? ""), stats: safeJson(String(r.stats ?? "{}")),
      model: r.model == null ? null : String(r.model), isPartial: Number(r.is_partial ?? 0) === 1,
    };
  }
}

function safeJson(text: string): Record<string, unknown> {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}
