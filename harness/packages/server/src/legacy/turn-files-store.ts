/**
 * 每轮文件改动的**落盘**（`turn_diff` 事件的持久化）。
 *
 * 为什么要有这一层：内核在回合末只把 `turn_diff` 发进 SSE 一次（core/agent/runtime.ts），
 * **不落库** —— 刷新页面 / 换设备重开，那一轮的「改了什么文件」就没了。
 * 面板要在每轮助手消息下面常驻展示这些文件，所以必须在 legacy 层补一份持久化。
 *
 * 键为什么是**消息 id**：面板的实时消息 id 是它自己生成的（对不上），而回放走 /api/history，
 * 那里的每条 assistant 消息都有内核给的稳定 id —— 用后者当键，回放时按 id 回填即可。
 * 落盘时机天然安全：内核先 `store.addMessage(assistantMsg)` 再发 `turn_diff`（runtime.ts 尾部），
 * 所以事件到达时「最近的那条 assistant 消息」一定是这一轮的那条。⚠️ 别退化成「最新一条消息」——
 * 同毫秒并列时最新一条可能是 user（见 newestAssistantMessageId 的注释）。
 *
 * 为什么用 SQLite 而不是项目里的 JSON：项目目录是用户的工作区（会被 git / 同步盘 / agent 自己碰），
 * 界面状态不该混进去；库文件本来就是内核的私有状态。
 */
import type { Services } from "../bootstrap.ts";
import type { LegacyTurnDiffFile } from "./sse-diff.ts";

/** 落盘的一轮改动（形状 = 老契约的 turn_diff 事件） */
export interface StoredTurnFiles {
  files: LegacyTurnDiffFile[];
  truncated: boolean;
  diff: string;
}

const TABLE = "legacy_turn_files";

/**
 * 建表**幂等**且跟着「谁先用到它」走 —— 与 core 的 compactions 表同一条纪律：
 * `CREATE TABLE IF NOT EXISTS` 本身就幂等，老库不需要删库重来，也不动 schema 版本号。
 * WeakSet 只是省下每次都 prepare 一次 DDL 的开销。
 */
const ensured = new WeakSet<object>();

