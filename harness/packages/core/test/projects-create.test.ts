/**
 * ProjectManager.create 的 id 生成 —— 同一毫秒里连着建两个项目**不许撞成同一个**。
 *
 * 历史坑：自动 id 以前是 `p${Date.now().toString(36)}`（只到毫秒）。同一毫秒里建两次 →
 * 同一个 id、同一个目录、同一条记录被覆盖，端口也只剩一个 —— 而这类「静默合并」
 * 在现场看着就像「我建的项目不见了」。smoke-preview 的夹具注释专门提醒过这件事，
 * 以至于所有脚本都得显式给 id 绕开它。
 *
 * 这里冻结时钟把毫秒钉死，断言 id / 目录 / 端口三者都不重复（修之前必红）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager, type ProjectRecord } from "../src/projects/manager.ts";
import type { Store } from "../src/session/store.ts";

/** 只喂 create 真正要用的三个方法（listProjects / getProject / upsertProject） */
function fakeStore(): Store {
  const rows = new Map<string, ProjectRecord>();
  return {
    listProjects: () => [...rows.values()],
    getProject: (id: string) => rows.get(id) ?? null,
    upsertProject: (rec: ProjectRecord) => { rows.set(rec.id, rec); },
  } as unknown as Store;
}

/** 冻结时钟跑一段：毫秒被钉死，自动 id 的基准必然相同 */
function withFrozenClock(fn: () => void): void {
  const real = Date.now;
  Date.now = () => 1_700_000_000_000;
  try { fn(); } finally { Date.now = real; }
}

test("create：同一毫秒连着建三个 → id / 目录 / 端口都不许撞", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dove-proj-id-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  withFrozenClock(() => {
    const pm = new ProjectManager({ store: fakeStore(), workspaceRoot: dir });
    const [a, b, c] = [pm.create({ name: "A" }), pm.create({ name: "B" }), pm.create({ name: "C" })];

    assert.equal(new Set([a.id, b.id, c.id]).size, 3, "id 互不相同：" + [a.id, b.id, c.id].join(", "));
    for (const p of [a, b, c]) {
      assert.ok(p.path.startsWith(dir), p.id + " 的目录要在工作区里：" + p.path);
      assert.ok(existsSync(p.path), p.id + " 的目录要真的建出来");
    }
    assert.equal(new Set([a.port, b.port, c.port]).size, 3, "端口也要各给一个：" + [a.port, b.port, c.port].join(", "));
    assert.equal(pm.list().length, 3, "三条记录都在");
  });
});

test("create：显式 id 原样用；自动 id 撞上它时顺延（-2 → -3），不覆盖别人的目录", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dove-proj-id2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  withFrozenClock(() => {
    const pm = new ProjectManager({ store: fakeStore(), workspaceRoot: dir });
    const base = `p${Date.now().toString(36)}`;
    const explicit = pm.create({ id: base, name: "显式" });
    assert.equal(explicit.id, base, "显式 id 不许被改写");

    const auto = pm.create({ name: "自动" });
    assert.equal(auto.id, base + "-2", "撞了就顺延到 -2");
    assert.notEqual(auto.path, explicit.path, "两条记录不许共用目录");

    const auto2 = pm.create({ name: "自动 2" });
    assert.equal(auto2.id, base + "-3");
    assert.equal(pm.list().length, 3);
  });
});
