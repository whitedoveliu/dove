"use client";

import * as React from "react";
import { FolderTree } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ProjectFileEntry } from "@/lib/api";
import { FileTree } from "@/components/shell/file-tree";
import { EmptyState } from "@/components/ui/empty-state";
import { FileTabs } from "@/components/file-tabs";
import { FileViewer } from "@/components/file-viewer";

export interface PreviewFilesPaneProps {
  /** 项目端口；为空时展示空态 */
  port: string | null;
  /** 开发服务器端口（保留：老调用方在传；文件预览一律走 /preview 路由，不再依赖它） */
  devServerPort?: string | null;
  className?: string;
  /**
   * 外部要求打开的文件（点每轮文件卡片 / 交付物卡片 → 在右侧「文件」模块以 tab 打开）。
   * `token` 变化即再聚焦一次 —— 同一个文件点两次也要把 tab 切到前面来。
   */
  openPath?: { path: string; token: number } | null;
  /**
   * 这条请求已经消费掉的回调（带上消费时的 token，调用方只清同 token 的那条）。
   *
   * 为什么必须有：`openPath` 在 App 里是个**只 set 不清**的状态，而本组件会随
   * 预览面板的折叠/展开**卸载重挂**（AppShell 收起 aside 就不渲染了）。不消费掉的话，
   * 「在任务 A 点过文件 → 收起预览 → 切到任务 B → 展开预览」会在 B 下开出一个 A 的文件 tab
   * （并报「文件不存在」）—— 挂载时那个 effect 照样会跑一次。
   */
  onOpenPathConsumed?: (token: number) => void;
}

/**
 * PreviewFilesPane —— 预览面板的「文件」页。
 *
 * 结构（从上到下）：项目文件树 → **文件 tab 条** → 当前 tab 的内容。
 *  - 点树里的文件 = 开一个 tab（不再是「下面换一个预览」的单文件模式）；
 *  - 点多个文件就有多个 tab，每个可关，关了当前的回相邻 tab，全关掉就只剩文件树；
 *  - 外部（聊天区每轮文件卡片）打开同一个文件时，复用已有 tab 而不是再开一个。
 *
 * 为什么 tab 状态放在这里而不是 PreviewPanel：这是「文件模块」自己的视图状态，
 * 外部只需要一个 `openPath` 入口（见 PreviewPanel 的同名 prop）。
 */
export function PreviewFilesPane({ port, devServerPort: _devServerPort, className, openPath, onOpenPathConsumed }: PreviewFilesPaneProps) {
  const [tabs, setTabs] = React.useState<string[]>([]);
  const [active, setActive] = React.useState<string | null>(null);

  // 切换任务时清掉已开文件，避免看到上一个任务的内容（老行为，不能丢）
  React.useEffect(() => {
    setTabs([]);
    setActive(null);
  }, [port]);

  const openTab = React.useCallback((path: string) => {
    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActive(path);
  }, []);

  // 外部请求打开（token 变化才触发；首次 openPath 为 null 时什么都不做）。
  // 消费完**立刻**告诉调用方把请求清掉，否则重挂时它还会再放一遍（见 props 注释）。
  const onConsumedRef = React.useRef(onOpenPathConsumed);
  onConsumedRef.current = onOpenPathConsumed;
  const token = openPath?.token ?? 0;
  const wanted = openPath?.path ?? "";
  React.useEffect(() => {
    if (!wanted) return;
    openTab(wanted);
    onConsumedRef.current?.(token);
  }, [token, wanted, openTab]);

  /**
   * 关闭一个 tab：关的是当前 tab 就落到相邻（右邻优先，没有则左邻），否则当前不动。
   * 先算 `next` 再分别 setState —— **不能在 setTabs 的 updater 里 setActive**：
   * updater 必须是纯函数（StrictMode 下会跑两次，副作用会被放大）。
   */
  const closeTab = React.useCallback((path: string) => {
    const index = tabs.indexOf(path);
    if (index === -1) return;
    const next = tabs.filter((p) => p !== path);
    setTabs(next);
    if (active === path) setActive(next[index] ?? next[index - 1] ?? null);
  }, [tabs, active]);

  if (!port) {
    return (
      <EmptyState
        className={className}
        icon={<FolderTree />}
        title="尚未选择任务"
        description="在左侧目录面板选择或新建一个任务，这里会显示它的文件。"
      />
    );
  }

  const onSelectFile = (entry: ProjectFileEntry) => openTab(entry.path);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div
        className={cn(
          // overflow-x-hidden：只要有一个轴是 auto，另一个轴的 visible 会被算成 auto ——
          // 面板里任何一次 scrollIntoView 都能把整个右栏**横向**推歪（实测踩过）。
          // 纵向滚文件树就够了，横向必须是隐藏的。
          "min-h-0 overflow-y-auto overflow-x-hidden px-1.5 py-1",
          active ? "max-h-[38%] shrink-0" : "flex-1",
        )}
      >
        <FileTree
          port={port}
          expandTrigger="chevron"
          activePath={active}
          onSelectFile={onSelectFile}
          emptyState={
            <EmptyState
              compact
              icon={<FolderTree />}
              title="这里还是空的"
              description="让 AI 先生成代码，或新建文件后再回来看看。"
            />
          }
        />
      </div>

      {tabs.length > 0 && active && (
        <>
          <div className="hairline" />
          <FileTabs
            tabs={tabs}
            activePath={active}
            onSelect={setActive}
            onClose={closeTab}
          />
          {/* key = 路径：切换 tab 重新挂载查看器，内部状态（缩放 / 源码视图）不会串到另一个文件 */}
          <FileViewer key={active} port={port} path={active} className="min-h-0 flex-1" />
        </>
      )}
    </div>
  );
}

export default PreviewFilesPane;