function ensureTable(svc: Services): void {
  if (ensured.has(svc.db)) return;
  svc.db.run(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      message_id TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  svc.db.run(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_thread ON ${TABLE}(thread_id)`);
  ensured.add(svc.db);
}

/**
 * 这一轮那条 assistant 消息的 id（内核刚写完库，见文件头注释）；拿不到返回 null。
 *
 * 为什么是「取最近 5 条、从后往前找第一条 assistant」，而不是「取最新一条」：
 * created_at 只到毫秒，assistant 与它后面的 user 消息同毫秒**会发生** ——
 * 实测并列时 `recentMessages(threadId, 1)` 取到的是那条 user，于是 `role === "assistant"`
 * 判否 → 返回 null → 那一轮的 turn_diff 静默不落盘（刷新后文件卡片消失）。
 * 多取几条再按 role 找，对这种平局免疫，也补上「一轮里有不止一条 assistant」的情况。
 */
export function newestAssistantMessageId(svc: Services, threadId: string): string | null {
  try {
    const recent = svc.store.recentMessages(threadId, 5);
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (m && m.role === "assistant") return m.id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 每线程保留的最近轮数（老化上限）。
 *
 * 为什么必须有：每行最多带 20k 的 diff 正文，而这张表**只在线程删除 / 项目重置时**才清 ——
 * 一个长期使用的线程会只增不减（库文件是内核私有状态，但也不该无上限地长）。
 * 界面上一次只展示最近那几轮，200 轮早就饱和；多留的只是磁盘。
 */
const MAX_TURNS_PER_THREAD = 200;

/** 落盘（失败只记一行日志：**界面上的实时数据不受影响**，不该因为存不上就炸掉这一轮） */
export function saveTurnFiles(svc: Services, threadId: string, messageId: string, payload: StoredTurnFiles): void {
  if (payload.files.length === 0) return;
  try {
    ensureTable(svc);
    svc.db.run(
      `INSERT OR REPLACE INTO ${TABLE}(message_id, thread_id, payload, created_at) VALUES (?,?,?,?)`,
      messageId, threadId, JSON.stringify(payload), Date.now(),
    );
  } catch (e) {
    console.warn(`[turn-files] 落盘失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // 老化单独一个 try：本条已经写成功了，只是没清干净 —— 日志必须说清是「老化」而不是「落盘」，
  // 否则下一个人会当成丢数据去查（其实只是多留了几行）。ORDER BY 带 rowid 是为同毫秒并列兜底：
  // 否则 201 行同毫秒时子查询的顺序不确定，可能把**刚写进来的这条**删掉。
  try {
    svc.db.run(
      `DELETE FROM ${TABLE} WHERE thread_id = ? AND message_id NOT IN (
         SELECT message_id FROM ${TABLE} WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`, threadId, threadId, MAX_TURNS_PER_THREAD,
    );
  } catch (e) {
    console.warn(`[turn-files] 老化失败（本轮数据已落盘）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 按消息 id 批量取回（/api/history 用）。读不到 = 那一轮没有自报改动，不是错误。 */
export function loadTurnFiles(svc: Services, messageIds: string[]): Map<string, StoredTurnFiles> {
  const out = new Map<string, StoredTurnFiles>();
  const ids = messageIds.filter(Boolean);
  if (ids.length === 0) return out;
  try {
    ensureTable(svc);
    const holes = ids.map(() => "?").join(",");
    const rows = svc.db.all<{ message_id: string; payload: string }>(
      `SELECT message_id, payload FROM ${TABLE} WHERE message_id IN (${holes})`, ...ids,
    );
    for (const row of rows) {
      try {
        const parsed = JSON.parse(String(row.payload)) as StoredTurnFiles;
        if (Array.isArray(parsed?.files) && parsed.files.length > 0) {
          out.set(String(row.message_id), {
            files: parsed.files,
            truncated: parsed.truncated === true,
            diff: typeof parsed.diff === "string" ? parsed.diff : "",
          });
        }
      } catch { /* 坏 JSON 视同没有这一条 */ }
    }
  } catch (e) {
    console.warn(`[turn-files] 读回失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

/** 线程没了，它的每轮文件记录也不该留着（删除任务 / 重置任务时调用） */
export function clearTurnFilesForThread(svc: Services, threadId: string): void {
  try {
    ensureTable(svc);
    svc.db.run(`DELETE FROM ${TABLE} WHERE thread_id = ?`, threadId);
  } catch { /* 清理失败不影响删除本身 */ }
}

/**
 * 把落盘的一轮改动并进一条 /api/history 记录（回放路径）。
 *
 * 一轮里可能有不止一条 assistant 消息（目标续跑 / 图片落库），所以是**合并**不是覆盖：
 * 同路径的增删行数相加、`created` / `deleted` 取或，diff 正文按到达顺序拼起来。
 */
export function appendTurnFiles(record: Record<string, unknown>, tf: StoredTurnFiles): void {
  type Row = { path: string; added: number; removed: number; created?: boolean; deleted?: boolean };
  const prev = Array.isArray(record.turn_files) ? (record.turn_files as Row[]) : [];
  const byPath = new Map(prev.map((f) => [f.path, { ...f }]));
  for (const f of tf.files) {
    const old = byPath.get(f.path);
    byPath.set(f.path, old
      ? { path: f.path, added: old.added + f.added, removed: old.removed + f.removed, created: old.created || f.created, deleted: old.deleted || f.deleted }
      : { ...f });
  }
  record.turn_files = [...byPath.values()];
  if (tf.diff) record.turn_diff = record.turn_diff ? `${String(record.turn_diff)}\n${tf.diff}` : tf.diff;
  if (tf.truncated) record.turn_files_truncated = true;
}
