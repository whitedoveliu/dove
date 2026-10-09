/**
 * 后台任务注册表（T6.3）
 * 关键纪律：结果注回原线程用 deferral / recent / consumed 状态机**防重复注入**。
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../session/db.ts";

export type TaskStatus = "running" | "done" | "error" | "canceled";

export interface TaskRecord {
  id: string;
  threadId: string;
  parentMessageId?: string;
  kind: string;
  prompt: string;
  status: TaskStatus;
  result?: string;
  injected: boolean;
  createdAt: number;
  finishedAt?: number;
}

function rowToTask(r: Record<string, unknown>): TaskRecord {
  return {
    id: String(r.id), threadId: String(r.thread_id),
    parentMessageId: (r.parent_message_id as string) ?? undefined,
    kind: String(r.kind), prompt: String(r.prompt),
    status: r.status as TaskStatus,
    result: (r.result as string) ?? undefined,
    injected: Number(r.injected) === 1,
    createdAt: Number(r.created_at),
    finishedAt: r.finished_at ? Number(r.finished_at) : undefined,
  };
}

export class TaskRegistry {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

  create(input: { threadId: string; prompt: string; kind?: string; parentMessageId?: string }): TaskRecord {
    const rec: TaskRecord = {
      id: `task_${randomUUID().slice(0, 8)}`, threadId: input.threadId,
      parentMessageId: input.parentMessageId, kind: input.kind ?? "subagent",
      prompt: input.prompt, status: "running", injected: false, createdAt: Date.now(),
    };
    this.#db.run(
      "INSERT INTO tasks(id, thread_id, parent_message_id, kind, prompt, status, injected, created_at) VALUES (?,?,?,?,?,?,?,?)",
      rec.id, rec.threadId, rec.parentMessageId ?? null, rec.kind, rec.prompt, rec.status, 0, rec.createdAt,
    );
    return rec;
  }

  finish(id: string, result: string, status: TaskStatus = "done"): void {
    this.#db.run("UPDATE tasks SET status=?, result=?, finished_at=? WHERE id=?", status, result, Date.now(), id);
  }

  get(id: string): TaskRecord | undefined {
    const r = this.#db.get("SELECT * FROM tasks WHERE id = ?", id);
    return r ? rowToTask(r) : undefined;
  }

  list(threadId?: string): TaskRecord[] {
    const rows = threadId
      ? this.#db.all("SELECT * FROM tasks WHERE thread_id = ? ORDER BY created_at DESC LIMIT 100", threadId)
      : this.#db.all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100");
    return rows.map(rowToTask);
  }

  /**
   * 取出「已完成但还没注回」的结果，并**原子地标记为已注入**。
   * 这是防重复注入的唯一入口 —— 不要绕过它直接查 result。
   */
  claimPendingInjections(threadId: string): TaskRecord[] {
    const rows = this.#db.all(
      "SELECT * FROM tasks WHERE thread_id = ? AND status IN ('done','error') AND injected = 0 ORDER BY finished_at ASC",
      threadId,
    );
    const tasks = rows.map(rowToTask);
    for (const t of tasks) this.#db.run("UPDATE tasks SET injected = 1 WHERE id = ?", t.id);
    return tasks;
  }
}
