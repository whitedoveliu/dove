/**
 * 定时任务的权限继承 —— 从 bootstrap.ts 拆出来（那边贴着 400 行上限），顺带让这条规则可被单测钉住。
 *
 * 为什么必须有：以前 cron 自建线程**不带 metadata**，runtime 便落到默认的 workspace-write ——
 * 用户明明把会话设成完全权限，定时任务却还在问权限（"落到默认值"是最难查的一类静默失败）。
 * 规则：继承**投递目标线程**的档位（它代表用户为这件事选过的权限）；取不到就显式落默认档。
 */
import type { Store } from "../../core/src/session/store.ts";
import { normalizeProfile, type PermissionProfile } from "../../core/src/tools/permission.ts";

/** 只取用得上的字段：CronJob 的其余部分与本模块无关（避免 server 层和 scheduler 的耦合） */
export interface CronPermissionJob { deliverTo?: string }

export function cronThreadMetadata(store: Store, job: CronPermissionJob): { permission: PermissionProfile } {
  const deliver = job.deliverTo ? store.getThread(job.deliverTo) : undefined;
  return { permission: normalizeProfile(deliver?.metadata ?? null) };
}
