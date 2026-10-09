/** 左侧栏：Dove(Home) + 会话列表 + 项目列表 + 新建项目 */
import type { ReactNode } from "react";
import { Badge, Button, Dot, cn } from "./ui/Primitives.tsx";
import { ActivityBlock } from "./ActivityBlock.tsx";
import { basename } from "../lib/format.ts";
import type { Health, Project, Thread } from "../types.ts";

export interface SidebarProps {
  health: Health | null;
  healthError: string | null;
  threads: Thread[];
  projects: Project[];
  activeThreadId: string | null;
  activeProjectId: string | null;
  busy: boolean;
  onSelectHome: () => void;
  onSelectThread: (id: string) => void;
  onSelectProject: (project: Project) => void;
  onNewProject: () => void;
  onRefresh: () => void;
}

function SectionTitle({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-3 pt-2">
      <span className="font-mono text-[10px] uppercase tracking-wide text-fg-mute">{children}</span>
      {right}
    </div>
  );
}

interface RowProps {
  active: boolean;
  title: string;
  subtitle?: string;
  tag?: ReactNode;
  leading?: ReactNode;
  onClick: () => void;
}

function Row({ active, title, subtitle, tag, leading, onClick }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={subtitle ? title + " · " + subtitle : title}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-3 py-1 text-left transition-colors duration-100",
        active ? "bg-accent/15 text-fg" : "text-fg-dim hover:bg-white/5 hover:text-fg",
      )}
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px]">{title}</span>
        {subtitle ? <span className="block truncate font-mono text-[10px] text-fg-mute">{subtitle}</span> : null}
      </span>
      {tag}
    </button>
  );
}

export function Sidebar(props: SidebarProps) {
  const { health, healthError, threads, projects, activeThreadId, activeProjectId, busy } = props;
  const home = threads.find((t) => t.kind === "home");
  const others = threads.filter((t) => t.kind !== "home");
  const online = Boolean(health?.ok);

  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="font-mono text-[12px] font-semibold tracking-widest text-fg">DOVE</span>
        <Badge tone={online ? "success" : "danger"} className="ml-auto">
          <Dot className={online ? "bg-success" : "bg-danger"} />
          {online ? "LIVE" : "OFF"}
        </Badge>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <SectionTitle>会话</SectionTitle>
        <div className="space-y-px px-1">
          <Row
            active={Boolean(home && home.id === activeThreadId) || (!activeThreadId && !activeProjectId)}
            title="Dove · Home"
            subtitle={home ? home.id : "常驻调度线程"}
            leading={<span className="text-accent">◆</span>}
            tag={<Badge tone="accent">HOME</Badge>}
            onClick={props.onSelectHome}
          />
          {others.map((t) => (
            <Row
              key={t.id}
              active={t.id === activeThreadId}
              title={t.title || "未命名会话"}
              subtitle={t.projectId ?? t.id}
              leading={<span className="text-fg-mute">·</span>}
              onClick={() => props.onSelectThread(t.id)}
            />
          ))}
          {!home && others.length === 0 ? (
            <p className="px-3 py-2 text-[11px] leading-relaxed text-fg-mute">
              还没有会话。点上方 Home 或下面的项目开始。
            </p>
          ) : null}
        </div>

        <SectionTitle
          right={
            <Button size="xs" variant="subtle" onClick={props.onNewProject}>
              + 新建
            </Button>
          }
        >
          项目
        </SectionTitle>
        <div className="space-y-px px-1">
          {projects.map((p) => (
            <Row
              key={p.id}
              active={p.id === activeProjectId}
              title={p.name}
              subtitle={basename(p.path) || p.path}
              leading={<span className="text-fg-mute">▣</span>}
              tag={p.port ? <span className="font-mono text-[10px] text-fg-mute">{p.port}</span> : undefined}
              onClick={() => props.onSelectProject(p)}
            />
          ))}
          {projects.length === 0 ? (
            <p className="px-3 py-2 text-[11px] leading-relaxed text-fg-mute">
              还没有项目。新建一个后即可预览与构建。
            </p>
          ) : null}
        </div>
      </div>

      <ActivityBlock />

      <div className="shrink-0 border-t border-line px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[10px] text-fg-mute" title={healthError ?? health?.model ?? ""}>
            {busy ? "生成中…" : (health?.model ?? healthError ?? "内核未连接")}
          </span>
          <Button size="xs" variant="subtle" onClick={props.onRefresh} title="刷新会话与项目">
            刷新
          </Button>
        </div>
      </div>
    </aside>
  );
}
