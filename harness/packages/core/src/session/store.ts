/**
 * 线程 / 消息 CRUD（SQLite 派生视图）
 * 真相源是事件日志；这里只做加速查询与 UI 回放。
 */
import type { Db } from "./db.ts";
import type { Message, Thread, Part, Usage } from "./types.ts";

function rowToThread(r: Record<string, unknown>): Thread {
  return {
    id: String(r.id), kind: (r.kind as Thread["kind"]) ?? "project",
    projectId: (r.project_id as string | null) ?? null,
    title: String(r.title ?? ""), model: String(r.model ?? "deepseek-flash"),
    metadata: JSON.parse(String(r.metadata ?? "{}")),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

function rowToMessage(r: Record<string, unknown>): Message {
  return {
    id: String(r.id), threadId: String(r.thread_id),
    role: r.role as Message["role"],
    parts: JSON.parse(String(r.parts ?? "[]")) as Part[],
    createdAt: Number(r.created_at),
    parentId: (r.parent_id as string | null) ?? null,
    depth: Number(r.depth ?? 0),
    usage: r.usage ? (JSON.parse(String(r.usage)) as Usage) : undefined,
  };
}

export class Store {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

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
  addMessage(m: Message): void {
    this.#db.run(
      "INSERT OR REPLACE INTO messages(id, thread_id, role, parts, metadata, parent_id, depth, created_at, usage) VALUES (?,?,?,?,?,?,?,?,?)",
      m.id, m.threadId, m.role, JSON.stringify(m.parts), "{}", m.parentId ?? null, m.depth ?? 0, m.createdAt,
      m.usage ? JSON.stringify(m.usage) : null,
    );
    this.#db.run("UPDATE threads SET updated_at = ? WHERE id = ?", Date.now(), m.threadId);
  }

  listMessages(threadId: string, limit = 500): Message[] {
    return this.#db.all("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?", threadId, limit).map(rowToMessage);
  }

  recentMessages(threadId: string, limit = 40): Message[] {
    const rows = this.#db.all("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?", threadId, limit);
    return rows.reverse().map(rowToMessage);
  }

  deleteMessage(id: string): void { this.#db.run("DELETE FROM messages WHERE id = ?", id); }

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
