/**
 * 权限的**继承与派生**：后台线程的档位必须显式，计划模式必须是硬只读。
 *
 * 起因（线上真实症状）：用户把会话设成「完全权限」，定时任务/后台线程却还在问权限 ——
 * 因为那些线程是**新建的、没带 metadata**，runtime 便落到默认的 workspace-write。
 * 这类"落到默认值"的失败最安静：不报错、不告警，只是行为不对。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { cronThreadMetadata } from "../../server/src/cron-permission.ts";
import { resolveMode, planAwareMode } from "../src/agent/plan-mode.ts";
import { DEFAULT_PROFILE } from "../src/tools/permission.ts";
import type { Store } from "../src/session/store.ts";

/** cronThreadMetadata 只用到 getThread */
function storeWith(threads: Record<string, Record<string, unknown>>): Store {
  return {
    getThread: (id: string) => (threads[id] ? { id, kind: "project", projectId: null, title: id, metadata: threads[id]! } : undefined),
  } as unknown as Store;
}

test("cron 自建线程继承投递目标线程的档位（不再是「没带 metadata → 默认档」）", () => {
  const store = storeWith({
    th_full: { permission: { sandbox: "danger-full-access", approval: "never", writableRoots: [] } },
    th_restricted: { permission: { sandbox: "read-only", approval: "never", writableRoots: ["/extra"] } },
    th_legacy: { permissionMode: "full" },   // 老数据（旧枚举）
  });
  assert.equal(cronThreadMetadata(store, { deliverTo: "th_full" }).permission.sandbox, "danger-full-access");
  assert.equal(cronThreadMetadata(store, { deliverTo: "th_full" }).permission.approval, "never");
  assert.deepEqual(cronThreadMetadata(store, { deliverTo: "th_restricted" }).permission.writableRoots, ["/extra"]);
  assert.equal(cronThreadMetadata(store, { deliverTo: "th_legacy" }).permission.sandbox, "danger-full-access", "旧枚举也要双读到");
  // 取不到投递目标 → **显式**落默认档（而不是"什么都没写"）
  assert.deepEqual(cronThreadMetadata(store, {}).permission, DEFAULT_PROFILE);
  assert.deepEqual(cronThreadMetadata(store, { deliverTo: "不存在" }).permission, DEFAULT_PROFILE);
});

test("resolveMode：计划模式 = 硬只读（sandbox 抬到 read-only），且不动审批轴", () => {
  const full = { permission: { sandbox: "danger-full-access", approval: "never", writableRoots: ["/x"] } };
  assert.equal(resolveMode(full).profile.sandbox, "danger-full-access");
  const planned = resolveMode({ ...full, planMode: true });
  assert.equal(planned.planMode, true);
  assert.equal(planned.profile.sandbox, "read-only", "计划模式必须硬只读");
  assert.deepEqual(planned.profile.writableRoots, ["/x"], "只抬沙箱轴，别把用户的可写根丢掉");
  // 更老的 readOnly 布尔同样生效
  assert.equal(resolveMode({ readOnly: true }).profile.sandbox, "read-only");
  assert.deepEqual(resolveMode(null).profile, DEFAULT_PROFILE);
});

test("planAwareMode 兼容出口：仍旧返回旧枚举，供未迁移的调用方使用", () => {
  assert.equal(planAwareMode({ permissionMode: "full" }).permissionMode, "danger-full-access");
  assert.equal(planAwareMode({ planMode: true, permissionMode: "full" }).permissionMode, "read-only");
  assert.equal(planAwareMode({}).permissionMode, "workspace-write");
});
