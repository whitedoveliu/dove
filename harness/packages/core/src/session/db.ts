/**
 * SQLite 层（T0.3）—— 使用 Node 内置 node:sqlite，零原生依赖。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

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
  }

  #migrate(): void {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
    const current = row ? Number(row.value) : 0;
    if (current < SCHEMA_VERSION) {
      // 迁移点：v1 是初始版本，无历史数据需要迁移
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
