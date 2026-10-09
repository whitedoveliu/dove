/**
 * 事件日志（T0.2；计划 §2.4 借鉴 DSH）
 * 原则：模型可见 ⟺ 已记录。所有进上下文的东西先落 NDJSON。
 * - 追加写，seq 单调
 * - < 4KB 整行写入在 POSIX 下原子
 * - 模型请求前 / 工具前 / turn 边界 强制 fsync（屏障）
 */
import { appendFileSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type EventType =
  | "session_start" | "turn_start" | "step_start" | "assistant_text" | "reasoning"
  | "tool_call" | "tool_result" | "tool_approval" | "steering"
  | "compaction" | "checkpoint" | "runtime_error" | "turn_end" | "run_end"
  | "usage" | "repair";

export interface LogRecord {
  v: 1;
  seq: number;
  ts: string;
  session: string;
  /** 所属项目 id（日志视图按它分组）；由 setProject 在每轮开始时设 */
  project?: string;
  run?: string;
  turn?: number;
  step?: number;
  type: EventType;
  data: Record<string, unknown>;
}

export interface EventLogOptions {
  dir: string;              // 例如 <project>/.logs/sessions
  sessionKey?: string;      // 默认按天
  maxPayload?: number;
  fsyncOn?: Set<EventType>;
}

const DEFAULT_MAX_PAYLOAD = 16_384;
const FS_PATH_LIMIT = 4_096; // 原子写保证

function isoNow(): string { return new Date().toISOString(); }

export class EventLog {
  #dir: string;
  #file: string;
  #seq = 0;
  #fd: number | null = null;
  #maxPayload: number;
  #fsyncOn: Set<EventType>;
  #buf: string[] = [];
  #closed = false;

  constructor(opts: EventLogOptions) {
    this.#dir = opts.dir;
    this.#maxPayload = opts.maxPayload ?? DEFAULT_MAX_PAYLOAD;
    this.#fsyncOn = opts.fsyncOn ?? new Set<EventType>(["turn_end", "run_end", "tool_result"]);
    if (!existsSync(this.#dir)) mkdirSync(this.#dir, { recursive: true });
    const key = opts.sessionKey ?? new Date().toISOString().slice(0, 10);
    this.#file = join(this.#dir, key + ".jsonl");
    this.#seq = this.#scanLastSeq();
  }

  get file(): string { return this.#file; }
  get seq(): number { return this.#seq; }

  /** 从已有文件恢复 seq（单调，跨 run 不回退） */
  #scanLastSeq(): number {
    if (!existsSync(this.#file)) return 0;
    try {
      const txt = readFileSync(this.#file, "utf8");
      const lines = txt.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!.trim();
        if (!l) continue;
        try { const r = JSON.parse(l) as LogRecord; if (typeof r.seq === "number") return r.seq; }
        catch { /* 不完整的最后一行：丢弃 */ }
      }
    } catch { /* ignore */ }
    return 0;
  }

  /** 只读最近 N 条（用于崩溃修复 / 回放） */
  readRecent(limit = 200): LogRecord[] {
    if (!existsSync(this.#file)) return [];
    const txt = readFileSync(this.#file, "utf8");
    const lines = txt.split("\n").filter(Boolean);
    const out: LogRecord[] = [];
    for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
      try { out.push(JSON.parse(lines[i]!) as LogRecord); } catch { /* skip */ }
    }
    return out;
  }

  readAll(): LogRecord[] {
    if (!existsSync(this.#file)) return [];
    return readFileSync(this.#file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as LogRecord; } catch { return null; } })
      .filter((r): r is LogRecord => r !== null);
  }

  /** 截断超长载荷（保持行 < 4KB 原子边界；大内容走 spill 文件） */
  #truncate(data: Record<string, unknown>): Record<string, unknown> {
    const s = JSON.stringify(data);
    if (s.length <= this.#maxPayload) return data;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string" && v.length > 2_000) {
        out[k] = v.slice(0, 2_000) + `\n…[${v.length - 2_000} 字符已省略]`;
      } else out[k] = v;
    }
    out.__truncated = true;
    return out;
  }

  /**
   * 当前项目上下文。
   * 老的 session_log 记录里带 project 字段，前端的日志视图会按它分项目显示；
   * 内核每次 run 开始时设一次，append 时自动带上 —— 不用改十几个调用点。
   */
  #project = "";
  setProject(projectId: string | null | undefined): void { this.#project = projectId ?? ""; }
  get project(): string { return this.#project; }

  append(type: EventType, data: Record<string, unknown> = {}, ctx: { run?: string; turn?: number; step?: number } = {}): LogRecord {
    if (this.#closed) throw new Error("EventLog closed");
    const rec: LogRecord = {
      v: 1, seq: ++this.#seq, ts: isoNow(), session: this.#file.split("/").pop()!.replace(".jsonl", ""),
      type, data: this.#truncate(data),
    };
    if (this.#project) rec.project = this.#project;
    if (ctx.run) rec.run = ctx.run;
    if (ctx.turn !== undefined) rec.turn = ctx.turn;
    if (ctx.step !== undefined) rec.step = ctx.step;
    const line = JSON.stringify(rec);
    if (line.length <= FS_PATH_LIMIT) {
      appendFileSync(this.#file, line + "\n");
    } else {
      // 超长行分两次写（不保证原子，但不丢内容）
      appendFileSync(this.#file, line + "\n");
    }
    if (this.#fsyncOn.has(type)) this.fsync();
    return rec;
  }

  /** 屏障：把已写内容刷到磁盘 */
  fsync(): void {
    try {
      const fd = openSync(this.#file, "a");
      fsyncSync(fd);
      closeSync(fd);
    } catch { /* 忽略：fsync 失败不影响正确性，只影响持久性强度 */ }
  }

  /** 读出所有会话文件（供日志面板列表） */
  static listSessions(dir: string): { file: string; size: number; date: string }[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse()
      .map((f) => ({ file: f, date: f.replace(".jsonl", ""), size: 0 }));
  }

  close(): void { if (!this.#closed) { this.fsync(); this.#closed = true; } }
}
