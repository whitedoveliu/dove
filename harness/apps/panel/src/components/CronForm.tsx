/** 新建定时任务表单（从 CronPanel 拆出，保证单文件 ≤400 行） */
import { useState } from "react";
import { Button } from "./ui/Primitives.tsx";
import { api } from "../lib/api.ts";

export const TYPE_HINT: Record<string, string> = {
  at: "一次性：ISO 时间（2025-06-01T09:00）或相对时间（30m）",
  every: "间隔：30s / 15m / 2h / 1d",
  cron: "5 段表达式：分 时 日 月 周，例如 0 9 * * 1-5",
};

interface FormState {
  name: string;
  type: "at" | "every" | "cron";
  schedule: string;
  mode: "main" | "isolated";
  prompt: string;
}

const EMPTY_FORM: FormState = { name: "", type: "every", schedule: "30m", mode: "main", prompt: "" };

export function JobForm({ onCreated }: { onCreated: (msg: string) => void }) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    if (!form.schedule.trim()) {
      setHint("请填写 schedule");
      return;
    }
    setBusy(true);
    setHint(null);
    try {
      await api.createCron({
        name: form.name.trim() || "未命名任务",
        type: form.type,
        schedule: form.schedule.trim(),
        mode: form.mode,
        prompt: form.prompt,
        enabled: true,
      });
      setForm(EMPTY_FORM);
      onCreated("任务已创建");
    } catch (err) {
      // 内核未接入定时服务时会返回 400「定时服务未接入」——这里只要提示，不抛
      setHint("创建失败：" + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input =
    "h-6 w-full rounded-sm border border-line-strong bg-inset px-1.5 font-mono text-[11px] text-fg outline-none focus:border-accent";

  return (
    <div className="space-y-1.5 border-b border-line bg-inset/60 px-2 py-2">
      <div className="grid grid-cols-2 gap-1.5">
        <label className="col-span-1">
          <span className="mb-0.5 block font-mono text-[10px] text-fg-mute">名称</span>
          <input className={input} value={form.name} placeholder="每日站会提醒" onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="col-span-1">
          <span className="mb-0.5 block font-mono text-[10px] text-fg-mute">类型</span>
          <select
            className={input}
            value={form.type}
            onChange={(e) => set("type", e.target.value as FormState["type"])}
          >
            <option value="at">at · 一次性</option>
            <option value="every">every · 间隔</option>
            <option value="cron">cron · 表达式</option>
          </select>
        </label>
        <label className="col-span-1">
          <span className="mb-0.5 block font-mono text-[10px] text-fg-mute">计划</span>
          <input
            className={input}
            value={form.schedule}
            placeholder={TYPE_HINT[form.type] ?? ""}
            onChange={(e) => set("schedule", e.target.value)}
          />
        </label>
        <label className="col-span-1">
          <span className="mb-0.5 block font-mono text-[10px] text-fg-mute">模式</span>
          <select
            className={input}
            value={form.mode}
            onChange={(e) => set("mode", e.target.value as FormState["mode"])}
          >
            <option value="main">main · 主线程</option>
            <option value="isolated">isolated · 独立会话</option>
          </select>
        </label>
      </div>
      <p className="font-mono text-[10px] text-fg-mute">{TYPE_HINT[form.type]}</p>
      <label className="block">
        <span className="mb-0.5 block font-mono text-[10px] text-fg-mute">提示词</span>
        <textarea
          rows={2}
          value={form.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          placeholder="到点后让 Dove 做什么…"
          className="w-full resize-y rounded-sm border border-line-strong bg-inset p-1.5 text-[11px] leading-[1.5] text-fg outline-none focus:border-accent"
        />
      </label>
      <div className="flex items-center gap-2">
        <Button size="xs" variant="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? "创建中…" : "创建任务"}
        </Button>
        <Button size="xs" variant="subtle" onClick={() => setForm(EMPTY_FORM)}>
          重置
        </Button>
        {hint ? <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-warn">{hint}</span> : null}
      </div>
    </div>
  );
}
