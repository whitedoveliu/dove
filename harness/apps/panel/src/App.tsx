/** 面板根组件：三栏布局 + 状态编排（左侧栏 / 对话 / 工作区） */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Sidebar } from "./components/Sidebar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { WorkspacePanel } from "./components/WorkspacePanel.tsx";
import { ApprovalDialog, AskUserDialog } from "./components/Dialogs.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { useHarness } from "./hooks/useHarness.ts";
import { useChat } from "./hooks/useChat.ts";
import { collectFiles } from "./lib/tree.ts";
import type { Project } from "./types.ts";

const EXAMPLES = ["做一个作品集首页", "把这个项目跑起来", "现在的记忆里有什么？"];

function EmptyHint() {
  return (
    <div className="mx-auto max-w-[560px] py-10 text-center">
      <div className="font-mono text-[10px] uppercase tracking-widest text-fg-mute">DOVE · HARNESS</div>
      <h1 className="mt-2 text-[16px] font-semibold text-fg">常驻、有记忆的双层循环 Agent</h1>
      <p className="mt-2 text-[12px] leading-relaxed text-fg-dim">
        从左侧选择 Home 或某个项目开始。工具调用会变成对话里的卡片，需要审批时会弹窗确认，
        右侧可以看文件、预览和事件日志。
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((s) => (
          <span key={s} className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] text-fg-mute">
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const harness = useHarness();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [rightOpen, setRightOpen] = useState(true);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const chat = useChat(activeThreadId, activeProjectId);
  const activeProject = harness.projects.find((p) => p.id === activeProjectId) ?? null;
  const activeThread = harness.threads.find((t) => t.id === activeThreadId) ?? null;

  const files = useMemo(
    () => collectFiles(chat.state.messages, activeProject?.path),
    [chat.state.messages, activeProject?.path],
  );

  // 首屏：自动落到 Home 会话（不新建）
  useEffect(() => {
    if (activeThreadId || harness.threads.length === 0) return;
    const home = harness.threads.find((t) => t.kind === "home");
    if (home) setActiveThreadId(home.id);
  }, [harness.threads, activeThreadId]);

  const fail = useCallback((err: unknown) => setNotice((err as Error).message), []);

  const selectHome = useCallback(async () => {
    setNotice(null);
    setActiveProjectId(null);
    const home = harness.threads.find((t) => t.kind === "home");
    if (home) {
      setActiveThreadId(home.id);
      return;
    }
    try {
      const created = await harness.createThread("home", "Dove");
      if (created?.id) setActiveThreadId(created.id);
      else setNotice("内核未返回会话 id");
    } catch (err) {
      fail(err);
    }
  }, [harness.threads, harness.createThread, fail]);

  const selectProject = useCallback(
    async (project: Project) => {
      setNotice(null);
      setActiveProjectId(project.id);
      const existing = harness.threads.find((t) => t.projectId === project.id);
      if (existing) {
        setActiveThreadId(existing.id);
        return;
      }
      try {
        const created = await harness.createThread("project", project.name, project.id);
        if (created?.id) setActiveThreadId(created.id);
      } catch (err) {
        fail(err);
      }
    },
    [harness.threads, harness.createThread, fail],
  );

  const createProject = useCallback(
    async (name: string, path: string) => {
      const created = await harness.createProject(name, path);
      if (created?.id) await selectProject(created);
    },
    [harness.createProject, selectProject],
  );

  const refreshAll = useCallback(() => {
    void harness.refreshHealth();
    void harness.refreshThreads();
    void harness.refreshProjects();
    void harness.refreshMemory();
  }, [harness.refreshHealth, harness.refreshThreads, harness.refreshProjects, harness.refreshMemory]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-shell text-fg">
      <Sidebar
        health={harness.health}
        healthError={harness.healthError}
        threads={harness.threads}
        projects={harness.projects}
        activeThreadId={activeThreadId}
        activeProjectId={activeProjectId}
        busy={chat.state.streaming}
        onSelectHome={() => void selectHome()}
        onSelectThread={(id) => {
          setActiveThreadId(id);
          const t = harness.threads.find((x) => x.id === id);
          if (t?.projectId) setActiveProjectId(t.projectId);
        }}
        onSelectProject={(p) => void selectProject(p)}
        onNewProject={() => setNewProjectOpen(true)}
        onRefresh={refreshAll}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {notice ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1 font-mono text-[11px] text-warn">
            <span className="min-w-0 flex-1 truncate">{notice}</span>
            <button type="button" className="shrink-0 hover:text-fg" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        ) : null}
        <ChatView
          thread={activeThread}
          project={activeProject}
          state={chat.state}
          rightOpen={rightOpen}
          onToggleRight={() => setRightOpen((v) => !v)}
          onSend={(text) => void chat.send(text)}
          onStop={chat.stop}
          emptyHint={<EmptyHint />}
        />
      </div>

      {rightOpen ? (
        <WorkspacePanel
          project={activeProject}
          files={files}
          threadId={activeThreadId}
          onBuild={harness.build}
          onClose={() => setRightOpen(false)}
        />
      ) : null}

      <ApprovalDialog
        part={chat.approval}
        onDecide={(approved, reason) => {
          if (chat.approval) void chat.decide(chat.approval, approved, reason);
        }}
      />
      <AskUserDialog
        question={chat.state.ask?.question ?? null}
        suggestions={chat.state.ask?.suggestions ?? []}
        onAnswer={(answer) => void chat.reply(answer)}
        onDismiss={chat.dismissAsk}
      />
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreate={createProject}
      />
    </div>
  );
}
