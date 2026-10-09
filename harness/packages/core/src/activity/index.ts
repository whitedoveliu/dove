/**
 * ActivityRecorder —— 感知层唯一门面（M7）
 * 组合：截屏 → 判重 → 落盘/落库 → OCR（每 N 张）→ 脱敏 → 会话分析 → 日报/周报 → 存储轮转。
 * 纪律：
 * - 无屏幕录制权限时**不静默失败**：init 报告 screenPermission=false + 中文引导，其他能力（判重/脱敏/分析/报表）照常可用；
 * - 所有对外方法都不抛异常，降级路径返回结构化结果。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../session/db.ts";
import { SessionAnalyzer } from "./analyzer.ts";
import {
  CAPTURE_MAX_WIDTH, CAPTURE_QUALITY, PROBE_MAX_WIDTH, PROBE_QUALITY,
  SCREEN_PERMISSION_HINT, capture, isScreenRecordingAllowed, openPermissionSettings, screenIsLocked,
} from "./capture.ts";
import { DEDUPE_THUMB_WIDTH, Deduper, type DedupeResult, toBitmap } from "./dedupe.ts";
import { OCR_EVERY_N, ocrImage } from "./ocr.ts";
import { redact } from "./redact.ts";
import { buildRangeSkeleton, buildSkeleton, collectDays, collectSessions, narrate } from "./report.ts";
import { ActivityStore, dateKey, dayRange, DAY_MS } from "./store.ts";
import { ActivityStorage, snapshotPath, startStorageSweeper, safeRead, safeUnlink } from "./storage.ts";
import { TriggerEngine } from "./triggers.ts";
import { ensureScreenPermission, screenPermissionNote } from "./permission.ts";
import type { ActivityLlm, AnalysisResult, SnapshotRow, TriggerKind, TriggerMeta } from "./types.ts";
import { emptyAnalysis } from "./types.ts";

export const SESSION_GAP_MS = 30 * 60 * 1000;   // 超过 30 分钟没采 → 开新活动会话
export const LOCK_POLL_MS = 15_000;             // 锁屏状态轮询间隔

export type ActivityLogger = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;

export interface ActivityRecorderOptions {
  db: Db;
  configDir: string;
  llm?: ActivityLlm;
  enabled?: boolean;
  model?: string;
  logger?: ActivityLogger;
  /** memoryCandidates → 记忆写入管线（T7.9），通常传 MemoryService.remember */
  remember?: (content: string, kind?: string, scope?: string) => Promise<string>;
  /** 前置应用/窗口来源（T7.4 的 Swift 输入监听注入） */
  appInfo?: () => TriggerMeta | undefined | Promise<TriggerMeta | undefined>;
  triggerIntervals?: Partial<Record<TriggerKind, number>>;
  ocrEvery?: number;
  sessionGapMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

export interface CaptureOutcome { snapshotId?: string; skipped?: string }

export class ActivityRecorder {
  #db: Db;
  #configDir: string;
  #llm?: ActivityLlm;
  #enabled: boolean;
  #model: string;
  #logger?: ActivityLogger;
  #remember?: ActivityRecorderOptions["remember"];
  #appInfo?: ActivityRecorderOptions["appInfo"];
  #triggerIntervals?: Partial<Record<TriggerKind, number>>;
  #sweepIntervalMs?: number;
  #ocrEvery: number;
  #sessionGapMs: number;
  #now: () => number;

  #store: ActivityStore;
  #storage: ActivityStorage;
  #analyzer: SessionAnalyzer;
  #deduper = new Deduper();
  #triggers: TriggerEngine | null = null;
  #sweeper: { stop(): void; runNow(): Promise<unknown> } | null = null;
  /** stop() 之后所有在途写入都要放弃（避免与 DB 关闭竞态） */
  #stopped = false;
  #lockTimer: ReturnType<typeof setInterval> | null = null;
  #screenLocked = false;

  #screenPermission = false;
  #inited = false;
  #busy = false;
  #frameCount = 0;
  #sessionId: string | null = null;
  #lastCaptureAt = 0;
  #lastMeta: TriggerMeta | undefined;

