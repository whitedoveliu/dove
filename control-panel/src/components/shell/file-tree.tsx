"use client";

import * as React from "react";
import {
  Braces,
  ChevronRight,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  FileType2,
  FolderClosed,
  FolderOpen,
  Loader2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { getProjectFiles, type ProjectFileEntry } from "@/lib/api";

/** Picks a lucide glyph from the file name / language hint. */
function FileGlyph({ entry }: { entry: ProjectFileEntry }) {
  const name = entry.name.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  const cls = "size-3.5 shrink-0";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"].includes(ext.slice(1)))
    return <FileImage className={cn(cls, "text-[oklch(0.62_0.15_320)]")} />;
  if ([".json", ".jsonc"].includes(ext)) return <FileJson className={cn(cls, "text-warning")} />;
  if ([".md", ".mdx", ".txt"].includes(ext)) return <FileText className={cn(cls, "text-text-tertiary")} />;
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".vue", ".svelte"].includes(ext))
    return <FileCode2 className={cn(cls, "text-info")} />;
  if ([".css", ".scss", ".less", ".html"].includes(ext)) return <Braces className={cn(cls, "text-[oklch(0.62_0.15_200)]")} />;
  return <FileType2 className={cn(cls, "text-text-tertiary")} />;
}

interface FileTreeProps {
  port: string;
  /** Substring filter applied to names at every level. */
  filter?: string;
  activePath?: string | null;
  onSelectFile?: (entry: ProjectFileEntry) => void;
  /** Notifies the parent so it can show a loading affordance. */
  onLoadingChange?: (loading: boolean) => void;
  /**
   * 目录展开的触发方式。
   * - "row"：整行点击即可展开（左侧目录面板沿用）
   * - "chevron"：只有行尾的箭头按钮能展开/收起（预览面板的文件树）
   */
  expandTrigger?: "row" | "chevron";
  /** 根目录为空时的自定义空态，默认一行「空目录」提示。 */
  emptyState?: React.ReactNode;
  className?: string;
}

/**
 * FileTree — lazy, keyboard-navigable project directory tree.
 *
 * Implements the WAI-ARIA tree pattern (role=tree/treeitem, aria-expanded,
 * roving focus with the arrow keys) and only fetches a directory's children
 * the first time it is expanded.
 */
