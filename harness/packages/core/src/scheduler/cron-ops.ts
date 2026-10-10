/**
 * CronOps 端口实现（CronCreate / CronList / CronDelete 用的真实后端）
 *
 * 为什么要有这一层：工具层不允许 import scheduler（依赖方向），
 * 所以调度器把自己收窄成一个**纯数据端口**交给 bootstrap 注入。
 *
 * 这里做三件调度器本身不管的事：
 *  ① 输入校验：type / mode 非法**直接报错**，绝不静默回落成 every/main
 *     （create() 内部的 isJobType 回落是给内部调用者的，模型传错必须让它知道）；
 *  ② 「间隔短到会烧钱」的告警：调度器只在 start() 时扫一遍，运行期新建的热任务没人管；
 *  ③ 时间：nextRunAt 等原样给出 epoch，展示交给工具（按任务时区渲染）。
 */
import { CRON_MIN_SANE_INTERVAL_MS } from "../constants.ts";
import type { CronCreateResult, CronJobInfo, CronOps } from "../tools/types.ts";
import { isJobMode, isJobType } from "./cron-model.ts";
import type { CronJob } from "./cron-model.ts";
import { localTimezone } from "./cron-parse.ts";
import { CronScheduler, parseEveryToMs } from "./cron.ts";

function toInfo(job: CronJob): CronJobInfo {
  return {
    id: job.id,
    name: job.name,
    type: job.type,
    schedule: job.schedule,
    mode: job.mode,
    prompt: job.prompt,
    enabled: job.enabled,
    timezone: job.timezone,
    createdAt: job.createdAt,
    nextRunAt: job.nextRunAt ?? null,
    lastRunAt: job.lastRunAt ?? null,
    runCount: job.runCount,
  };
}

/** every 任务短于警戒线 → 明确告警（这类事故不报错，只会安静地烧钱） */
function aggressiveWarning(job: CronJob): string | undefined {
  if (job.type !== "every") return undefined;
  const ms = parseEveryToMs(job.schedule);
  if (ms === null || ms <= 0 || ms >= CRON_MIN_SANE_INTERVAL_MS) return undefined;
  return "这个任务每 " + Math.round(ms / 1000) + " 秒触发一次，每次都会真实调用模型（每分钟约 "
    + Math.round(60_000 / ms) + " 轮）。确认是有意为之，否则尽快 CronDelete 掉。";
}

export function makeCronOps(scheduler: CronScheduler): CronOps {
  return {
    create(job): CronCreateResult {
      const type = job.type === undefined ? undefined : String(job.type);
      const mode = job.mode === undefined ? undefined : String(job.mode);
      if (type !== undefined && !isJobType(type)) {
        return { ok: false, error: "不支持的 type：" + type + "（只能是 at / every / cron）" };
      }
      if (mode !== undefined && !isJobMode(mode)) {
        return { ok: false, error: "不支持的 mode：" + mode + "（只能是 main / isolated）" };
      }
      try {
        const created = scheduler.create({
          name: job.name,
          type: isJobType(type) ? type : undefined,
          schedule: job.schedule,
          mode: isJobMode(mode) ? mode : undefined,
          prompt: job.prompt,
          timezone: job.timezone,
          model: job.model,
          deliverTo: job.deliverTo,
        });
        return { ok: true, job: toInfo(created), warning: aggressiveWarning(created) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    list(): CronJobInfo[] {
      return scheduler.list().map(toInfo);
    },

    remove(id: string): { ok: boolean; error?: string } {
      try {
        return scheduler.remove(id) ? { ok: true } : { ok: false, error: "任务不存在：" + id };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    timezone(): string {
      return localTimezone();
    },
  };
}
