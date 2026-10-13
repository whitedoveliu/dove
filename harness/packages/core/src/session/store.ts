/**
 * 线程 / 消息 CRUD（SQLite 派生视图）+ 撤销 + 工具结果老化 + 压缩检查点
 * 真相源是事件日志（session/journal.ts）；这里只做加速查询与 UI 回放。
 *
 * 撤销纪律（append-only）：`undoTurns` 只给消息打一个 `undone_at` 标记，**从不删行、从不改写正文**；
 * 撤销这件事本身作为一条 `context.undo` 记录追加进线程日志。理由和 Kimi 的 `undo = 新分支` 一样：
 * 历史是前缀缓存的本体，也是唯一的现场证据 —— 删了它，用户说「撤销错了」时就再也回不来了。
 *
 * 压缩检查点（compactions 表）：AutoCompact 压出来的那一段历史**必须离得开这一轮的内存**，
 * 否则下一轮又从库里全量重建（还受 60 条窗口约束），压缩等于白做。存法见 setCompactedHistory。
 *
 * 行 → 领域对象的映射搬到了 session/store-rows.ts（本文件要守 400 行上限），行为一字未改。
 */
import type { Db } from "./db.ts";
import type { Message, Part, Thread } from "./types.ts";
import { isAgedBody, mergeMessageMeta, rowToMessage, rowToThread, scanSteps } from "./store-rows.ts";
import type { Journal } from "./journal.ts";
import { TOOL_RESULT_AGING_AFTER_STEPS, TOOL_RESULT_AGING_MIN_CHARS } from "../constants.ts";

/**
 * 压缩产物的识别前缀。**必须与 context/compact.ts 的 COMPACT_PRODUCT_MARK 一字不差**。
 *
 * 为什么要复述这个字面量：压缩与撤销共用同一条判据 ——「哪条 role:user 的消息是人类说的、算一轮」。
 * 两处不一致的后果不是报错，而是**静默的语义漂移**：压缩时被当成宝贝保住的消息，
 * 撤销时却被当成注入跳过（或反过来），于是「撤销一轮」撤掉的不是用户以为的那一轮。
 * ⚠️ 不能 import：session 在下层，context 在上层（tools/lint-layering.mjs 的单向依赖）。改一处必须改两处。
 */
export const COMPACT_PRODUCT_PREFIX = "[Context: 更早的";

/** 注入提醒的形状（模式注入 / 完成守卫 / 权限续跑 / 崩溃修复都是这一种） */
const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * 这条消息是不是「用户真正说过的话」（撤销时的一轮 = 一条这样的消息）。
 * 与 context/compact.ts 的 defaultIsKeptUserMessage 同口径（见 COMPACT_PRODUCT_PREFIX 的说明）：
 * 排掉 ① 宿主注入（origin === "injection"，模式注入 / 闸门提醒）；② 只由 <system-reminder> 组成的提醒；
 * ③ 压缩产物（`[Context: 更早的…`）。
 * 带尾上下文前缀（`[Context: 时间锚…]\n\n用户原话`）的**要留**：前缀贴在真实用户消息身上，前缀之后就是原话。
 */
export function isRealUserMessage(m: Message): boolean {
  if (m.role !== "user") return false;
  if (m.origin === "injection") return false;
  const text = m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("")
    .trim();
  if (!text) return false;
  if (text.startsWith(COMPACT_PRODUCT_PREFIX)) return false;
  if (text.includes("<system-reminder>") && text.replace(REMINDER_BLOCK, "").trim().length === 0) return false;
  return true;
}

export interface UndoResult {
  /** 实际撤销的轮数（失败时为 0，见 reason） */
  undone: number;
  /** 本次调用**之前**可撤销的轮数（Kimi 文案里的 M） */
  available: number;
  /** 被标记的消息条数（那 n 条用户消息 + 它们之后的一切） */
  messages?: number;
  /** 撤销边界：这 n 轮里最早的那条真实用户消息 id */
  fromMessageId?: string;
  /** 这次撤销顺手清掉了压缩检查点（本来就没有 → false/undefined；见 undoTurns 里的理由） */
  checkpointCleared?: boolean;
  /** 没做成的原因（**必须说清差多少**，用户才知道该少撤几轮） */
  reason?: string;
}

