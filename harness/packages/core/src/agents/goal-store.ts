/**
 * Goal（长期目标）—— 存储与状态机
 *
 * 参考 DSH 的 goal，但砍掉它那套「投影 + 独立 driver」的双层架构：
 * - 一张表，一个线程至多一个 goal；
 * - revision 做**乐观并发**：模型必须拿 GetGoal 返回的 (id, revision) 才能改，
 *   过期就报 GOAL_STALE_REVISION，避免模型覆盖用户刚做的修改；
 * - phase 状态机：active → paused / blocked / complete，paused/blocked 可以 resume 回 active；
 * - DSH 的 activation（armed/disarmed）不落盘 —— 进程重启后由上层把活跃目标按 paused 处理，
 *   免得重启后无人看管地自动烧 token。
 *
 * 自动续跑的判定（谁在什么时候开下一轮）不在这里，在上层循环里；这里只负责
 * bumpRound（轮次 +1）与状态合法性。
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../session/db.ts";

export const GOAL_PHASES = ["active", "paused", "blocked", "complete"] as const;
export type GoalPhase = (typeof GOAL_PHASES)[number];

export const DEFAULT_MAX_GOAL_ROUNDS = 20;
export const MAX_GOAL_ROUNDS_CAP = 200;

export interface GoalRecord {
  id: string;
  threadId: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  roundsStarted: number;
  maxRounds: number;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export type GoalErrorCode =
  | "GOAL_NOT_FOUND" | "GOAL_ALREADY_EXISTS" | "GOAL_STALE_REVISION" | "GOAL_BAD_PHASE" | "GOAL_BAD_INPUT";

export class GoalError extends Error {
  readonly code: GoalErrorCode;
  constructor(code: GoalErrorCode, message: string) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}

function rowToGoal(r: Record<string, unknown>): GoalRecord {
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    revision: Number(r.revision),
    objective: String(r.objective),
    phase: String(r.phase) as GoalPhase,
    roundsStarted: Number(r.rounds_started),
    maxRounds: Number(r.max_rounds),
    blockedReason: (r.blocked_reason as string) ?? undefined,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** 轮次上限：正整数，且不超过 CAP（防止模型给自己开无限轮） */
export function normalizeMaxRounds(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_GOAL_ROUNDS;
  return Math.min(Math.floor(n), MAX_GOAL_ROUNDS_CAP);
}

export interface UpdateGoalInput {
  goalId: string;
  revision: number;
  action: "edit" | "pause" | "resume" | "complete" | "blocked";
  objective?: string;
  maxRounds?: number;
  blockedReason?: string;
}

