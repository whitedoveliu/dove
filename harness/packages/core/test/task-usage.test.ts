/**
 * 后台任务记录里的 token 用量（T6.3 的补口）。
 *
 * 三条纪律：
 *  ① 老库（tasks 没有 usage 列）打开时自动补列，**绝不要求用户删库**；
 *  ② 后台子代理收尾时把 provider 报的 usage 写进 tasks 记录（不只是发 task_done 事件）；
 *  ③ provider 没报（全 0）时存 NULL —— **不编 0 假数据**。
 *
 * 为什么单独一个文件：p0.test.ts / core.test.ts / subagent-roles.test.ts 都贴着 400 行硬约束。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { TaskRegistry } from "../src/agents/task-registry.ts";
import { SubagentHost } from "../src/agent/subagent-host.ts";
import type { ToolServices } from "../src/tools/types.ts";
import type { Provider, StreamResult } from "../src/providers/types.ts";

/** 假 provider：回一句结论，usage 按调用方给的报（全 0 = 「没报」，对齐 openai-compat 的退化值） */
function fakeProvider(usage: { inputTokens: number; outputTokens: number }): Provider {
  return {
    id: "stub-usage",
    stream: async (): Promise<StreamResult> => ({
      text: "结论：做完了", reasoning: "", toolCalls: [], finishReason: "stop",
      usage: { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

/** 临时目录 + 临时库文件（老库迁移必须走真实的磁盘文件，:memory: 测不出「打开已有库」这件事） */
function tmpDbFile(): string {
  return join(mkdtempSync(join(tmpdir(), "dove-task-usage-")), "dove.db");
}

/** 最小可跑的子代理宿主（不挂任何工具：假的 provider 只回纯文本，一步就到最终答复）。
 *  库用临时目录里的真实文件（不是 :memory:）：迁移 + 落盘两条路都要按真库走一遍。 */
function makeHost(provider: Provider, sink: (e: Record<string, unknown>) => void) {
  const db = new Db(tmpDbFile());
  const store = new Store(db);
  const tasks = new TaskRegistry(db);
  store.createThread({ id: "th_parent", kind: "project", title: "父线程" });
  const services: ToolServices = {};
  const host = new SubagentHost({
    provider, model: "deepseek-flash", tools: new Map(),
    execDeps: {
      ctxBase: {
        threadId: "th_parent", workdir: tmpdir(), outputsDir: tmpdir(),
        emit: () => { /* 事件不参与断言 */ }, services,
      },
      resolveApproval: async () => ({ approved: true }),
    },
    store, tasks, parentThreadId: "th_parent", sink, services,
  });
  return { host, tasks, db };
}

// ── 1. 老库迁移：不许要求删库 ─────────────────────────────────
test("老库（tasks 没有 usage 列）：打开自动补列，老记录照样读、照样能收尾", () => {
  const file = tmpDbFile();
  // 手搓一个「老版本建的库」：tasks 表就是旧代码的那份 DDL（没有 usage 列）
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, parent_message_id TEXT,
      kind TEXT NOT NULL DEFAULT 'subagent', prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', result TEXT,
      injected INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER
    );
    INSERT INTO tasks(id, thread_id, kind, prompt, status, result, injected, created_at, finished_at)
      VALUES ('task_old', 'th_1', '老任务', '老提示词', 'done', '老结果', 1, 1, 2);
  `);
  old.close();

  const db = new Db(file);   // 打开老库：迁移在这里发生
  const cols = db.all<{ name: string }>("PRAGMA table_info(tasks)");
  assert.ok(cols.some((c) => c.name === "usage"), "打开老库必须自动补上 usage 列（ALTER TABLE ADD COLUMN）");

  const reg = new TaskRegistry(db);
  const legacy = reg.get("task_old");
  assert.equal(legacy?.result, "老结果", "补列不许动老数据");
  assert.equal(legacy?.usage, undefined, "老记录没有 usage → undefined（不是 0）");
  reg.finish("task_old", "补跑", "done", { inputTokens: 7, outputTokens: 3 });
  assert.deepEqual(reg.get("task_old")?.usage, { inputTokens: 7, outputTokens: 3 }, "补列之后老记录也写得进新字段");
  db.close();
});

// ── 2. 注册表：报了才存，没报存 NULL ──────────────────────────
test("TaskRegistry：报了 usage 落 JSON；没报 / 全 0 存 NULL（不是 0）", () => {
  const db = new Db(":memory:");
  const reg = new TaskRegistry(db);

  const a = reg.create({ threadId: "th", prompt: "有报表" });
  reg.finish(a.id, "done", "done", { inputTokens: 12, outputTokens: 3 });
  assert.deepEqual(reg.get(a.id)?.usage, { inputTokens: 12, outputTokens: 3 });

  const b = reg.create({ threadId: "th", prompt: "没报表" });
  reg.finish(b.id, "done");
  assert.equal(reg.get(b.id)?.usage, undefined);
  assert.equal(db.get<{ usage: unknown }>("SELECT usage FROM tasks WHERE id = ?", b.id)?.usage, null, "没报 → SQL NULL");

  const c = reg.create({ threadId: "th", prompt: "全 0 表" });
  reg.finish(c.id, "done", undefined, { inputTokens: 0, outputTokens: 0 });
  assert.equal(reg.get(c.id)?.usage, undefined, "全 0 = provider 没报，存 NULL 而不是 0");
  assert.equal(db.get<{ usage: unknown }>("SELECT usage FROM tasks WHERE id = ?", c.id)?.usage, null);

  // 列表 / 状态机路径同样读得到（usage 只是追加字段，没动既有形状）
  const listed = reg.list("th").find((t) => t.id === a.id);
  assert.deepEqual(listed?.usage, { inputTokens: 12, outputTokens: 3 });
  db.close();
});

// ── 3. 后台子代理端到端：宿主把 usage 传进注册表 ──────────────
test("后台子代理跑完：usage 进 tasks 记录（数值来自 provider），task_done 事件形状不变", async () => {
  const events: Record<string, unknown>[] = [];
  const { host, tasks } = makeHost(fakeProvider({ inputTokens: 11, outputTokens: 7 }), (e) => events.push(e));

  const r = await host.spawn("算个数", "算数", true);
  assert.equal(r.status, "running");
  assert.ok(r.taskId, "后台派活要立刻拿到 taskId");

  assert.ok(await waitFor(() => tasks.get(r.taskId!)?.status === "done"), "任务应当收尾");
  const rec = tasks.get(r.taskId!)!;
  assert.deepEqual(rec.usage, { inputTokens: 11, outputTokens: 7 }, "usage 必须来自 provider 报的数");
  assert.equal(typeof rec.result, "string");

  const ev = events.find((e) => e.type === "task_done");
  assert.deepEqual(ev?.usage, { inputTokens: 11, outputTokens: 7 }, "task_done 事件照旧带 usage（向后兼容）");
  // TaskOutput 的读路径（host.getTask）也拿得到 —— 追加字段，不删旧字段
  assert.deepEqual(host.getTask(r.taskId!)?.usage, { inputTokens: 11, outputTokens: 7 });
  assert.equal(host.getTask(r.taskId!)?.status, "done");
});

test("后台子代理：provider 没报 usage（全 0）→ 记录里缺省，不是 0", async () => {
  const { host, tasks, db } = makeHost(fakeProvider({ inputTokens: 0, outputTokens: 0 }), () => { /* 不收集 */ });

  const r = await host.spawn("算个数", "算数", true);
  assert.ok(await waitFor(() => tasks.get(r.taskId!)?.status === "done"), "任务应当收尾");
  assert.equal(tasks.get(r.taskId!)?.usage, undefined, "没报就是没有，不许编 0");
  assert.equal(db.get<{ usage: unknown }>("SELECT usage FROM tasks WHERE id = ?", r.taskId!)?.usage, null);
  assert.equal(host.getTask(r.taskId!)?.usage, undefined);
});
