/**
 * 顶部状态条的情绪 / 疲劳指示器（M6）。
 * 两个服务任何一个不可用就整体不渲染 —— 未接入不是错误，不占位、不报错。
 */
import { useEffect, useState } from "react";
import { Button, Modal, cn } from "./ui/Primitives.tsx";
import { useStatus } from "../hooks/useStatus.ts";
import { api } from "../lib/api.ts";
import type { EmotionLayer, EmotionState, FatigueState } from "../types.ts";

const FATIGUE_LABEL: Record<string, string> = {
  awake: "清醒",
  tired: "有点累",
  sleepy: "很困",
  sleeping: "睡着",
};

/** valence(-10~10) → 色块：正绿负红，越远离 0 越实 */
function valenceTone(v: number): { block: string; text: string; label: string } {
  if (v > 0.05) return { block: "bg-success", text: "text-success", label: "偏正" };
  if (v < -0.05) return { block: "bg-danger", text: "text-danger", label: "偏负" };
  return { block: "bg-fg-mute", text: "text-fg-mute", label: "中性" };
}

function valenceOpacity(v: number): number {
  return 0.3 + 0.7 * Math.min(1, Math.abs(v) / 10);
}

function fatigueLevel(f: FatigueState): number {
  const raw = f.level ?? f.fatigue ?? 0;
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
}

function levelTone(level: number): string {
  if (level >= 70) return "bg-danger";
  if (level >= 40) return "bg-warn";
  return "bg-success";
}

/* ---------------- 情绪 ---------------- */

function EmotionDialog({
  state,
  onClose,
  onDone,
}: {
  state: EmotionState;
  onClose: () => void;
  onDone: () => void;
}) {
  const [layer, setLayer] = useState<"base" | "context">("context");
  const current: EmotionLayer | undefined = layer === "base" ? state.base : state.context;
  const [label, setLabel] = useState(current?.label ?? "");
  const [valence, setValence] = useState(current?.valence ?? 6);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  // 切换层时回填该层当前值
  useEffect(() => {
    const next = layer === "base" ? state.base : state.context;
    setLabel(next?.label ?? "");
    setValence(next?.valence ?? 6);
    setHint(null);
  }, [layer, state.base, state.context]);

  const save = async () => {
    setBusy(true);
    setHint(null);
    try {
      const res = await api.setEmotion({ layer, label: label.trim() || undefined, valence });
      if (res?.ok === false) setHint("情绪服务未接入，改动没有生效。");
      else onDone();
    } catch (err) {
      setHint((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="手动调整情绪"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          {(["base", "context"] as const).map((k) => (
            <Button key={k} size="md" variant={layer === k ? "primary" : "ghost"} onClick={() => setLayer(k)}>
              {k === "base" ? "长期基线" : "当前情境"}
            </Button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-fg-mute">
            融合后 {state.fused?.label ?? "—"} · {state.fused?.valence?.toFixed?.(1) ?? "—"}
          </span>
        </div>

        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-fg-mute">情绪名</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例如：平静 / 愉快 / 烦躁"
            className="h-7 w-full rounded-sm border border-line-strong bg-inset px-2 text-[12px] text-fg outline-none focus:border-accent"
          />
        </label>

        <label className="block">
          <span className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wide text-fg-mute">
            <span>valence 效价（-10 ~ 10，中性基线 6）</span>
            <span className={valenceTone(valence).text}>{valence.toFixed(1)}</span>
          </span>
          <input
            type="range"
            min={-10}
            max={10}
            step={0.5}
            value={valence}
            onChange={(e) => setValence(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)]"
          />
        </label>

        {hint ? <p className="text-[11px] text-warn">{hint}</p> : null}
      </div>
    </Modal>
  );
}

/* ---------------- 疲劳 ---------------- */

function FatigueDialog({
  state,
  onClose,
  onDone,
}: {
  state: FatigueState;
  onClose: () => void;
  onDone: () => void;
}) {
  const [minutes, setMinutes] = useState(20);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const level = fatigueLevel(state);

  const run = async (action: "sleep" | "wake" | "rest") => {
    setBusy(true);
    setHint(null);
    try {
      const res = await api.fatigueAction({ action, ...(action === "rest" ? { minutes } : {}) });
      if (res?.ok === false) setHint("疲劳服务未接入，改动没有生效。");
      else onDone();
    } catch (err) {
      setHint((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="疲劳状态"
      onClose={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] text-fg">
            {FATIGUE_LABEL[state.state ?? ""] ?? state.state ?? "状态未知"}
          </span>
          <span className="font-mono text-[11px] text-fg-mute">疲劳 {level.toFixed(0)} / 100</span>
          {state.sleeping ? <span className="font-mono text-[11px] text-think">睡眠中</span> : null}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-sm bg-line-strong">
          <div className={cn("h-full", levelTone(level))} style={{ width: level + "%" }} />
        </div>
        {state.hint ? <p className="text-[11px] leading-relaxed text-fg-dim">{state.hint}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="md" disabled={busy} onClick={() => void run("sleep")}>
            去睡觉
          </Button>
          <Button variant="ghost" size="md" disabled={busy} onClick={() => void run("wake")}>
            唤醒
          </Button>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={1}
              max={480}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value) || 0)}
              className="h-6 w-14 rounded-sm border border-line-strong bg-inset px-1.5 font-mono text-[11px] text-fg outline-none focus:border-accent"
            />
            <Button variant="ghost" size="md" disabled={busy} onClick={() => void run("rest")}>
              休息一会儿
            </Button>
          </span>
        </div>
        {hint ? <p className="text-[11px] text-warn">{hint}</p> : null}
      </div>
    </Modal>
  );
}

/* ---------------- 指示器 ---------------- */

export function StatusPills() {
  const { emotion, fatigue, refresh } = useStatus();
  const [open, setOpen] = useState<null | "emotion" | "fatigue">(null);

  if (!emotion && !fatigue) return null;

  const fused = emotion?.fused;
  const tone = fused ? valenceTone(fused.valence) : null;
  const level = fatigue ? fatigueLevel(fatigue) : 0;

  const done = () => {
    setOpen(null);
    void refresh();
  };

  return (
    <>
      {fused && tone ? (
        <button
          type="button"
          onClick={() => setOpen("emotion")}
          title="点击手动调整情绪（base / context）"
          className="flex items-center gap-1.5 rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-fg-dim hover:bg-white/5 hover:text-fg"
        >
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", tone.block)} style={{ opacity: valenceOpacity(fused.valence) }} />
          <span>情绪</span>
          <span className="text-fg">{fused.label || "—"}</span>
          <span className={tone.text}>{fused.valence.toFixed(1)}</span>
        </button>
      ) : null}

      {fatigue ? (
        <button
          type="button"
          onClick={() => setOpen("fatigue")}
          title="点击查看 / 调整疲劳（睡觉 / 唤醒 / 休息）"
          className="flex items-center gap-1.5 rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-fg-dim hover:bg-white/5 hover:text-fg"
        >
          <span>疲劳</span>
          <span className="text-fg">{level.toFixed(0)}</span>
          <span className="h-1.5 w-10 overflow-hidden rounded-sm bg-line-strong">
            <span className={cn("block h-full", levelTone(level))} style={{ width: level + "%" }} />
          </span>
        </button>
      ) : null}

      {open === "emotion" && emotion ? (
        <EmotionDialog state={emotion} onClose={() => setOpen(null)} onDone={done} />
      ) : null}
      {open === "fatigue" && fatigue ? (
        <FatigueDialog state={fatigue} onClose={() => setOpen(null)} onDone={done} />
      ) : null}
    </>
  );
}