export class GoalStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

  get(threadId: string): GoalRecord | null {
    const r = this.#db.get("SELECT * FROM goals WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1", threadId);
    return r ? rowToGoal(r) : null;
  }

  create(threadId: string, input: { objective: string; maxRounds?: number }): GoalRecord {
    const objective = (input.objective ?? "").trim();
    if (!objective) throw new GoalError("GOAL_BAD_INPUT", "objective 不能为空：用一句话说清「做完什么算完成」。");
    const existing = this.get(threadId);
    if (existing && existing.phase !== "complete") {
      throw new GoalError("GOAL_ALREADY_EXISTS",
        "这个会话已经有一个未完成的目标（" + existing.id + "，" + existing.phase + "）。"
        + "要改它用 UpdateGoal；要继续就先 resume，要重来就先 complete 或 clear。");
    }
    if (existing) this.clear(threadId);
    const now = Date.now();
    const rec: GoalRecord = {
      id: "goal_" + randomUUID().slice(0, 8),
      threadId,
      revision: 1,
      objective,
      phase: "active",
      roundsStarted: 0,
      maxRounds: normalizeMaxRounds(input.maxRounds),
      createdAt: now,
      updatedAt: now,
    };
    this.#db.run(
      "INSERT INTO goals(id, thread_id, revision, objective, phase, rounds_started, max_rounds, blocked_reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      rec.id, rec.threadId, rec.revision, rec.objective, rec.phase, rec.roundsStarted, rec.maxRounds, null, rec.createdAt, rec.updatedAt,
    );
    return rec;
  }

  /** 乐观并发 + 状态机；成功一次 revision +1 */
  update(threadId: string, input: UpdateGoalInput): GoalRecord {
    const cur = this.get(threadId);
    if (!cur) throw new GoalError("GOAL_NOT_FOUND", "这个会话还没有目标。");
    if (cur.id !== input.goalId) {
      throw new GoalError("GOAL_STALE_REVISION", "goal_id 对不上：当前目标是 " + cur.id + "（先 GetGoal 再改）。");
    }
    if (cur.revision !== input.revision) {
      throw new GoalError("GOAL_STALE_REVISION",
        "revision 过期：当前是 " + cur.revision + "，你给的是 " + input.revision + "（先 GetGoal 再改）。");
    }

    const action = input.action;
    const objective = input.objective?.trim();
    let phase: GoalPhase = cur.phase;
    let maxRounds = cur.maxRounds;
    let blockedReason = cur.blockedReason;

    if (action === "edit") {
      if (cur.phase === "complete") throw new GoalError("GOAL_BAD_PHASE", "目标已完成，改不动了；要新目标就再建一个。");
      if (!objective && input.maxRounds === undefined) {
        throw new GoalError("GOAL_BAD_INPUT", "edit 至少要给 objective 或 max_rounds 之一。");
      }
      if (input.maxRounds !== undefined) maxRounds = normalizeMaxRounds(input.maxRounds);
    } else if (action === "pause") {
      if (cur.phase !== "active") throw new GoalError("GOAL_BAD_PHASE", "只有 active 能 pause，现在是 " + cur.phase + "。");
      phase = "paused";
    } else if (action === "resume") {
      if (cur.phase === "complete") throw new GoalError("GOAL_BAD_PHASE", "已完成的目标不能 resume。");
      if (cur.phase === "active") throw new GoalError("GOAL_BAD_PHASE", "目标已经是 active 了。");
      if (cur.roundsStarted >= cur.maxRounds) {
        throw new GoalError("GOAL_BAD_PHASE",
          "轮次已用满（" + cur.roundsStarted + "/" + cur.maxRounds + "），先 edit 抬高 max_rounds 再 resume。");
      }
      phase = "active";
      blockedReason = undefined;
    } else if (action === "complete") {
      phase = "complete";
      blockedReason = undefined;
    } else if (action === "blocked") {
      if (cur.phase !== "active") throw new GoalError("GOAL_BAD_PHASE", "只有 active 能标 blocked，现在是 " + cur.phase + "。");
      const reason = (input.blockedReason ?? "").trim();
      if (!reason) throw new GoalError("GOAL_BAD_INPUT", "标 blocked 必须给 blocked_reason：说清是什么具体条件卡住了。");
      phase = "blocked";
      blockedReason = reason;
    } else {
      throw new GoalError("GOAL_BAD_INPUT", "未知 action：" + String(action));
    }

    const next: GoalRecord = {
      ...cur,
      revision: cur.revision + 1,
      phase,
      objective: objective && objective.length > 0 ? objective : cur.objective,
      maxRounds,
      blockedReason,
      updatedAt: Date.now(),
    };
    this.#write(next);
    return next;
  }

  /** 自动续跑：轮次 +1（乐观并发；轮次用满则报错，由上层转成 blocked） */
  bumpRound(threadId: string, goalId: string, revision: number): GoalRecord {
    const cur = this.get(threadId);
    if (!cur || cur.id !== goalId) throw new GoalError("GOAL_NOT_FOUND", "自动续跑时目标不见了。");
    if (cur.revision !== revision) throw new GoalError("GOAL_STALE_REVISION", "自动续跑时 revision 过期（用户可能刚改过目标）。");
    if (cur.phase !== "active") throw new GoalError("GOAL_BAD_PHASE", "只有 active 能续跑，现在是 " + cur.phase + "。");
    if (cur.roundsStarted >= cur.maxRounds) {
      throw new GoalError("GOAL_BAD_PHASE", "轮次已用满（" + cur.roundsStarted + "/" + cur.maxRounds + "）。");
    }
    const next: GoalRecord = { ...cur, revision: cur.revision + 1, roundsStarted: cur.roundsStarted + 1, updatedAt: Date.now() };
    this.#write(next);
    return next;
  }

  clear(threadId: string): void {
    this.#db.run("DELETE FROM goals WHERE thread_id = ?", threadId);
  }

  /** 只更新会变的列，避免整行覆盖造成的并发丢失 */
  #write(rec: GoalRecord): void {
    this.#db.run(
      "UPDATE goals SET revision=?, objective=?, phase=?, rounds_started=?, max_rounds=?, blocked_reason=?, updated_at=? WHERE id=?",
      rec.revision, rec.objective, rec.phase, rec.roundsStarted, rec.maxRounds, rec.blockedReason ?? null, rec.updatedAt, rec.id,
    );
  }
}

/** 给模型看的统一视图（工具返回用；不含 threadId 之类内部字段） */
export function goalView(rec: GoalRecord | null): Record<string, unknown> {
  if (!rec) return { goal: null, note: "当前会话没有目标。要长期推进就用 CreateGoal 建一个。" };
  const note = rec.phase === "active"
    ? "目标进行中（第 " + rec.roundsStarted + "/" + rec.maxRounds + " 轮）。做完并验证过再 UpdateGoal action=complete。"
    : rec.phase === "complete" ? "目标已完成。" : "目标已停止自动推进。";
  return {
    goal: {
      id: rec.id,
      revision: rec.revision,
      objective: rec.objective,
      phase: rec.phase,
      rounds_started: rec.roundsStarted,
      max_rounds: rec.maxRounds,
      ...(rec.blockedReason ? { blocked_reason: rec.blockedReason } : {}),
    },
    note,
  };
}
