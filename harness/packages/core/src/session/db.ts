/**
 * SQLite 层（T0.3）—— 使用 Node 内置 node:sqlite，零原生依赖。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION, DROP_LEGACY_SQL } from "./schema.ts";

export type Row = Record<string, unknown>;

export class Db {
  #db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") {
      const d = dirname(file);
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
    this.#db = new DatabaseSync(file);
    this.#db.exec(SCHEMA_SQL);
    this.#migrate();
    this.#ensureTaskUsageColumn();
    this.#ensureCompactionsTable();
  }

  /**
   * compactions 表：线程级的「压缩检查点」（一次只留最新一条）。
   *
   * 老库打开时自动补齐，**绝不要求用户删库** —— 与下面 tasks.usage 补列、store.ts 里 messages.undone_at
   * 补列同一条纪律。区别只在于这是个**新表**：`CREATE TABLE IF NOT EXISTS` 本身就幂等，
   * 不需要 PRAGMA 现查现补，也不需要动 SCHEMA_VERSION（迁移号留给「已有的表结构变了」那种事）。
   * 放在 Db 构造函数里而不是调用方：读这张表的路径不止一条（装配 wire / 撤销 / 面板），
   * 建表跟着「谁打开的库」走，就不会有「谁先打开谁负责」的时序坑。
   */
  #ensureCompactionsTable(): void {
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS compactions (
        thread_id TEXT PRIMARY KEY,
        at        INTEGER NOT NULL,
        payload   TEXT NOT NULL
      )`,
    );
  }

  /**
   * tasks.usage 列迁移：老库（tasks 表没有 usage 列）打开时自动补上 —— **绝不要求用户删库**。
   * 为什么不写进 schema.ts 的 CREATE TABLE：`CREATE TABLE IF NOT EXISTS` 对已存在的表一个字都不补
   * （同 session/store.ts 里 messages.undone_at 的做法），所以按 PRAGMA 现查现补，幂等、不依赖版本号。
   * 放在 Db 而不是 TaskRegistry：读 tasks 的路径不止一条（TaskOutput / ListAgents / RuntimeStatus），
   * 迁移跟着「谁打开的库」走，就不会有「谁先打开谁负责」的时序坑。
   */
  #ensureTaskUsageColumn(): void {
    const cols = this.#db.prepare("PRAGMA table_info(tasks)").all() as Row[];
    if (!cols.some((c) => String(c.name) === "usage")) {
      this.#db.exec("ALTER TABLE tasks ADD COLUMN usage TEXT");
    }
  }

  #migrate(): void {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
    const current = row ? Number(row.value) : 0;
    if (current < SCHEMA_VERSION) {
      // 迁移点：v1 是初始版本，无历史数据需要迁移。
      // v5：M7 感知层已整体移除 —— 旧库里残留的 activity_* 表一次性清掉（幂等，新库上是空操作）。
      if (current < 5) this.#db.exec(DROP_LEGACY_SQL);
      this.#db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(SCHEMA_VERSION));
    }
  }

  raw(): DatabaseSync { return this.#db; }

  run(sql: string, ...params: unknown[]): void { this.#db.prepare(sql).run(...(params as never[])); }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.#db.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.#db.prepare(sql).all(...(params as never[])) as T[];
  }

  tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN");
    try { const r = fn(); this.#db.exec("COMMIT"); return r; }
    catch (e) { try { this.#db.exec("ROLLBACK"); } catch { /* ignore */ } throw e; }
  }

  close(): void { this.#db.close(); }
}
