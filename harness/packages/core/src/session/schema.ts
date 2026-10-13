/**
 * SQLite 表定义（T0.3；计划 §2.2）
 * 真相源是事件日志；SQLite 只是派生视图（加速查询）。
 */
// v2：M6 cron_* 新表
// v4：goals —— 长期目标（每线程至多一个），跨轮自动续跑靠它
// v5：移除 M7 感知层（activity_* 全部表）；旧库里的残留由 DROP_LEGACY_SQL 清理
export const SCHEMA_VERSION = 5;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'project',   -- home | project
  project_id  TEXT,
  title       TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT 'deepseek-flash',
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_kind ON threads(kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  role        TEXT NOT NULL,
  parts       TEXT NOT NULL DEFAULT '[]',
  metadata    TEXT NOT NULL DEFAULT '{}',
  parent_id   TEXT,
  depth       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  usage       TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

-- 记忆（L2 向量层；Alma p05）
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  content       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'fact',
  scope         TEXT NOT NULL DEFAULT 'global',   -- global | project:<id>
  metadata      TEXT NOT NULL DEFAULT '{}',
  thread_id     TEXT,
  message_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | pending | archived
  confidence    REAL NOT NULL DEFAULT 1.0,
  embedding     BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, status);
CREATE INDEX IF NOT EXISTS idx_memories_model ON memories(embedding_model);

CREATE TABLE IF NOT EXISTS memory_sleep_runs (
  id          TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  status      TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  examined    INTEGER NOT NULL DEFAULT 0,
  archived_exact     INTEGER NOT NULL DEFAULT 0,
  archived_expired   INTEGER NOT NULL DEFAULT 0,
  archived_orphan    INTEGER NOT NULL DEFAULT 0,
  archived_similarity INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);

-- 后台任务（T6.3）
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  parent_message_id TEXT,
  kind        TEXT NOT NULL DEFAULT 'subagent',
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',   -- running | done | error | canceled
  result      TEXT,
  injected    INTEGER NOT NULL DEFAULT 0,        -- 结果是否已注回原线程（防重复注入）
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id, created_at);

-- 幂等回执（写类工具）
CREATE TABLE IF NOT EXISTS side_effects (
  content_hash TEXT PRIMARY KEY,
  tool_name    TEXT NOT NULL,
  thread_id    TEXT,
  created_at   INTEGER NOT NULL
);

-- 项目（工作区）
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  port        INTEGER,
  kind        TEXT NOT NULL DEFAULT 'website',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 定时任务（T6.7）：cron_jobs 是定义，cron_history 是每次执行的收据
CREATE TABLE IF NOT EXISTS cron_jobs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,                    -- at | every | cron
  schedule    TEXT NOT NULL,                    -- ISO/相对时间 | 间隔 | 5 段表达式
  mode        TEXT NOT NULL DEFAULT 'main',     -- main | isolated
  prompt      TEXT NOT NULL DEFAULT '',
  deliver_to  TEXT,
  model       TEXT,
  timezone    TEXT,                             -- 缺省 = 本地时区
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  last_run_at INTEGER,
  next_run_at INTEGER,
  run_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_due ON cron_jobs(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS cron_history (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  job_name    TEXT NOT NULL DEFAULT '',
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  ok          INTEGER NOT NULL DEFAULT 0,
  result      TEXT,
  error       TEXT,
  trigger     TEXT NOT NULL DEFAULT 'schedule', -- schedule | manual
  receipt     TEXT                              -- 一次性任务的收据
);
CREATE INDEX IF NOT EXISTS idx_cron_history_job ON cron_history(job_id, started_at DESC);

-- 长期目标（v4）：一个线程至多一个 goal；revision 做乐观并发。
-- phase: active | paused | blocked | complete
CREATE TABLE IF NOT EXISTS goals (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 1,
  objective      TEXT NOT NULL,
  phase          TEXT NOT NULL DEFAULT 'active',
  rounds_started INTEGER NOT NULL DEFAULT 0,
  max_rounds     INTEGER NOT NULL DEFAULT 20,
  blocked_reason TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_thread ON goals(thread_id, updated_at DESC);
`;

/**
 * v5 清理：M7 感知层已整体移除，旧库里残留的 activity_* 表（连同索引）在这里一次性清掉 ——
 * 否则它们会变成没人认识、也永远不会再被写入的孤儿表。DROP TABLE 幂等，新库上是空操作。
 */
export const DROP_LEGACY_SQL = `
DROP TABLE IF EXISTS activity_snapshots;
DROP TABLE IF EXISTS activity_ocr_frames;
DROP TABLE IF EXISTS activity_ocr_terms;
DROP TABLE IF EXISTS activity_events;
DROP TABLE IF EXISTS activity_sessions;
DROP TABLE IF EXISTS activity_summaries;
`;