export function FileTree({
  port,
  filter = "",
  activePath,
  onSelectFile,
  onLoadingChange,
  expandTrigger = "row",
  emptyState,
  className,
}: FileTreeProps) {
  const [childrenByPath, setChildrenByPath] = React.useState<Record<string, ProjectFileEntry[]>>({});
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Reset when switching projects.
  React.useEffect(() => {
    setChildrenByPath({});
    setExpanded(new Set());
    setError(null);
  }, [port]);

  const load = React.useCallback(
    async (path: string) => {
      setLoadingPaths((prev) => new Set(prev).add(path));
      onLoadingChange?.(true);
      try {
        const res = await getProjectFiles(port, path);
        setChildrenByPath((prev) => ({ ...prev, [path]: res.entries }));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "读取目录失败");
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        onLoadingChange?.(false);
      }
    },
    [port, onLoadingChange]
  );

  // Root listing.
  React.useEffect(() => {
    if (!port) return;
    let cancelled = false;
    (async () => {
      setLoadingPaths((prev) => new Set(prev).add(""));
      try {
        const res = await getProjectFiles(port, "");
        if (!cancelled) setChildrenByPath((prev) => ({ ...prev, "": res.entries }));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "读取目录失败");
      } finally {
        if (!cancelled)
          setLoadingPaths((prev) => {
            const next = new Set(prev);
            next.delete("");
            return next;
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port]);

  const toggle = React.useCallback(
    (entry: ProjectFileEntry) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      if (!childrenByPath[entry.path]) void load(entry.path);
    },
    [childrenByPath, load]
  );

  /** Arrow-key navigation across the flattened, rendered tree. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const nodes = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []
    );
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;

    const focusAt = (i: number) => nodes[Math.max(0, Math.min(nodes.length - 1, i))]?.focus();

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "ArrowRight": {
        event.preventDefault();
        const node = nodes[index];
        const path = node.dataset.path;
        const entry = path ? findEntry(childrenByPath, path) : undefined;
        if (entry && !expanded.has(entry.path)) toggle(entry);
        else focusAt(index + 1);
        break;
      }
      case "ArrowLeft": {
        event.preventDefault();
        const node = nodes[index];
        const path = node.dataset.path;
        if (path && expanded.has(path)) {
          const entry = findEntry(childrenByPath, path);
          if (entry) toggle(entry);
        }
        break;
      }
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(nodes.length - 1);
        break;
      default:
        break;
    }
  };

  const rootEntries = childrenByPath[""] ?? [];
  const query = filter.trim().toLowerCase();
  const filtered = query
    ? rootEntries.filter(
        (e) => e.name.toLowerCase().includes(query) || e.type === "dir"
      )
    : rootEntries;

  if (loadingPaths.has("") && !childrenByPath[""]) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-2xs text-text-tertiary">
        <Loader2 className="size-3 animate-spin" />
        读取目录…
      </div>
    );
  }

  if (error && !rootEntries.length) {
    return (
      <div className="px-3 py-2 text-2xs leading-relaxed text-danger-fg">
        {error}
        <button
          type="button"
          onClick={() => void load("")}
          className="ml-1 text-accent hover:underline"
        >
          重试
        </button>
      </div>
    );
  }

  if (!rootEntries.length) {
    return (
      <>
        {emptyState ?? <div className="px-3 py-2 text-2xs text-text-tertiary">空目录</div>}
      </>
    );
  }

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label="项目文件"
      onKeyDown={onKeyDown}
      className={cn("flex flex-col pb-1", className)}
    >
      {filtered.map((entry) => (
        <TreeItem
          key={entry.path}
          entry={entry}
          depth={0}
          expanded={expanded}
          loadingPaths={loadingPaths}
          childrenByPath={childrenByPath}
          filter={query}
          activePath={activePath}
          expandTrigger={expandTrigger}
          onToggle={toggle}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}

function findEntry(
  childrenByPath: Record<string, ProjectFileEntry[]>,
  path: string
): ProjectFileEntry | undefined {
  for (const list of Object.values(childrenByPath)) {
    const hit = list.find((e) => e.path === path);
    if (hit) return hit;
  }
  return undefined;
}

interface TreeItemProps {
  entry: ProjectFileEntry;
  depth: number;
  expanded: Set<string>;
  loadingPaths: Set<string>;
  childrenByPath: Record<string, ProjectFileEntry[]>;
  filter: string;
  activePath?: string | null;
  expandTrigger: "row" | "chevron";
  onToggle: (entry: ProjectFileEntry) => void;
  onSelectFile?: (entry: ProjectFileEntry) => void;
}

function TreeItem({
  entry,
  depth,
  expanded,
  loadingPaths,
  childrenByPath,
  filter,
  activePath,
  expandTrigger,
  onToggle,
  onSelectFile,
}: TreeItemProps) {
  const isDir = entry.type === "dir";
  const isOpen = expanded.has(entry.path);
  const isLoading = loadingPaths.has(entry.path);
  const children = childrenByPath[entry.path];
  const isActive = activePath === entry.path;

  const visibleChildren = React.useMemo(() => {
    if (!children) return [];
    if (!filter) return children;
    return children.filter((c) => c.name.toLowerCase().includes(filter) || c.type === "dir");
  }, [children, filter]);

  return (
    <div role="none">
      <div
        role="treeitem"
        aria-expanded={isDir ? isOpen : undefined}
        aria-selected={isActive}
        aria-level={depth + 1}
        data-path={entry.path}
        tabIndex={0}
        title={entry.path}
        onClick={() => {
          if (!isDir) {
            onSelectFile?.(entry);
            return;
          }
          // chevron 模式：只有行尾箭头能展开，避免点目录时误触
          if (expandTrigger === "row") onToggle(entry);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isDir) onToggle(entry);
            else onSelectFile?.(entry);
          }
        }}
        className={cn(
          "tree-row cursor-default",
          !isDir && "cursor-pointer",
          isActive && "font-medium"
        )}
        data-active={isActive}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        {isDir && expandTrigger === "row" ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-text-tertiary transition-transform duration-fast ease-emphasized",
              isOpen && "rotate-90"
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {isLoading ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-text-tertiary" />
        ) : isDir ? (
          isOpen ? (
            <FolderOpen className="size-3.5 shrink-0 text-accent" />
          ) : (
            <FolderClosed className="size-3.5 shrink-0 text-text-tertiary" />
          )
        ) : (
          <FileGlyph entry={entry} />
        )}

        <span className="min-w-0 truncate">{entry.name}</span>

        {isDir && expandTrigger === "chevron" && (
          <button
            type="button"
            aria-label={isOpen ? `收起 ${entry.name}` : `展开 ${entry.name}`}
            title={isOpen ? "收起目录" : "展开目录"}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(entry);
            }}
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
          >
            <ChevronRight
              className={cn(
                "size-3 transition-transform duration-fast ease-emphasized",
                isOpen && "rotate-90"
              )}
            />
          </button>
        )}
      </div>

      {isDir && isOpen && (
        <div role="group" className="flex flex-col">
          {isLoading && !children ? (
            <div
              className="flex items-center gap-2 py-1 text-2xs text-text-tertiary"
              style={{ paddingLeft: 6 + (depth + 1) * 12 + 12 }}
            >
              加载中…
            </div>
          ) : visibleChildren.length ? (
            visibleChildren.map((child) => (
              <TreeItem
                key={child.path}
                entry={child}
                depth={depth + 1}
                expanded={expanded}
                loadingPaths={loadingPaths}
                childrenByPath={childrenByPath}
                filter={filter}
                activePath={activePath}
                expandTrigger={expandTrigger}
                onToggle={onToggle}
                onSelectFile={onSelectFile}
              />
            ))
          ) : (
            <div
              className="py-1 text-2xs text-text-tertiary"
              style={{ paddingLeft: 6 + (depth + 1) * 12 + 12 }}
            >
              空
            </div>
          )}
        </div>
      )}
    </div>
  );
}
