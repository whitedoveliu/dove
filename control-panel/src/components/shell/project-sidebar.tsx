"use client";

import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FolderOpen,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Hint } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileTree } from "@/components/shell/file-tree";
import { NewProjectDialog, type NewTaskInput } from "@/components/shell/new-project-dialog";
import { CommandPalette } from "@/components/shell/command-palette";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import type { Project, ProjectFileEntry } from "@/lib/api";

export interface ProjectSidebarProps {
  projects: Project[];
  loading: boolean;
  activePort: string | null;
  collapsed: boolean;
  health: "unknown" | "online" | "offline";
  activeFile?: string | null;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelectProject: (port: string) => void;
  onCreateProject: (input: NewTaskInput) => Promise<void> | void;
  /** 点「新会话」：不弹窗，直接进入聊天主界面 */
  onNewSession?: () => void;
  /** 在某个项目下新建会话（预选该项目） */
  onNewSessionInProject?: (project: string) => void;
  onRefreshProjects: () => void;
  onStartServer: (port: string) => void;
  onStopServer: (port: string) => void;
  /** 从任务列表移除（只删记录，不删文件） */
  onDeleteProject: (port: string) => void;
  onSelectFile?: (port: string, entry: ProjectFileEntry) => void;
}

function toMillis(ts?: number | null): number {
  if (!ts) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

/** DSH 的列表风格：只给一个很短的时间后缀 */
function shortTime(ts?: number | null): string {
  const ms = toMillis(ts);
  if (!ms) return "";
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}天`;
  return new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function taskTitle(project: Project): string {
  const named = (project.display_name || "").trim();
  if (named) return named;
  const dirNamed = (project.name_text || "").trim();
  if (dirNamed) return dirNamed;
  const raw = (project.title || "").trim().replace(/\s+/g, " ");
  if (raw) return raw.length > 60 ? raw.slice(0, 60) + "…" : raw;
  return `会话 ${project.port}`;
}

/** 任务分组：有项目的归到项目下，其余平铺 */
function groupTasks(projects: Project[]) {
  const map = new Map<string, Project[]>();
  for (const project of projects) {
    const key = (project.project || "").trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(project);
  }
  const byTime = (a: Project, b: Project) => toMillis(b.updated_at) - toMillis(a.updated_at);
  return [...map.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([key, items]) => ({
      key: key || "__none__",
      label: key || null,
      items: items.sort(byTime),
      latest: items.reduce((acc, p) => Math.max(acc, toMillis(p.updated_at)), 0),
    }));
}

/**
 * ProjectSidebar —— 左侧任务栏。
 * 结构照 DSH：灰色面板 + 顶部整宽「新会话」按钮 + 「工作区」分组 + 会话行（右侧灰时间）。
 */
export function ProjectSidebar({
  projects,
  loading,
  activePort,
  collapsed,
  health,
  activeFile,
  onCollapsedChange,
  onSelectProject,
  onCreateProject,
  onNewSession,
  onNewSessionInProject,
  onRefreshProjects,
  onStartServer,
  onStopServer,
  onDeleteProject,
  onSelectFile,
}: ProjectSidebarProps) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set());
  const [newTaskOpen, setNewTaskOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  const existingNames = React.useMemo(() => projects.map((p) => taskTitle(p)), [projects]);
  const existingProjects = React.useMemo(
    () => [...new Set(projects.map((p) => (p.project || "").trim()).filter(Boolean))],
    [projects]
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (mod && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setNewTaskOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleFileTree = (port: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(port) ? next.delete(port) : next.add(port);
      return next;
    });

  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const handleCreate = async (input: NewTaskInput) => {
    setCreating(true);
    try {
      await onCreateProject(input);
      setNewTaskOpen(false);
    } finally {
      setCreating(false);
    }
  };

  /* ------------------------------- 折叠态 ------------------------------- */
  if (collapsed) {
    return (
      <div className="flex h-full w-full flex-col items-center gap-1 overflow-hidden py-2">
        <IconButton aria-label="展开任务列表" onClick={() => onCollapsedChange(false)}>
          <ChevronsRight />
        </IconButton>
        <IconButton aria-label="新任务" tone="accent" onClick={() => setNewTaskOpen(true)}>
          <Plus />
        </IconButton>
        <IconButton aria-label="搜索任务" onClick={() => setSearchOpen(true)}>
          <Search />
        </IconButton>
        <div className="my-1 h-px w-6 bg-border-default" />
        <div className="no-scrollbar flex flex-1 flex-col items-center gap-1 overflow-y-auto">
          {projects.map((project) => (
            <button
              key={project.port}
              type="button"
              onClick={() => onSelectProject(project.port)}
              title={taskTitle(project)}
              className={cn(
                "relative flex size-7 items-center justify-center rounded-lg text-xs transition-colors duration-fast",
                project.port === activePort
                  ? "bg-[rgb(var(--nb-100))] font-medium text-text-primary dark:bg-[rgba(255,255,255,0.1)]"
                  : "text-text-tertiary hover:bg-[rgb(var(--nb-75))] dark:hover:bg-[rgba(255,255,255,0.06)]"
              )}
            >
              {taskTitle(project).slice(0, 1)}
              {project.running && <StatusDot tone="success" className="absolute right-0.5 top-0.5" />}
            </button>
          ))}
        </div>
        <ThemeToggle collapsed />
        <NewProjectDialog
          open={newTaskOpen}
          onOpenChange={setNewTaskOpen}
          existingNames={existingNames}
          existingProjects={existingProjects}
          creating={creating}
          onCreate={handleCreate}
        />
      </div>
    );
  }

  /* ------------------------------- 展开态 ------------------------------- */
  const groups = groupTasks(projects);

  const renderTask = (project: Project, nested: boolean) => {
    const isActive = project.port === activePort;
    const isOpen = expanded.has(project.port);
    return (
      <div key={project.port}>
        <div
          onClick={() => onSelectProject(project.port)}
          className={cn(
            "group relative flex h-8 cursor-default items-center gap-2 rounded-lg pr-2 text-sm transition-colors duration-fast",
            nested ? "pl-7" : "pl-2.5",
            isActive
              ? "bg-[rgb(var(--nb-100))] font-medium text-text-primary dark:bg-[rgba(255,255,255,0.1)]"
              : "text-text-secondary hover:bg-[rgb(var(--nb-75))] dark:hover:bg-[rgba(255,255,255,0.06)]"
          )}
        >
          {project.running && <StatusDot tone="success" label="服务运行中" className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate" title={project.title || project.path}>
            {taskTitle(project)}
          </span>

          {/* 目录里只显示任务名；操作按钮悬停才露出。
              ⚠️ 必须用 opacity 而不是 hidden/display:none ——
                 display:none 的元素 getBoundingClientRect() 返回全 0，
                 而 Radix 靠这个测 trigger 的位置。菜单一打开鼠标就离开按钮，
                 按钮变回 display:none → 菜单被定位到 (0,0) **左上角**。
                 实测踩过：改了两轮 align/side 都没用，根因在这里。
                 focus-within 是给键盘操作的（菜单有焦点时也要可见）。 */}
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-within:opacity-100">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="xs"
                  aria-label={`任务 ${project.port} 操作`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              {/* 只留「删除」。
                  原来还有进入对话/启停服务器/复制路径 —— 前两个和直接点这一行重复，
                  第三个很少用，堆在一起反而让「删除」不好找。

                  位置：**下方 + 右对齐**（side=bottom align=end）。
                  试过 side="right"（在按钮右侧展开），Radix 因为侧栏太窄会翻转，
                  结果跑到侧栏**顶部**盖住了标题栏 —— 截图里就是这样。
                  现在是往下展开、右边缘和侧栏右缘对齐（也就是折叠按钮 << 那一列）。 */}
              <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-40">
                <DropdownMenuItem
                  className="text-danger focus:bg-danger/10 focus:text-danger"
                  onSelect={() => onDeleteProject(project.port)}
                >
                  <Trash2 />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        
      </div>
    );
  };

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden">
      {/* 品牌 */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <img src="/dove-icon.png" alt="Dove" className="size-5 shrink-0 rounded" draggable={false} />
        <span className="flex-1 truncate text-sm font-semibold text-text-primary">Dove</span>
        <Hint label="收起面板" shortcut="⌘B">
          <IconButton size="sm" aria-label="收起面板" onClick={() => onCollapsedChange(true)}>
            <ChevronsLeft />
          </IconButton>
        </Hint>
      </div>

      {/* 整宽「新会话」按钮（DSH 的白色胶囊） */}
      <div className="shrink-0 px-2.5 pb-2">
        <button
          type="button"
          onClick={() => onNewSession?.()}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-full border border-border-subtle bg-surface-raised text-sm font-medium text-text-primary shadow-sm transition-colors duration-fast hover:bg-[rgb(var(--nb-50))]"
        >
          <Plus className="size-4" />
          新会话
        </button>
      </div>

      {/* 分组标题 + 操作 */}
      <div className="flex h-7 shrink-0 items-center justify-between pl-4 pr-2">
        <span className="text-xs text-text-tertiary">任务</span>
        <div className="flex items-center gap-0.5">
          <Hint label="搜索任务" shortcut="⌘K">
            <IconButton size="xs" aria-label="搜索任务" onClick={() => setSearchOpen(true)}>
              <Search />
            </IconButton>
          </Hint>
          <Hint label="刷新">
            <IconButton size="xs" aria-label="刷新任务列表" onClick={onRefreshProjects}>
              <RefreshCw className={cn(loading && "animate-spin")} />
            </IconButton>
          </Hint>
        </div>
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && !projects.length ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-text-tertiary">
            <Spinner size={12} />
            加载中…
          </div>
        ) : projects.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <p className="text-sm text-text-secondary">还没有任务</p>
            <p className="mt-1 text-xs text-text-tertiary">点上面的「新会话」开始</p>
          </div>
        ) : (
          groups.map((group) => {
            const groupCollapsed = collapsedGroups.has(group.key);
            return (
              <div key={group.key} className="mb-0.5">
                {group.label && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    className="group/grp flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-sm text-text-secondary transition-colors duration-fast hover:bg-[rgb(var(--nb-75))] dark:hover:bg-[rgba(255,255,255,0.06)]"
                  >
                    <FolderOpen className="size-4 shrink-0 text-text-tertiary" />
                    <span className="min-w-0 flex-1 truncate text-left font-medium text-text-primary">
                      {group.label}
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-3.5 shrink-0 text-text-tertiary transition-transform duration-fast group-hover/grp:hidden",
                        groupCollapsed && "-rotate-90"
                      )}
                    />
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`在 ${group.label} 下新建会话`}
                      title={`在 ${group.label} 下新建会话`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onNewSessionInProject?.(group.label!);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.stopPropagation();
                          onNewSessionInProject?.(group.label!);
                        }
                      }}
                      className="hidden size-5 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-[rgba(38,49,72,0.1)] hover:text-text-primary group-hover/grp:flex"
                    >
                      <Plus className="size-3.5" />
                    </span>
                  </button>
                )}
                {!groupCollapsed && group.items.map((project) => renderTask(project, !!group.label))}
              </div>
            );
          })
        )}
      </div>

      {/* 底部：连接状态 + 主题 */}
      <div className="flex h-10 shrink-0 items-center justify-between border-t border-border-subtle px-3">
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          <span
            className={cn(
              "size-1.5 rounded-full",
              health === "online" ? "bg-success" : health === "offline" ? "bg-danger" : "bg-text-disabled"
            )}
          />
          {health === "online" ? "agent 在线" : health === "offline" ? "agent 离线" : "连接中…"}
        </div>
        <ThemeToggle />
      </div>

      <NewProjectDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        existingNames={existingNames}
        existingProjects={existingProjects}
        creating={creating}
        onCreate={handleCreate}
      />
      <CommandPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        projects={projects}
        onSelect={onSelectProject}
      />
    </aside>
  );
}
