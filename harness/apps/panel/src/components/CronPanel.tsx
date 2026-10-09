/**
 * 任务 tab：定时任务（列表 / 新建 / 开关 / 立即执行 / 删除）+ 手动心跳 + 运行历史。
 * 接口：GET|POST /api/cron、DELETE /api/cron/:id、POST /api/cron/:id/run、
 *       GET /api/cron/history、POST /api/heartbeat。
 * 内核未接入定时服务时返回 { available:false } 或 400「定时服务未接入」——一律降级提示，不报错。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Empty, Notice, Spinner, cn } from "./ui/Primitives.tsx";
import { JobForm } from "./CronForm.tsx";
import { api } from "../lib/api.ts";
import { formatWhen } from "../lib/format.ts";
import type { CronJob, CronRun, HeartbeatResult } from "../types.ts";

const MODE_LABEL: Record<string, string> = { main: "主线程", isolated: "独立会话" };

const REASON_TEXT: Record<string, string> = {
  "off-hours": "不在工作时段，本轮跳过",
  "in-flight": "有任务正在执行，本轮跳过",
  "heartbeat-ok": "一切正常，未打扰",
  empty: "没有需要汇报的内容",
  "run-failed": "本轮执行失败",
  "deliver-failed": "结果投递失败",
  未接入: "心跳服务未接入",
};

/** 心跳返回 → 一句中文 + 原始输出 */
function heartText(r: HeartbeatResult | null): { text: string; tone: "dim" | "warn" | "info"; output: string } {
  if (!r) return { text: "", tone: "dim", output: "" };
  const output = String(r.output ?? "");
  const ok = r.suppressed || r.reason === "heartbeat-ok" || /HEARTBEAT_OK/i.test(output);
  const reason = r.reason ? (REASON_TEXT[r.reason] ?? r.reason) : "";
  const text = ok
    ? "一切正常，未打扰"
    : r.ran === false
      ? "本轮未执行" + (reason ? "：" + reason : "")
      : reason || "已执行";
  const tone: "dim" | "warn" | "info" = /失败|未接入|错误/.test(text) ? "warn" : ok ? "dim" : "info";
  return { text, tone, output };
}

function typeTone(type: string): "accent" | "info" | "think" {
  if (type === "cron") return "accent";
  if (type === "every") return "info";
  return "think";
}

/* ---------------- 主面板 ---------------- */

