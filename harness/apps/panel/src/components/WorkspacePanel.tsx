/** 右侧工作区：文件 / 预览 / 记忆 / 任务 / 日志 五标签 */
import { useEffect, useState } from "react";
import { Badge, Button, cn } from "./ui/Primitives.tsx";
import { FilesTab } from "./FilesTab.tsx";
import { PreviewPane } from "./PreviewPane.tsx";
import { MemoryPanel } from "./MemoryPanel.tsx";
import { CronPanel } from "./CronPanel.tsx";
import { LogsPanel } from "./LogsPanel.tsx";
import type { FileEntry } from "../lib/tree.ts";
import type { Project } from "../types.ts";

type Tab = "files" | "preview" | "memory" | "tasks" | "logs";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "files", label: "文件" },
  { key: "preview", label: "预览" },
  { key: "memory", label: "记忆" },
  { key: "tasks", label: "任务" },
  { key: "logs", label: "日志" },
];

/** 支持 #files / #memory / #tasks 深链（也方便无头截图直达某个 tab） */
function initialTab(project: Project | null): Tab {
  const hash = window.location.hash.replace(/^#/, "");
  const hit = TABS.find((t) => t.key === hash);
  return hit ? hit.key : project ? "preview" : "files";
}

export interface WorkspacePanelProps {
  project: Project | null;
  files: FileEntry[];
  threadId: string | null;
  onBuild: (projectId: string) => Promise<unknown>;
  onClose: () => void;
}

export function WorkspacePanel({ project, files, threadId, onBuild, onClose }: WorkspacePanelProps) {
  const [tab, setTab] = useState<Tab>(() => initialTab(project));

  // 选中项目时自动切到预览（深链指定的 tab 除外）
  useEffect(() => {
    if (!project) return;
    const hash = window.location.hash.replace(/^#/, "");
    if (TABS.some((t) => t.key === hash)) return;
    setTab("preview");
  }, [project?.id]);

  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-line bg-panel">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2">
        <div className="flex items-center gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                window.history.replaceState(null, "", "#" + t.key);
              }}
              className={cn(
                "rounded-sm px-1.5 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors duration-100",
                tab === t.key ? "bg-accent/15 text-fg" : "text-fg-mute hover:bg-white/5 hover:text-fg-dim",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {project ? <Badge tone="info">{project.name}</Badge> : null}
        <Button size="xs" variant="subtle" onClick={onClose} title="收起工作区">
          ✕
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "files" ? (
          <FilesTab projectId={project?.id ?? null} files={files} root={project?.path} />
        ) : null}
        {tab === "preview" ? <PreviewPane project={project} onBuild={onBuild} /> : null}
        {tab === "memory" ? <MemoryPanel /> : null}
        {tab === "tasks" ? <CronPanel /> : null}
        {tab === "logs" ? <LogsPanel threadId={threadId} enabled /> : null}
      </div>
    </aside>
  );
}
