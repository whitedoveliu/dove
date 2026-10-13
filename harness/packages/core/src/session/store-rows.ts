/**
 * SQLite 行 → 领域对象（从 session/store.ts 搬出来；搬出来**只为**让 store.ts 守住 400 行上限）
 *
 * 这里只有两件机械的事：把一行映射成 Thread / Message，以及扫 parts 数出「这一步是第几步」。
 * 一个业务判断都没有 —— 搬动它不改变任何行为，测试也不需要跟着改。
 *
 * ⚠️ 下面这些兼容口径是搬动时**逐字保留**的，改它们等于改历史读法：
 *   ① metadata 列里的 origin / variant / tail 展开（消息级元数据的唯一落点）；
 *   ② 老库缺 undone_at 列时视同未撤销（补列在 store.ts 的 #migrateUndoColumn，这里只认「没有就是不撤销」）。
 */
import type { Message, Part, Thread, ToolPart, Usage } from "./types.ts";
import { isToolPart } from "./types.ts";

export function rowToThread(r: Record<string, unknown>): Thread {
  return {
    id: String(r.id), kind: (r.kind as Thread["kind"]) ?? "project",
    projectId: (r.project_id as string | null) ?? null,
    title: String(r.title ?? ""), model: String(r.model ?? "deepseek-flash"),
    metadata: JSON.parse(String(r.metadata ?? "{}")),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

export function rowToMessage(r: Record<string, unknown>): Message {
  // metadata 列是消息自带的来源标记（origin / variant / tail）的落点 —— 见 types.ts 的说明
  const meta = r.metadata ? (JSON.parse(String(r.metadata)) as Record<string, unknown>) : {};
  return {
    id: String(r.id), threadId: String(r.thread_id),
    role: r.role as Message["role"],
    parts: JSON.parse(String(r.parts ?? "[]")) as Part[],
    createdAt: Number(r.created_at),
    parentId: (r.parent_id as string | null) ?? null,
    depth: Number(r.depth ?? 0),
    usage: r.usage ? (JSON.parse(String(r.usage)) as Usage) : undefined,
    ...(meta.origin ? { origin: String(meta.origin) } : {}),
    ...(meta.variant ? { variant: String(meta.variant) } : {}),
    ...(meta.tail ? { tail: String(meta.tail) } : {}),
    ...(meta.turnDiff ? { turnDiff: meta.turnDiff as Message["turnDiff"] } : {}),
    // 老库（迁移前）没有这一列 → undefined = 未撤销
    ...(r.undone_at === null || r.undone_at === undefined ? {} : { undoneAt: Number(r.undone_at) }),
  };
}

/** 步扫描：给每个 tool part 标出它属于第几步（与 wire-history.ts 的切步规则同源） */
export interface ToolHit { messageId: string; index: number; part: ToolPart; step: number }

/**
 * 扫一遍全部 parts，得出「当前走到第几步」以及每个 tool part 属于第几步。
 * 记号（step-start）在 = 记号分步（runtime 每步开头打一个）；记号不在（老数据）= 退回
 * wire-history.ts 的老口径「每个 tool part 各自一步」——两处口径必须一致，否则「过了几步」会有两种答案。
 */
export function scanSteps(rows: { id: unknown; parts: unknown }[]): { total: number; hits: ToolHit[] } {
  let step = 0;
  const hits: ToolHit[] = [];
  for (const row of rows) {
    let parts: Part[] = [];
    try { parts = JSON.parse(String(row.parts ?? "[]")) as Part[]; } catch { continue; }
    const marked = parts.some((p) => p.type === "step-start");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.type === "step-start") { step++; continue; }
      if (!isToolPart(p)) continue;
      if (!marked) step++;   // 老口径：一个 tool part 一步
      hits.push({ messageId: String(row.id), index: i, part: p, step });
    }
  }
  return { total: step, hits };
}

/** 已经被老化过的正文（幂等：再跑一次 ageToolParts 不该二次替换） */
export function isAgedBody(output: unknown): boolean {
  return !!output && typeof output === "object" && (output as { _aged?: unknown })._aged === true;
}

/**
 * 写库时算 metadata 列：**在旧值上合并本次显式给的字段**，不是在空对象上重建。
 *
 * 为什么必须合并（而不是像以前那样只由入参构造）：`messages` 是 `INSERT OR REPLACE` ——
 * 同一个 id 重写一次，重建式写法会把上次写进去的 metadata **整体清空**（含 `tail` 与 `turnDiff`），
 * 而同一个落点的另一条路径 `setMessageTail` 却是显式 read-modify-write：同一个字段两种语义，
 * 谁先谁后决定数据在不在。今天所有调用点都用新 UUID（所以没见过现场），但那是埋着的雷：
 * `tail` 一丢，下一轮重建的 user 消息就少了尾上下文前缀（前缀缓存从那里断开、模型也看不到时间锚）。
 *
 * 只覆盖**显式给了**的字段（`!== undefined`）：没传的字段保留旧值 —— 这正是「合并」的含义，
 * 也是 `setMessageTail` 那种 read-modify-write 的语义。想清空某个字段得单独写一条 UPDATE。
 */
export function mergeMessageMeta(prevJson: unknown, m: Message): Record<string, unknown> {
  let meta: Record<string, unknown> = {};
  if (prevJson !== undefined && prevJson !== null) {
    try { meta = JSON.parse(String(prevJson)) as Record<string, unknown>; } catch { meta = {}; }
  }
  if (m.origin !== undefined) meta.origin = m.origin;
  if (m.variant !== undefined) meta.variant = m.variant;
  if (m.tail !== undefined) meta.tail = m.tail;
  if (m.turnDiff !== undefined) meta.turnDiff = m.turnDiff;
  return meta;
}
