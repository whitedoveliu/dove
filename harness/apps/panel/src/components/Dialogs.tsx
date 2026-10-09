/** 两个弹窗：工具审批（Allow/Deny）与 agent 提问（建议选项 + 自由输入） */
import { useEffect, useState } from "react";
import { Badge, Button, Modal } from "./ui/Primitives.tsx";
import { extractCommand, riskTone, stringifyValue, summarizeInput } from "../lib/format.ts";
import type { UIToolPart } from "../types.ts";

export interface ApprovalDialogProps {
  part: UIToolPart | null;
  onDecide: (approved: boolean, reason?: string) => void;
}

export function ApprovalDialog({ part, onDecide }: ApprovalDialogProps) {
  const [reason, setReason] = useState("");
  const id = part?.toolCallId ?? "";

  useEffect(() => {
    setReason("");
  }, [id]);

  if (!part) return null;
  const approval = part.approval;
  const risk = riskTone(approval?.riskLevel);
  const command = approval?.command ?? extractCommand(part.input) ?? summarizeInput(part.input);

  return (
    <Modal
      open
      title="工具调用需要审批"
      tone={risk.border}
      width="max-w-[640px]"
      footer={
        <>
          <Button variant="danger" onClick={() => onDecide(false, reason.trim() || undefined)}>
            Deny 拒绝
          </Button>
          <Button variant="primary" onClick={() => onDecide(true)}>Allow 允许</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] text-fg">{part.name}</span>
          <Badge tone="dim">{part.toolCallId}</Badge>
          <Badge className={risk.text}>风险 {risk.label}</Badge>
        </div>
        <p className="text-[12px] leading-relaxed text-fg-dim">
          {approval?.message ?? "该工具调用会修改本地环境，请确认后继续。"}
        </p>
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-fg-mute">命令 / 目标</div>
          <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-2 font-mono text-[12px] leading-[1.5] text-fg">
            {command || "（无命令）"}
          </pre>
        </div>
        {part.input != null ? (
          <details>
            <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wide text-fg-mute">
              完整参数
            </summary>
            <pre className="mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-2 font-mono text-[11px] text-fg-dim">
              {stringifyValue(part.input, 8000)}
            </pre>
          </details>
        ) : null}
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-fg-mute">拒绝理由（可选）</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：不要动这个文件"
            className="h-7 w-full rounded-sm border border-line-strong bg-inset px-2 text-[12px] text-fg outline-none focus:border-accent"
          />
        </label>
      </div>
    </Modal>
  );
}

export interface AskUserDialogProps {
  question: string | null;
  suggestions: string[];
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}

export function AskUserDialog({ question, suggestions, onAnswer, onDismiss }: AskUserDialogProps) {
  const [text, setText] = useState("");

  useEffect(() => {
    setText("");
  }, [question]);

  if (!question) return null;

  return (
    <Modal
      open
      title="Agent 提问"
      width="max-w-[560px]"
      onClose={onDismiss}
      footer={
        <>
          <Button onClick={onDismiss}>稍后回答</Button>
          <Button variant="primary" onClick={() => onAnswer(text.trim() || "继续")} disabled={!text.trim()}>
            提交回答
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.6] text-fg">{question}</p>
        {suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <Button key={s} size="md" onClick={() => onAnswer(s)} title="直接采用该建议">
                {s}
              </Button>
            ))}
          </div>
        ) : null}
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-fg-mute">自由输入</span>
          <textarea
            rows={3}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) onAnswer(text.trim());
            }}
            placeholder="输入你的回答…（⌘/Ctrl + Enter 提交）"
            className="w-full resize-none rounded-sm border border-line-strong bg-inset p-2 text-[13px] text-fg outline-none focus:border-accent"
          />
        </label>
      </div>
    </Modal>
  );
}
