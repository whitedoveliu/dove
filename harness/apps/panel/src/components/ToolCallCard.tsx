/** 工具调用卡片：名称 + 参数摘要 + 状态 + 可折叠结果 */
import { useState } from "react";
import { Dot, cn } from "./ui/Primitives.tsx";
import { formatDuration, statusMeta, stringifyValue, summarizeInput } from "../lib/format.ts";
import type { UIToolPart } from "../types.ts";

function Block({ label, text, tone }: { label: string; text: string; tone?: string }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-fg-mute">{label}</div>
      <pre
        className={cn(
          "max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-2 font-mono text-[11px] leading-[1.5]",
          tone ?? "text-fg-dim",
        )}
      >
        {text || "（空）"}
      </pre>
    </div>
  );
}

export function ToolCallCard({ part }: { part: UIToolPart }) {
  const [open, setOpen] = useState(false);
  const tone = statusMeta(part.state, part.errorText);
  const summary = summarizeInput(part.input);
  const duration = part.startedAt && part.finishedAt ? formatDuration(part.finishedAt - part.startedAt) : "";
  const hasBody = part.input != null || part.output != null || Boolean(part.errorText) || Boolean(part.spillPath);

  return (
    <div className={cn("overflow-hidden rounded-md border bg-panel", tone.border)}>
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={cn("flex w-full items-center gap-2 px-2 py-1.5 text-left", hasBody && "hover:bg-white/5")}
      >
        <Dot className={tone.dot} />
        <span className="shrink-0 font-mono text-[12px] text-fg">{part.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-mute">{summary}</span>
        <span className={cn("shrink-0 font-mono text-[10px] uppercase tracking-wide", tone.text)}>{tone.label}</span>
        {duration ? <span className="shrink-0 font-mono text-[10px] text-fg-mute">{duration}</span> : null}
        {hasBody ? <span className="shrink-0 text-[10px] text-fg-mute">{open ? "▾" : "▸"}</span> : null}
      </button>

      {part.state === "approval-requested" && part.approval ? (
        <div className="border-t border-warn/30 bg-warn/5 px-2 py-1 font-mono text-[11px] text-warn">
          等待审批：{part.approval.message}（风险 {part.approval.riskLevel}）
        </div>
      ) : null}

      {open && hasBody ? (
        <div className="space-y-2 border-t border-line px-2 py-2">
          {part.input != null ? <Block label="参数" text={stringifyValue(part.input, 8000)} /> : null}
          {part.errorText ? <Block label="错误" text={part.errorText} tone="text-danger" /> : null}
          {part.output != null ? <Block label="结果" text={stringifyValue(part.output, 20000)} /> : null}
          {part.spillPath ? (
            <div className="font-mono text-[11px] text-fg-mute">完整输出落盘：{part.spillPath}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