/**
 * 工具结果老化用的规划器 —— 就是 `tools/result-aging.ts` 的 `planAging`。用**注入**而不是 import：
 * session 在下层、tools 在上层，session 里 import tools 会被 tools/lint-layering.mjs 拦下。结构化类型让真函数直接可用。
 */
export interface AgingCandidateLike { key: string; text: string; step: number; toolCallId?: string }
export interface AgingPlanLike { key: string; spillPath: string; pointerText: string; savedChars: number }
export type AgingPlanner = (cands: AgingCandidateLike[], currentStep: number, workdir: string) => AgingPlanLike[];

export interface StoreOptions {
  /** 撤销记录写入线程日志（session/journal.ts）。给**工厂**不是实例：一个 Store 服务多个线程，一份实例会串台 */
  journalFor?: (threadId: string) => Journal | undefined;
  /** 老化规划器（`planAging`）；没给时 ageToolParts 直接返回 0 —— 但那是没接线，不是没得老化 */
  planAging?: AgingPlanner;
}

export class Store {
  #db: Db;
  #journalFor?: (threadId: string) => Journal | undefined;
  #planAging?: AgingPlanner;

  constructor(db: Db, opts: StoreOptions = {}) {
    this.#db = db;
    this.#journalFor = opts.journalFor;
    this.#planAging = opts.planAging;
    this.#migrateUndoColumn();
  }

