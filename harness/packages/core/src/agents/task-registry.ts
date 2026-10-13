/**
 * 后台任务注册表（T6.3）
 * 关键纪律：结果注回原线程用 deferral / recent / consumed 状态机**防重复注入**。
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../session/db.ts";

export type TaskStatus = "running" | "done" | "error" | "canceled";

/** 后台任务的 token 用量（形状对齐 agents/subagent.ts 的 SubagentResult.usage） */
export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
}

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
  /** provider 报的 token 用量；**没报时是 undefined**（见 finish 的注释） */
  usage?: TaskUsage;
}

/** 坏 JSON / 缺字段一律当「没报」——一行脏数据不该把整张任务列表打挂 */
function parseUsage(raw: unknown): TaskUsage | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const u = JSON.parse(raw) as Partial<TaskUsage>;
    if (typeof u?.inputTokens !== "number" || typeof u?.outputTokens !== "number") return undefined;
    return { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
  } catch { return undefined; }
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
    usage: parseUsage(r.usage),
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

  /**
   * 收尾。usage 可选：provider 没报就**存 NULL**，绝不填一个 0 假数据。
   * 「全 0 = 没报」是这里的判据：子代理每次 stream 都至少带一段 prompt，真报了不可能
   * input 与 output 同时为 0；而 openai-compat 在没拿到 usage chunk 时回的就是全 0
   * （初值见 providers/openai-compat.ts），把它当数据存进去就是编造。
   */
  finish(id: string, result: string, status: TaskStatus = "done", usage?: TaskUsage): void {
    const u = usage && (usage.inputTokens > 0 || usage.outputTokens > 0) ? JSON.stringify(usage) : null;
    this.#db.run("UPDATE tasks SET status=?, result=?, finished_at=?, usage=? WHERE id=?", status, result, Date.now(), u, id);
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

/**
 * 任务结果注回的正文（runtime 把它并进当轮尾上下文）。
 * 从 agent/runtime.ts 搬过来（那边贴着 400 行硬约束）：写的是这张记录表的呈现，和状态机同处一室。
 * 措辞是纪律不是文案：结果用户已在界面上看过，模型**不许原样复述**。
 */
export function renderTaskInjection(tasks: TaskRecord[]): string {
  return [
    "<system-reminder>",
    "你之前派出去的后台任务有结果了：",
    "",
    ...tasks.map((t, i) => `【${i + 1}｜${t.kind}】\n${t.result ?? "(无结果)"}`),
    "",
    "这些结果用户已经在界面上看到了。**不要原样复述**，只在需要时基于它们继续推进任务。",
    "</system-reminder>",
  ].join("\n");
}
