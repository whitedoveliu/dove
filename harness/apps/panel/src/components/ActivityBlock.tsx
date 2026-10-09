/**
 * 侧栏底部「感知」区块（M7）：快照数 / 占用 / 最后采集 + 采集一帧 + 日报。
 * 接口：GET /api/activity/status、POST /api/activity/capture、GET /api/activity/report?kind=
 * available:false = 服务未接入；权限没给用「操作指引」呈现，两种都不是报错。
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Modal, Notice, Spinner } from "./ui/Primitives.tsx";
import { Markdown } from "../lib/markdown.tsx";
import { api } from "../lib/api.ts";
import { formatBytes, formatWhen } from "../lib/format.ts";
import type { ActivityReport, ActivityStatus } from "../types.ts";

/** 与内核 capture.ts 的 SCREEN_PERMISSION_HINT 保持一致 */
const PERMISSION_GUIDE =
  "未获得「屏幕录制」权限：打开 系统设置 → 隐私与安全性 → 屏幕录制，勾选 Dove（或运行它的终端 / IDE）后重启该程序。";

/** 后端可能用不同字段名体现屏幕录制权限，全部兼容 */
function permissionMissing(s: ActivityStatus | null): boolean {
  if (!s) return false;
  if (s.screenPermission === false || s.screenRecording === false || s.permission === false) return true;
  return typeof s.note === "string" && /权限|未授权|permission|denied/i.test(s.note);
}

function SnapshotLine({ status }: { status: ActivityStatus | null }) {
  return (
    <div className="space-y-0.5 font-mono text-[10px] text-fg-mute">
      <div className="flex items-center gap-2">
        <span>快照</span>
        <span className="text-fg-dim">{status?.snapshots ?? 0}</span>
        <span>·</span>
        <span>占用</span>
        <span className="text-fg-dim">{formatBytes(status?.bytes)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span>最后采集</span>
        <span className="text-fg-dim">{formatWhen(status?.lastCaptureAt)}</span>
      </div>
    </div>
  );
}

export function ActivityBlock() {
  const [status, setStatus] = useState<ActivityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<{ text: string; tone: "dim" | "warn" | "info" } | null>(null);
  const [report, setReport] = useState<ActivityReport | null>(null);
  const [reporting, setReporting] = useState<"daily" | "weekly" | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.activityStatus());
    } catch {
      // 内核没起 / 接口不存在：当成未接入，不报错
      setStatus({ available: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const capture = async () => {
    setBusy(true);
    setHint(null);
    try {
      const r = await api.activityCapture();
      const error = r?.ok === false ? (r.error ?? "") : "";
      // 权限指引已经常驻在区块里时，不重复贴一遍同样的话
      const repeated = error && permissionMissing(status) && /屏幕录制/.test(error);
      if (r?.skipped) setHint({ text: "未采集：" + r.skipped, tone: "dim" });
      else if (error && !repeated) setHint({ text: error, tone: "warn" });
      else if (!error) setHint({ text: "已采集一帧" + (r?.bytes ? "（" + formatBytes(r.bytes) + "）" : ""), tone: "info" });
      await load();
    } catch (err) {
      setHint({ text: "采集失败：" + (err as Error).message, tone: "warn" });
    } finally {
      setBusy(false);
    }
  };

  const makeReport = async (kind: "daily" | "weekly") => {
    setReporting(kind);
    try {
      setReport(await api.activityReport(kind));
    } catch (err) {
      setReport({ report: "", note: "生成失败：" + (err as Error).message });
    } finally {
      setReporting(null);
    }
  };

  const available = status?.available !== false;
  const needPermission = permissionMissing(status);

  return (
    <div className="shrink-0 border-t border-line px-3 py-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg-mute">感知</span>
        {available ? <span className="font-mono text-[10px] text-success">在采</span> : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 font-mono text-[10px] text-fg-mute">
          <Spinner /> 读取状态…
        </div>
      ) : !available ? (
        <div className="space-y-1">
          <p className="text-[11px] text-fg-dim">屏幕感知未启用</p>
          <p className="text-[11px] leading-relaxed text-fg-mute">
            需要 M7 感知服务接入后才会采集屏幕快照；接入后若系统未授权，这里会给出开启屏幕录制的指引。
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <SnapshotLine status={status} />
          {needPermission ? <Notice tone="warn">{PERMISSION_GUIDE}</Notice> : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => void capture()} disabled={busy}>
              {busy ? "采集中…" : "采集一帧"}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void makeReport("daily")} disabled={reporting !== null}>
              {reporting === "daily" ? "生成中…" : "今日日报"}
            </Button>
          </div>
          {hint ? <Notice tone={hint.tone}>{hint.text}</Notice> : null}
        </div>
      )}

      <Modal
        open={report !== null}
        title={(report?.kind === "weekly" ? "每周" : "每日") + "感知报告" + (report?.date ? " · " + report.date : "")}
        width="max-w-[720px]"
        onClose={() => setReport(null)}
        footer={
          <>
            <Button
              variant="subtle"
              disabled={reporting !== null}
              onClick={() => void makeReport(report?.kind === "weekly" ? "daily" : "weekly")}
            >
              {report?.kind === "weekly" ? "换成日报" : "换成周报"}
            </Button>
            <Button onClick={() => setReport(null)}>关闭</Button>
          </>
        }
      >
        {report?.report ? (
          <Markdown text={report.report} className="text-[12px] leading-[1.6] text-fg-dim" />
        ) : (
          <Notice>{report?.note || "没有可展示的报告内容。"}</Notice>
        )}
      </Modal>
    </div>
  );
}