  /**
   * 撤销列迁移：老库（messages 没有 undone_at）在这里平滑升上来 —— **绝不要求用户删库**。
   * 为什么不写进 schema.ts 的 CREATE TABLE：`CREATE TABLE IF NOT EXISTS` 对已存在的表一个字都不补，
   * 老库永远拿不到这一列。所以按 PRAGMA 现查现补（幂等，新库走同一条路，不依赖 schema 版本号）。
   */
  #migrateUndoColumn(): void {
    const cols = this.#db.all("PRAGMA table_info(messages)");
    if (!cols.some((c) => String(c.name) === "undone_at")) {
      this.#db.run("ALTER TABLE messages ADD COLUMN undone_at INTEGER");
    }
  }

  // ── threads ────────────────────────────────────────
  createThread(t: Partial<Thread> & { id: string }): Thread {
    const now = Date.now();
    const th: Thread = {
      id: t.id, kind: t.kind ?? "project", projectId: t.projectId ?? null,
      title: t.title ?? "新对话", model: t.model ?? "deepseek-flash",
      metadata: t.metadata ?? {}, createdAt: now, updatedAt: now,
    };
    this.#db.run(
      "INSERT INTO threads(id, kind, project_id, title, model, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      th.id, th.kind, th.projectId, th.title, th.model, JSON.stringify(th.metadata), th.createdAt, th.updatedAt,
    );
    return th;
  }

  getThread(id: string): Thread | undefined {
    const r = this.#db.get("SELECT * FROM threads WHERE id = ?", id);
    return r ? rowToThread(r) : undefined;
  }

  listThreads(kind?: Thread["kind"]): Thread[] {
    const rows = kind
      ? this.#db.all("SELECT * FROM threads WHERE kind = ? ORDER BY updated_at DESC", kind)
      : this.#db.all("SELECT * FROM threads ORDER BY updated_at DESC");
    return rows.map(rowToThread);
  }

  updateThread(id: string, patch: Partial<Pick<Thread, "title" | "model" | "metadata" | "projectId">>): void {
    const t = this.getThread(id);
    if (!t) return;
    this.#db.run("UPDATE threads SET title=?, model=?, metadata=?, project_id=?, updated_at=? WHERE id=?",
      patch.title ?? t.title, patch.model ?? t.model,
      JSON.stringify(patch.metadata ?? t.metadata), patch.projectId ?? t.projectId, Date.now(), id);
  }

  deleteThread(id: string): void {
    this.#db.run("DELETE FROM messages WHERE thread_id = ?", id);
    this.#db.run("DELETE FROM compactions WHERE thread_id = ?", id);   // 线程没了，它的检查点也不能留（否则 id 复用时会读到别人的摘要）
    this.#db.run("DELETE FROM threads WHERE id = ?", id);
  }

  /** 一个项目只允许一个活动线程（项目锁的持久化部分） */
  getOrCreateProjectThread(projectId: string, title?: string): Thread {
    const r = this.#db.get("SELECT * FROM threads WHERE kind='project' AND project_id = ? ORDER BY updated_at DESC LIMIT 1", projectId);
    if (r) return rowToThread(r);
    return this.createThread({ id: `th_${projectId}`, kind: "project", projectId, title: title ?? projectId });
  }

  getOrCreateHomeThread(): Thread {
    const r = this.#db.get("SELECT * FROM threads WHERE kind='home' ORDER BY updated_at DESC LIMIT 1");
    if (r) return rowToThread(r);
    return this.createThread({ id: "th_home", kind: "home", title: "Dove" });
  }

  // ── messages ───────────────────────────────────────

  /**
   * 写一条消息（`INSERT OR REPLACE`）：同 id 重写 = 整体替换 parts / role / created_at / usage。
   * ⚠️ metadata 例外 —— 它**合并**而不是重建（见 store-rows.ts 的 mergeMessageMeta）：保留上次写进去的
   * `tail` / `turnDiff`，只覆盖本次显式给的字段。不合并就会静默清掉尾上下文前缀（与 setMessageTail 的
   * read-modify-write 语义打架）—— 下一轮重建的 user 消息少了那段前缀，缓存从那里断开。
   */
  addMessage(m: Message): void {
    const prev = this.#db.get("SELECT metadata FROM messages WHERE id = ?", m.id);
    this.#db.run(
      "INSERT OR REPLACE INTO messages(id, thread_id, role, parts, metadata, parent_id, depth, created_at, usage) VALUES (?,?,?,?,?,?,?,?,?)",
      m.id, m.threadId, m.role, JSON.stringify(m.parts), JSON.stringify(mergeMessageMeta(prev?.metadata, m)), m.parentId ?? null, m.depth ?? 0, m.createdAt,
      m.usage ? JSON.stringify(m.usage) : null,
    );
    this.#db.run("UPDATE threads SET updated_at = ? WHERE id = ?", Date.now(), m.threadId);
  }

  /**
   * 把「实时贴上的尾上下文前缀」写进这条消息的 metadata。为什么落在消息落库之后：tail 要等组装、
   * 修复检测、记忆召回都完成才能渲染，而消息必须在这些之前就进库（装配要能看到它）。
   * 写入点是 wire-history 的 attachTail；这一手是 read-modify-write，addMessage 的 metadata 合并要跟它对齐。
   */
  setMessageTail(id: string, tail: string): void {
    const r = this.#db.get("SELECT metadata FROM messages WHERE id = ?", id);
    if (!r) return;
    let meta: Record<string, unknown> = {};
    try { meta = r.metadata ? (JSON.parse(String(r.metadata)) as Record<string, unknown>) : {}; } catch { meta = {}; }
    meta.tail = tail;
    this.#db.run("UPDATE messages SET metadata = ? WHERE id = ?", JSON.stringify(meta), id);
  }

  /**
   * 全部消息（含**已撤销**的）。默认不隐藏：撤销是标记，不是删除 ——
   * 面板要把撤销过的回合显示成灰色，用户也要能翻回去看「当时它答了什么」。
   * 模型看到的历史走 recentMessages，那条路径才过滤。
   */
  listMessages(threadId: string, limit = 500): Message[] {
    return this.#db.all("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?", threadId, limit).map(rowToMessage);
  }

  /** 模型可见的历史：撤销过的消息不再返回（wire-history 与压缩都吃这个视图） */
  recentMessages(threadId: string, limit = 40): Message[] {
    const rows = this.#db.all(
      "SELECT * FROM messages WHERE thread_id = ? AND undone_at IS NULL ORDER BY created_at DESC LIMIT ?", threadId, limit,
    );
    return rows.reverse().map(rowToMessage);
  }

  // ── 压缩检查点（AutoCompact 的落库点） ────────────────

  /**
   * 存一条「压缩检查点」：payload 是**已经拼好的 wire 消息序列**（ChatMessage[] 的 JSON）。
   *
   * 为什么原样存 wire：它要直接当**新前缀**用，必须是那一刻真实上过 wire 的字节 —— 存「被摘要掉的行」
   * 再重建一次，只会把重建与实时的差异（见 agent/wire-history.ts 铁律二）引进新前缀里，缓存整段作废。
   * 一次只留最新一条（thread_id 主键）：堆着只会让「该用哪一条」变成歧义，而旧检查点一文不值。
   */
  setCompactedHistory(threadId: string, payload: unknown[], at: number): void {
    this.#db.run(
      "INSERT INTO compactions(thread_id, at, payload) VALUES (?,?,?) ON CONFLICT(thread_id) DO UPDATE SET at=excluded.at, payload=excluded.payload",
      threadId, at, JSON.stringify(payload),
    );
  }

  /**
   * 该线程最新的压缩检查点（没有则 undefined）。
   * 空 payload / 坏 JSON 一律**视同没有检查点**：检查点的语义是「更早的历史被压成了这一段」，
   * 一个空前缀会让模型只看见检查点之后那几条 —— 宁可退回全量历史（多花 token），也不能把记忆清空。
   */
  compactedHistory(threadId: string): { payload: unknown[]; at: number } | undefined {
    const r = this.#db.get("SELECT at, payload FROM compactions WHERE thread_id = ?", threadId);
    if (!r) return undefined;
    let payload: unknown;
    try { payload = JSON.parse(String(r.payload)); } catch { return undefined; }
    return Array.isArray(payload) && payload.length > 0 ? { payload, at: Number(r.at) } : undefined;
  }

  /**
   * 交给 wire 装配的历史：有检查点 → 检查点**之后**产生的消息；没有 → 等价于 recentMessages。
   * 上限口径与 recentMessages 逐条对齐（同样过滤 undone_at、同样「最近 limit 条」、同样 DESC 取完再反转）——
   * 两条路径给出不同的顺序或条数，同一份历史就会有两个版本，而它们都自称「模型看到的历史」。
   */
  historyForWire(threadId: string, limit: number): Message[] {
    const cp = this.compactedHistory(threadId);
    if (!cp) return this.recentMessages(threadId, limit);
    const rows = this.#db.all(
      "SELECT * FROM messages WHERE thread_id = ? AND undone_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT ?",
      threadId, cp.at, limit,
    );
    return rows.reverse().map(rowToMessage);
  }

  deleteMessage(id: string): void { this.#db.run("DELETE FROM messages WHERE id = ?", id); }

  // ── 撤销（append-only：只加标记与日志，不删行、不改写正文） ──────────

  /** 可撤销的轮数 = 未撤销的真实用户消息条数（UI 拿它显示「还能撤几轮」） */
  undoableTurns(threadId: string): number {
    const rows = this.#db.all("SELECT * FROM messages WHERE thread_id = ? AND undone_at IS NULL AND role = 'user'", threadId);
    return rows.reduce((n, r) => n + (isRealUserMessage(rowToMessage(r)) ? 1 : 0), 0);
  }

  /**
   * 撤销最近 n 轮：把「最后 n 条真实用户消息」**及其之后**的消息标记为已撤销（undone_at）。
   *
   * 边界安全性（铁律一：每个 tool_call 必须配一条 tool 消息）：
   * 切点落在**真实用户消息**上，而一条 assistant 消息的调用与结果都在它自己的 parts 里 ——
   * 消息级的切点不可能切在配对中间。与 context/tokens.ts 的 findSafeSplitPoint 同一条纪律
   * （「切到回合边界、不留下孤儿 tool 结果」），只是这里切的是**尾巴**、切点不由预算决定。
   * 另外：区域里可能已经有更早一次撤销留下的标记，那些行的 undone_at 属于那一次，不能覆盖
   * （所以 UPDATE 带 `undone_at IS NULL`，返回值只算这次真正标记的）。
   *
   * 撤销同时**清掉该线程的压缩检查点**：撤销的语义是「回到更早的完整历史」，而检查点把更早的历史
   * 压成了一段摘要 —— 留着它等于撤销到一半（用户看见撤了，模型看到的还是摘要）。
   * 不试着聪明地「只清一部分」（比如判断这次撤销有没有撤进检查点里）：判错的那一次是**静默的历史错位**，
   * 而代价只是下次超限时再压一遍。
   */
  undoTurns(threadId: string, n: number): UndoResult {
    const rows = this.#db.all(
      "SELECT rowid AS _rowid, * FROM messages WHERE thread_id = ? AND undone_at IS NULL ORDER BY created_at ASC, rowid ASC",
      threadId,
    );
    const users = rows.filter((r) => r.role === "user" && isRealUserMessage(rowToMessage(r)));
    const available = users.length;
    if (!Number.isFinite(n) || Math.floor(n) < 1) {
      return { undone: 0, available, reason: `撤销轮数必须是 ≥ 1 的整数（收到 ${n}）` };
    }
    const want = Math.floor(n);
    if (available === 0) return { undone: 0, available, reason: "没有可撤销的内容：本线程没有真实用户消息（Nothing to undo: no user message to undo）" };
    if (want > available) {
      return {
        undone: 0, available,
        reason: `没有可撤销的内容：本线程只有 ${available} 轮可撤销，请求了 ${want} 轮（差 ${want - available} 轮）`,
      };
    }
    const boundary = users[available - want]!;
    const bCreated = Number(boundary.created_at);
    const bRowid = Number(boundary._rowid);
    const at = Date.now();
    const res = this.#db.raw().prepare(
      "UPDATE messages SET undone_at = ? WHERE thread_id = ? AND undone_at IS NULL AND (created_at > ? OR (created_at = ? AND rowid >= ?))",
    ).run(at, threadId, bCreated, bCreated, bRowid);
    const messages = Number(res.changes);
    const fromMessageId = String(boundary.id);
    // 清检查点（理由见上面 docstring）。放在这里不是别处：只有**真的执行了撤销**才谈得上「回到更早」。
    const checkpointCleared = Number(this.#db.raw().prepare("DELETE FROM compactions WHERE thread_id = ?").run(threadId).changes) > 0;
    // 撤销记录只追加进**线程日志**（永不改写/删除已有行）；写日志失败不该让撤销回滚 ——
    // 标记已经落到 SQLite 上了，这里再抛异常只会让调用方以为「没撤成」而重复撤销。
    try {
      this.#journalFor?.(threadId)?.append("context.undo", { turns: want, fromMessageId, availableBefore: available, messages, checkpointCleared }, {});
    } catch { /* 日志写失败：标记仍然有效 */ }
    return { undone: want, available, messages, fromMessageId, checkpointCleared };
  }

  // ── 工具结果老化（microcompaction） ───────────────────

  /**
   * 把**够老又够大**的 tool 结果正文落盘，库里那条 part 的正文换成指针。
   *
   * 老化是铁律二的**唯一例外**（wire-history.ts「重建 == 实时、逐字节」）：只换正文，结构 / 顺序 /
   * 配对一个字节不动；每条只换一次、换完就稳定，代价是从最新老化点起前缀重付一次（见 tools/result-aging.ts 顶部）。
   *
   * ⚠️ 边界（有意，别当成 bug）：**已经进压缩检查点的正文不再老化** —— payload 是那一刻真实上过 wire 的
   *    前缀字节（setCompactedHistory），改写它等于把一条已稳定、已缓存的前缀整段打断，而那批正是「最老最大」的。
   *    后果：检查点里的正文会一直留在前缀里直到下次压缩重写 payload，且库里说「已老化」而模型看到的仍是正文。
   * ⚠️ 规划交给注入的 planAging（session 不能 import tools）；`step:0 + currentStep:elapsed` 为什么成立见 planAging 的判据。
   * 「距今多少步」用 parts 里既有的 step-start 记号算（见 scanSteps）；落盘的是 `JSON.stringify(output)`
   * （模型在 wire 上看到的那个字节串 —— 不是 output 的某个字段），回读必须逐字节等于它。
   */
  async ageToolParts(threadId: string, workdir: string, plan: AgingPlanner | undefined = this.#planAging): Promise<{ aged: number }> {
    if (!plan || !workdir) return { aged: 0 };
    const rows = this.#db.all(
      "SELECT id, parts FROM messages WHERE thread_id = ? AND undone_at IS NULL ORDER BY created_at ASC, rowid ASC",
      threadId,
    );
    const scan = scanSteps(rows);
    const dirty = new Map<string, Part[]>();
    let aged = 0;
    for (const hit of scan.hits) {
      // 错误正文不动：它本来就短，而且是模型最该看到的东西（换掉等于把失败藏起来）
      if (hit.part.state !== "output-available" || isAgedBody(hit.part.output)) continue;
      const body = JSON.stringify(hit.part.output ?? {});
      const elapsed = scan.total - hit.step;
      if (elapsed <= TOOL_RESULT_AGING_AFTER_STEPS) continue;      // 还不够老
      if (body.length < TOOL_RESULT_AGING_MIN_CHARS) continue;     // 太小：指针本身也要花 token，换完省不下
      const plans = plan([{ key: `${hit.messageId}:${hit.index}`, text: body, step: 0, toolCallId: hit.part.toolCallId }], elapsed, workdir);
      const p = plans[0];
      if (!p) continue;   // 落盘失败 → 整条放弃（指针指着一个没写成功的文件比不老化更糟）
      hit.part.output = { _aged: true, spill_path: p.spillPath, note: p.pointerText };
      hit.part.spillPath = p.spillPath;
      aged++;
      let parts = dirty.get(hit.messageId);
      if (!parts) {
        let parsed: Part[] = [];
        try { parsed = JSON.parse(String(rows.find((r) => String(r.id) === hit.messageId)?.parts ?? "[]")) as Part[]; } catch { parsed = []; }
        dirty.set(hit.messageId, parsed);
        parts = parsed;
      }
      parts[hit.index] = hit.part;   // 按下标原地换正文：数组长度与顺序一个字节都不动
    }
    for (const [id, parts] of dirty) this.#db.run("UPDATE messages SET parts = ? WHERE id = ?", JSON.stringify(parts), id);
    return { aged };
  }

  // ── 幂等回执 ───────────────────────────────────────
  hasSideEffect(hash: string): boolean {
    return !!this.#db.get("SELECT 1 FROM side_effects WHERE content_hash = ?", hash);
  }
  recordSideEffect(hash: string, toolName: string, threadId: string): void {
    this.#db.run("INSERT OR IGNORE INTO side_effects(content_hash, tool_name, thread_id, created_at) VALUES (?,?,?,?)",
      hash, toolName, threadId, Date.now());
  }

  // ── projects ───────────────────────────────────────
  upsertProject(p: { id: string; name: string; path: string; port?: number; kind?: string }): void {
    const now = Date.now();
    this.#db.run(
      `INSERT INTO projects(id, name, path, port, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, port=excluded.port, updated_at=excluded.updated_at`,
      p.id, p.name, p.path, p.port ?? null, p.kind ?? "website", now, now,
    );
  }
  listProjects(): { id: string; name: string; path: string; port?: number; kind: string }[] {
    return this.#db.all("SELECT * FROM projects ORDER BY updated_at DESC").map((r) => ({
      id: String(r.id), name: String(r.name), path: String(r.path),
      port: r.port ? Number(r.port) : undefined, kind: String(r.kind),
    }));
  }
  /** 只解绑，不删磁盘目录 */
  removeProject(id: string): void { this.#db.run("DELETE FROM projects WHERE id = ?", id); }

  getProject(id: string): { id: string; name: string; path: string; port?: number; kind: string } | undefined {
    const r = this.#db.get("SELECT * FROM projects WHERE id = ?", id);
    if (!r) return undefined;
    return { id: String(r.id), name: String(r.name), path: String(r.path), port: r.port ? Number(r.port) : undefined, kind: String(r.kind) };
  }
}
