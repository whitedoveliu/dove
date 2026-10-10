/**
 * CurrentTime —— 当前时间
 * 模型不知道"现在几点"，排定时任务、算相对时间、写时间戳都得先问一次。
 * 时间锚也会走 mt 尾部注入，但那只有日期，这里是精确到秒的。
 */
import { defineTool, S } from "../types.ts";
import { guarded } from "./util.ts";

function localTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function offsetText(d: Date): string {
  const min = -d.getTimezoneOffset();
  const sign = min >= 0 ? "+" : "-";
  const abs = Math.abs(min);
  return sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
}

export const CurrentTimeTool = defineTool({
  name: "CurrentTime",
  description: "当前时间：本地时间、UTC、时区与偏移、星期。排定时任务或需要精确时间时调用，不要凭印象猜。",
  parameters: S.obj({}, []),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: () => guarded(async () => {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    return {
      local: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate())
        + " " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()),
      utc: now.toISOString(),
      timezone: localTimezone(),
      utc_offset: offsetText(now),
      weekday: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()],
      epoch_ms: now.getTime(),
    };
  }),
});