export function CronPanel() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [available, setAvailable] = useState(true);
  const [history, setHistory] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [beat, setBeat] = useState<HeartbeatResult | null>(null);
  const [beating, setBeating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.cron();
      setAvailable(res?.available !== false);
      setJobs(Array.isArray(res?.jobs) ? res.jobs : []);
    } catch (err) {
      setAvailable(false);
      setJobs([]);
      setNotice("读取定时任务失败：" + (err as Error).message);
    }
    try {
      setHistory(await api.cronHistory(30));
    } catch {
      setHistory([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 开关：内核只暴露 create / delete / run，这里用「删除 + 复用同一 id 重建」实现，历史按 jobId 关联因此不丢 */
  const toggle = async (job: CronJob) => {
    setBusyId(job.id);
    setNotice(null);
    try {
      await api.removeCron(job.id);
      try {
        await api.createCron({ ...job, enabled: !job.enabled });
      } catch (err) {
        await api.createCron({ ...job }).catch(() => undefined); // 尽力还原
        throw err;
      }
      await load();
    } catch (err) {
      setNotice("切换启用状态失败：" + (err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (job: CronJob) => {
    setBusyId(job.id);
    setNotice(null);
    try {
      const r = await api.runCron(job.id);
      if (r?.ok === false) setNotice("「" + job.name + "」执行失败：" + (r.error ?? "未知原因"));
      else setNotice("「" + job.name + "」已执行" + (r?.result ? "：" + String(r.result).slice(0, 200) : ""));
      await load();
    } catch (err) {
      setNotice("执行失败：" + (err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (job: CronJob) => {
    setBusyId(job.id);
    setNotice(null);
    try {
      await api.removeCron(job.id);
      await load();
    } catch (err) {
      setNotice("删除失败：" + (err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const heartbeat = async () => {
    setBeating(true);
    try {
      setBeat(await api.heartbeat());
    } catch (err) {
      setBeat({ ran: false, reason: (err as Error).message });
    } finally {
      setBeating(false);
    }
  };

  const hb = heartText(beat);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {/* 心跳 */}
      <div className="border-b border-line px-2 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wide text-fg-mute">主动心跳</span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost" onClick={() => void heartbeat()} disabled={beating}>
            {beating ? "执行中…" : "立刻跑一次心跳"}
          </Button>
        </div>
        {beat ? (
          <div className="mt-1.5 space-y-1">
            <Notice tone={hb.tone}>{hb.text}</Notice>
            {hb.output ? (
              <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-1.5 font-mono text-[10px] text-fg-dim">
                {hb.output}
              </pre>
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-[11px] text-fg-mute">
            HEARTBEAT.md 的自检清单，返回 HEARTBEAT_OK 时不会打扰你。
          </p>
        )}
      </div>

      {/* 定时任务 */}
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg-mute">
          定时任务 {jobs.length}
          {!available ? " · 未接入" : ""}
        </span>
        <span className="flex-1" />
        <Button size="xs" variant="subtle" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "收起表单" : "+ 新建"}
        </Button>
        <Button size="xs" variant="subtle" onClick={() => void load()} title="重新拉取任务与历史">
          刷新
        </Button>
      </div>

      {!available ? (
        <div className="px-2 pt-2">
          <Notice>
            定时服务未接入（内核返回 available:false）。列表与历史会保持为空，新建 / 执行会由内核返回「定时服务未接入」。
          </Notice>
        </div>
      ) : null}

      {notice ? (
        <p className="border-b border-line px-2 py-1 font-mono text-[10px] leading-relaxed text-warn">{notice}</p>
      ) : null}

      {showForm ? <JobForm onCreated={(msg) => { setNotice(msg); void load(); }} /> : null}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-fg-mute">
          <Spinner /> 读取定时任务…
        </div>
      ) : null}

      {!loading && jobs.length === 0 ? (
        <Empty>还没有定时任务。点「+ 新建」加一个，或用 cron / every / at 三种计划。</Empty>
      ) : null}

      {jobs.map((job) => (
        <div key={job.id} className="border-b border-line/60 px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{job.name}</span>
            <Badge tone={typeTone(job.type)}>{job.type}</Badge>
            <Badge tone="dim">{MODE_LABEL[job.mode] ?? job.mode}</Badge>
            <button
              type="button"
              title={job.enabled ? "已启用（点击停用）" : "已停用（点击启用）"}
              disabled={busyId === job.id}
              onClick={() => void toggle(job)}
              className={cn(
                "flex h-4 w-8 shrink-0 items-center rounded-sm border px-0.5 transition-colors duration-100 disabled:opacity-40",
                job.enabled ? "border-success/50 bg-success/20" : "border-line-strong bg-inset",
              )}
            >
              <span
                className={cn(
                  "h-3 w-3 rounded-sm transition-transform duration-100",
                  job.enabled ? "translate-x-3.5 bg-success" : "translate-x-0 bg-fg-mute",
                )}
              />
            </button>
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-fg-mute">
            <span className="truncate" title={job.schedule}>
              {job.schedule}
            </span>
            <span>·</span>
            <span>{job.nextRunAt ? "下次 " + formatWhen(job.nextRunAt) : "不再触发"}</span>
            <span>·</span>
            <span>已跑 {job.runCount ?? 0} 次</span>
            <span className="flex-1" />
            <button
              type="button"
              disabled={busyId === job.id}
              onClick={() => void runNow(job)}
              className="text-fg-dim hover:text-fg disabled:opacity-40"
            >
              立即执行
            </button>
            <button
              type="button"
              disabled={busyId === job.id}
              onClick={() => void remove(job)}
              className="text-danger/80 hover:text-danger disabled:opacity-40"
            >
              删除
            </button>
          </div>
          {job.prompt ? (
            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11px] leading-[1.5] text-fg-dim">
              {job.prompt}
            </p>
          ) : null}
        </div>
      ))}

      {/* 运行历史 */}
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg-mute">运行历史 {history.length}</span>
      </div>
      {history.length === 0 ? (
        <Empty>暂无运行记录。</Empty>
      ) : (
        history.map((run, i) => (
          <div key={run.id ?? i} className="border-b border-line/60 px-2 py-1">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  run.ok === false ? "bg-danger" : run.ok ? "bg-success" : "bg-fg-mute",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-fg-dim">{run.jobName || run.jobId || "任务"}</span>
              {run.trigger ? <span className="font-mono text-[10px] text-fg-mute">{run.trigger}</span> : null}
              <span className="font-mono text-[10px] text-fg-mute">{formatWhen(run.startedAt)}</span>
            </div>
            {run.error || run.result ? (
              <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words pl-3.5 font-mono text-[10px] text-fg-mute">
                {run.error ?? run.result}
              </p>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