  constructor(opts: ActivityRecorderOptions) {
    this.#db = opts.db;
    this.#configDir = opts.configDir;
    this.#llm = opts.llm;
    this.#enabled = opts.enabled !== false;
    this.#model = opts.model ?? "deepseek-flash";
    this.#logger = opts.logger;
    this.#remember = opts.remember;
    this.#appInfo = opts.appInfo;
    this.#triggerIntervals = opts.triggerIntervals;
    this.#sweepIntervalMs = opts.sweepIntervalMs;
    this.#ocrEvery = opts.ocrEvery ?? OCR_EVERY_N;
    this.#sessionGapMs = opts.sessionGapMs ?? SESSION_GAP_MS;
    this.#now = opts.now ?? (() => Date.now());
    this.#store = new ActivityStore(this.#db);
    this.#storage = new ActivityStorage(this.#store, { configDir: opts.configDir, now: this.#now });
    this.#analyzer = new SessionAnalyzer(this.#store, {
      llm: opts.llm, model: this.#model, logger: opts.logger,
      knownProjects: () => this.#knownProjects(),
    });
  }

  get store(): ActivityStore { return this.#store; }
  get storage(): ActivityStorage { return this.#storage; }
  get screenPermission(): boolean { return this.#screenPermission; }
  get enabled(): boolean { return this.#enabled; }
  get running(): boolean { return !!this.#triggers?.running; }
  get sessionId(): string | null { return this.#sessionId; }

  /** 初始化：建目录、探测屏幕录制权限、从库里恢复判重指纹 */
  async init(): Promise<{ ok: boolean; screenPermission: boolean; note?: string }> {
    let note: string | undefined;
    try { mkdirSync(join(this.#configDir, "activity", "snapshots"), { recursive: true }); }
    catch (e) { note = `活动目录创建失败：${String(e).slice(0, 120)}`; }
    if (!this.#enabled) {
      this.#screenPermission = false;
      return { ok: false, screenPermission: false, note: note ?? "活动记录器未启用（enabled=false）" };
    }
    // 探测 → 不行就主动申请（只探测不申请的话，系统不会把 app 加进
    // 「屏幕录制」列表，用户去设置里根本找不到 —— 详见 permission.ts）
    let perm: Awaited<ReturnType<typeof ensureScreenPermission>> = { granted: false, asked: false, everAsked: false };
    try { perm = await ensureScreenPermission(this.#configDir); } catch { /* ignore */ }
    this.#screenPermission = perm.granted;
    note = screenPermissionNote(note, perm, SCREEN_PERMISSION_HINT) || undefined;
    // 恢复上次判重指纹：进程重启后第一次采集不会把「同一屏」当成新画面
    try {
      const last = this.#store.latestSnapshot();
      if (last && last.hashHex) this.#deduper.seed(last.hashHex, last.histogram);
    } catch { /* ignore */ }
    this.#inited = true;
    return { ok: this.#enabled, screenPermission: this.#screenPermission, ...(note ? { note } : {}) };
  }

  /** 启动触发器 + 30 分钟存储巡检 */
  start(): void {
    if (!this.#enabled || this.#triggers) return;
    this.#triggers = new TriggerEngine({
      intervals: this.#triggerIntervals,
      shouldPause: () => this.#screenLocked,        // 锁屏期间零采集
      onCapture: (reason, meta) => {
        if (meta) this.#lastMeta = meta;   // T7.4：周期触发不带 meta，不能把已知的前台 app/窗口冲掉
        void this.captureNow(reason);
      },
    });
    this.#triggers.start();
    void this.#pollLock();
    this.#lockTimer = setInterval(() => { void this.#pollLock(); }, LOCK_POLL_MS);
    this.#lockTimer.unref?.();
    this.#sweeper = startStorageSweeper(this.#storage, {
      ...(this.#sweepIntervalMs ? { intervalMs: this.#sweepIntervalMs } : {}),
      onSweep: (stats) => this.#log("info", "存储巡检完成", { ...stats }),
    });
    void this.#sweeper.runNow();
  }

  stop(): void {
    // 先置位：已经在飞行中的 captureNow 会在写库前看到它并直接返回，
    // 否则会出现「DB 已关 → 采集协程才写完」的竞态（报 database is not open）。
    this.#stopped = true;
    this.#triggers?.stop();
    this.#triggers = null;
    this.#sweeper?.stop();
    this.#sweeper = null;
    if (this.#lockTimer) { clearInterval(this.#lockTimer); this.#lockTimer = null; }
    this.#screenLocked = false;
    if (this.#sessionId) { try { this.#store.closeSession(this.#sessionId, this.#now()); } catch { /* DB 可能已经关了 */ } }
    this.#sessionId = null;
  }

  /** 外部事件源（输入监听 / 面板）转发触发 */
  notify(kind: TriggerKind, meta?: TriggerMeta): void {
    if (meta) this.#lastMeta = meta;
    this.#triggers?.notify(kind, meta);
  }

  openPermissionSettings(): void { openPermissionSettings(); }

  /** 手动采一帧（测试 / 调试） */
  async captureNow(reason: TriggerKind | string = "manual"): Promise<CaptureOutcome> {
    if (this.#stopped) return { skipped: "采集器已停止" };
    if (!this.#enabled) return { skipped: "活动记录器未启用（enabled=false）" };
    if (!this.#inited) await this.init();          // 没显式 init 也能用，避免「静默不采集」
    if (!this.#screenPermission) return { skipped: `无屏幕录制权限。${SCREEN_PERMISSION_HINT}` };
    if (this.#busy) return { skipped: "上一帧仍在采集中" };
    this.#busy = true;
    try { return await this.#captureOnce(String(reason)); }
    catch (e) { return { skipped: `采集异常：${String(e).slice(0, 200)}` }; }
    finally { this.#busy = false; }
  }

  listSnapshots(date?: string, limit = 200): SnapshotRow[] {
    try { return this.#store.listSnapshots(date, limit); } catch { return []; }
  }

  /** 会话分析（会话关闭后调用；结果落 activity_sessions.summary） */
  async analyze(sessionId: string): Promise<AnalysisResult> {
    try {
      const session = this.#store.getSession(sessionId);
      if (!session) return emptyAnalysis(`会话不存在：${sessionId}`);
      const result = await this.#analyzer.analyze(session);
      this.#store.saveAnalysis(sessionId, result);
      this.#store.closeSession(sessionId, session.endedAt ?? this.#now());
      await this.#pushMemories(result);
      return result;
    } catch (e) {
      return emptyAnalysis(`分析异常：${String(e).slice(0, 200)}`);
    }
  }

  /** 分析所有已结束但未分析的会话，返回处理条数 */
  async analyzePending(limit = 20): Promise<number> {
    let done = 0;
    try {
      const rows = this.#store.sessionsBetween(0, this.#now(), 500)
        .filter((s) => !s.analyzedAt && (s.snapshotCount ?? 0) > 0)
        .slice(0, limit);
      for (const s of rows) { await this.analyze(s.id); done++; }
    } catch { /* ignore */ }
    return done;
  }

  /** 日报：骨架（确定性）+ 叙事（LLM，可选） */
  async dailyReport(date?: string): Promise<string> {
    const key = date ?? dateKey(this.#now());
    let skeleton = "";
    try {
      const sessions = collectSessions(this.#store, key);
      skeleton = buildSkeleton(key, sessions);
      const text = await narrate(skeleton, this.#llm, { model: this.#model });
      this.#store.upsertSummary({
        kind: "daily", dateKey: key, summary: text, model: this.#model, isPartial: !this.#llm,
        stats: { sessions: sessions.length, snapshots: sessions.reduce((n, s) => n + s.snapshotCount, 0) },
      });
      return text;
    } catch (e) {
      return skeleton || `# 工作日志 · ${key}\n\n（生成失败：${String(e).slice(0, 120)}）`;
    }
  }

  /** 周报：最近 7 天（含今天） */
  async weeklyReport(days = 7): Promise<string> {
    const now = this.#now();
    const to = dayRange(dateKey(now)).to;
    const from = to - days * DAY_MS;
    const key = `${dateKey(from)}_${dateKey(to - 1)}`;
    let skeleton = "";
    try {
      const list = collectDays(this.#store, days, now);
      skeleton = buildRangeSkeleton(dateKey(from), dateKey(to - 1), list);
      const text = await narrate(skeleton, this.#llm, { model: this.#model, maxTokens: 3_000 });
      this.#store.upsertSummary({
        kind: "weekly", dateKey: key, summary: text, model: this.#model, isPartial: !this.#llm,
        stats: { days, sessions: list.reduce((n, d) => n + d.sessions.length, 0) },
      });
      return text;
    } catch (e) {
      return skeleton || `# 工作周报 · ${key}\n\n（生成失败：${String(e).slice(0, 120)}）`;
    }
  }

  stats(): { snapshots: number; bytes: number; lastCaptureAt?: number } {
    try { return this.#store.snapshotStats(); }
    catch { return { snapshots: 0, bytes: 0 }; }
  }

  // ── 内部 ───────────────────────────────────────────────
  async #captureOnce(reason: string): Promise<CaptureOutcome> {
    const ts = this.#now();
    const meta = await this.#resolveMeta();
    const sessionId = this.#ensureSession(ts);
    this.#storage.ensureDirs(ts);
    if (reason !== "heartbeat" && reason !== "visual_change" && reason !== "manual") {
      try {
        this.#store.insertEvent({
          sessionId, kind: reason, appName: meta?.appName ?? null, timestamp: ts,
          data: meta?.windowTitle ? { windowTitle: meta.windowTitle } : {},
        });
      } catch { /* ignore */ }
    }

    // ① 判重专用低质量图（640/q40），只为算指纹
    const probePath = join(tmpdir(), `dove-probe-${process.pid}-${ts}.jpg`);
    const probe = await capture({ out: probePath, maxWidth: PROBE_MAX_WIDTH, quality: PROBE_QUALITY });
    if (!probe.ok) return { skipped: `探测截图失败：${probe.error ?? "未知错误"}` };
    const bitmap = await toBitmap(probePath, `${probePath}.bmp`, DEDUPE_THUMB_WIDTH);
    let verdict: DedupeResult;
    if (bitmap) verdict = this.#deduper.check(bitmap);
    else verdict = this.#deduper.checkRaw(safeRead(probePath));
    safeUnlink(probePath);
    if (verdict.duplicate) {
      this.#log("info", "判重丢弃", { reason: verdict.reason });
      return { skipped: `判重丢弃（${verdict.reason}）` };
    }

    // ② 常规图（最大宽 2560 / q55）
    const id = `snap_${randomUUID().slice(0, 12)}`;
    const filePath = snapshotPath(this.#configDir, id, ts);
    const full = await capture({ out: filePath, maxWidth: CAPTURE_MAX_WIDTH, quality: CAPTURE_QUALITY });
    if (!full.ok) {
      // 常规图失败：清掉刚写进判重器的指纹，否则同一屏会被永远判成重复、再也补不上图
      this.#deduper.reset();
      const last = this.#store.latestSnapshot();
      if (last?.hashHex) this.#deduper.seed(last.hashHex, last.histogram);
      return { skipped: `截图失败：${full.error ?? "未知错误"}` };
    }

    // ③ 落库（指纹来自判重位图，保证同尺度可比）
    const fp = this.#deduper.state;
    try {
      this.#store.insertSnapshot({
        id, sessionId, timestamp: ts, filePath,
        width: full.width ?? 0, height: full.height ?? 0, sizeBytes: full.bytes ?? 0,
        trigger: reason, appName: meta?.appName ?? null, windowTitle: meta?.windowTitle ?? null,
        hashHex: fp?.hashHex ?? null, histogram: fp?.histogram ?? null,
        diffPct: verdict.diffPct ?? null, storageTier: "hot",
      });
    } catch (e) {
      const msg = String(e);
      // 关闭竞态不是真错误，降级成 debug，别在日志里刷红
      if (msg.includes("database is not open") || this.#stopped) {
        this.#log("debug" as never, "采集器已停止，本次快照丢弃", {});
        return { skipped: "采集器已停止" };
      }
      this.#log("error", "快照入库失败", { error: msg.slice(0, 200) });
    }
    this.#lastCaptureAt = ts;

    // ④ OCR：每 N 张跑一次，文本脱敏后入库
    this.#frameCount++;
    if (this.#ocrEvery > 0 && this.#frameCount % this.#ocrEvery === 0) {
      await this.#runOcr(id, sessionId, filePath);
    }
    return { snapshotId: id };
  }

  async #runOcr(snapshotId: string, sessionId: string | null, filePath: string): Promise<string | null> {
    try {
      const r = await ocrImage(filePath);
      if (r.error) { this.#log("warn", "OCR 降级", { error: r.error.slice(0, 200) }); return null; }
      const clean = redact(r.text).text.trim();
      if (!clean) return null;
      this.#store.insertOcrFrame({ snapshotId, sessionId, text: clean });
      return clean;
    } catch (e) {
      this.#log("warn", "OCR 异常", { error: String(e).slice(0, 200) });
      return null;
    }
  }

  #ensureSession(ts: number): string {
    if (this.#sessionId && ts - this.#lastCaptureAt <= this.#sessionGapMs) return this.#sessionId;
    if (this.#sessionId) {
      try { this.#store.closeSession(this.#sessionId, this.#lastCaptureAt || ts); } catch { /* ignore */ }
    }
    const row = this.#store.openSession("heartbeat", ts);
    this.#sessionId = row.id;
    return row.id;
  }

  async #resolveMeta(): Promise<TriggerMeta | undefined> {
    if (this.#lastMeta) return this.#lastMeta;
    if (!this.#appInfo) return undefined;
    try { return await this.#appInfo(); } catch { return undefined; }
  }

  async #pushMemories(result: AnalysisResult): Promise<void> {
    if (!this.#remember || !result.memoryCandidates.length) return;
    for (const candidate of result.memoryCandidates) {
      try { await this.#remember(candidate.content, candidate.kind, "global"); }
      catch { /* 单条失败不影响其他 */ }
    }
  }

  #knownProjects(): string[] {
    try {
      return this.#db.all("SELECT name FROM projects ORDER BY updated_at DESC LIMIT 20").map((r) => String(r.name));
    } catch { return []; }
  }

  /** 锁屏状态轮询（异步，不阻塞触发器） */
  async #pollLock(): Promise<void> {
    try { this.#screenLocked = await screenIsLocked(); } catch { /* ignore */ }
  }

  #log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
    try { this.#logger?.(level, msg, data); } catch { /* ignore */ }
  }
}

