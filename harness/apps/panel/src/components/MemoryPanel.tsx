/**
 * 记忆 tab：持久化文件（可查看 / 编辑 / 保存）+ 向量记忆列表 + 睡眠合并。
 * 接口：GET /api/memory、POST /api/memory/sleep、GET|POST /api/config/file
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Empty, Notice, Spinner, cn } from "./ui/Primitives.tsx";
import { api } from "../lib/api.ts";
import { formatWhen } from "../lib/format.ts";
import type { MemoryItem, SleepStats } from "../types.ts";

/** 内核配置里白名单的持久化文件 */
const CONFIG_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"];

function kindTone(kind?: string): "accent" | "info" | "think" | "dim" {
  if (kind === "preference") return "accent";
  if (kind === "fact") return "info";
  if (kind === "project" || kind === "task") return "think";
  return "dim";
}

/** 睡眠统计 → 一行中文摘要 */
function sleepSummary(s: SleepStats): string {
  if (s.skipped) return "睡眠合并已跳过（记忆服务未启用或无需整理）。";
  const parts = [
    "扫描 " + (s.examined ?? 0),
    "合并 " + (s.merged ?? 0),
    "归档 " +
      ((s.archivedExact ?? 0) + (s.archivedExpired ?? 0) + (s.archivedOrphan ?? 0) + (s.archivedSimilarity ?? 0)),
    "LLM 判定 " + (s.llmChecked ?? 0) + "/" + (s.llmMerged ?? 0),
    s.durationMs != null ? "用时 " + (s.durationMs / 1000).toFixed(1) + "s" : "",
  ].filter(Boolean);
  return parts.join(" · ") + (s.status === "error" ? "（执行出错）" : "");
}

export function MemoryPanel() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const [file, setFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileHint, setFileHint] = useState<string | null>(null);

  const [sleeping, setSleeping] = useState(false);
  const [sleep, setSleep] = useState<SleepStats | null>(null);

  const loadMemories = useCallback(async () => {
    setLoading(true);
    try {
      setMemories(await api.memory());
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  const openFile = useCallback(async (name: string) => {
    setFile(name);
    setFileHint(null);
    setSaved("");
    try {
      const res = await api.configFile(name);
      setContent(res?.content ?? "");
    } catch (err) {
      setContent("");
      setFileHint("读取失败：" + (err as Error).message);
    }
  }, []);

  const saveFile = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setFileHint(null);
    try {
      await api.saveConfigFile(file, content);
      setSaved(file + " 已保存");
      window.setTimeout(() => setSaved(""), 2500);
    } catch (err) {
      setFileHint("保存失败：" + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [file, content]);

  const runSleep = useCallback(async () => {
    setSleeping(true);
    try {
      const res = await api.memorySleep();
      setSleep(res ?? { skipped: true });
      await loadMemories();
    } catch (err) {
      setSleep({ status: "error", note: (err as Error).message });
    } finally {
      setSleeping(false);
    }
  }, [loadMemories]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memories;
    return memories.filter((m) =>
      [m.content, m.kind, m.scope].some((v) => String(v ?? "").toLowerCase().includes(q)),
    );
  }, [memories, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---- 上半：持久化文件 ---- */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-2 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wide text-fg-mute">持久化文件</span>
          <span className="flex-1" />
          <Button size="xs" variant="subtle" onClick={() => void runSleep()} disabled={sleeping} title="POST /api/memory/sleep">
            {sleeping ? "合并中…" : "运行睡眠合并"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          {CONFIG_FILES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => void openFile(name)}
              className={cn(
                "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors duration-100",
                file === name
                  ? "border-accent/50 bg-accent/15 text-fg"
                  : "border-line-strong text-fg-dim hover:bg-white/5 hover:text-fg",
              )}
            >
              {name}
            </button>
          ))}
        </div>

        {sleep ? (
          <Notice tone={sleep.status === "error" ? "warn" : "dim"}>{sleepSummary(sleep)}</Notice>
        ) : null}

        {file ? (
          <div className="flex flex-col gap-1.5">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              rows={8}
              placeholder={"（" + file + " 还是空的，写点什么）"}
              className="max-h-[220px] min-h-[96px] w-full resize-y rounded-sm border border-line-strong bg-inset p-2 font-mono text-[11px] leading-[1.5] text-fg outline-none focus:border-accent"
            />
            <div className="flex items-center gap-2">
              <Button size="xs" variant="primary" onClick={() => void saveFile()} disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </Button>
              <Button size="xs" variant="subtle" onClick={() => void openFile(file)} title="丢弃改动，重新读取">
                重新载入
              </Button>
              <span className="font-mono text-[10px] text-success">{saved}</span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  setContent("");
                  setFileHint(null);
                }}
                className="font-mono text-[10px] text-fg-mute hover:text-fg"
              >
                收起
              </button>
            </div>
            {fileHint ? <p className="font-mono text-[10px] text-warn">{fileHint}</p> : null}
          </div>
        ) : (
          <p className="text-[11px] text-fg-mute">点上面的文件名查看与编辑（保存走 POST /api/config/file）。</p>
        )}
      </div>

      {/* ---- 下半：向量记忆 ---- */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg-mute">
          向量记忆 {filtered.length}/{memories.length}
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索内容 / kind / scope"
          className="h-6 min-w-0 flex-1 rounded-sm border border-line-strong bg-inset px-2 text-[11px] text-fg outline-none focus:border-accent"
        />
        <Button size="xs" variant="subtle" onClick={() => void loadMemories()} title="重新拉取">
          刷新
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-fg-mute">
            <Spinner /> 读取记忆…
          </div>
        ) : null}
        {!loading && memories.length === 0 ? <Empty>还没有向量记忆。对话之后会自动抽取。</Empty> : null}
        {!loading && memories.length > 0 && filtered.length === 0 ? <Empty>没有匹配「{query}」的记忆。</Empty> : null}
        {filtered.map((m, i) => (
          <div key={m.id ?? i} className="border-b border-line/60 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <Badge tone={kindTone(m.kind)}>{m.kind || "memory"}</Badge>
              <span className="truncate font-mono text-[10px] text-fg-mute">{m.scope || "—"}</span>
              <span className="flex-1" />
              {typeof m.score === "number" ? (
                <span className="font-mono text-[10px] text-info">score {m.score.toFixed(3)}</span>
              ) : null}
              <span className="font-mono text-[10px] text-fg-mute">{formatWhen(m.createdAt)}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-[1.5] text-fg-dim">
              {m.content ?? "(空)"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
