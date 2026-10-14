"use client";

import * as React from "react";
import {
  Check, Copy, Download, ExternalLink, FolderOpen, MonitorPlay, MoreHorizontal,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { canOpenInNewWindow, kindLabel, type FileKind } from "@/lib/file-kinds";
import {
  copyFilePath, downloadProjectFile, openInNewWindow, openWithSystemApp, revealInFileManager,
  type ActionResult,
} from "@/lib/file-actions";

/**
 * 动作执行器（带 toast 反馈）—— 查看器里的醒目按钮与菜单共用同一套反馈口径。
 * 返回值 `{ok, message}` 的约定见 lib/file-actions.ts。
 *
 * 除了弹 toast，还把结果**原样返回**：有的调用方要按结果决定下一步（比如分体按钮
 * 「只在成功之后才记住这次选择」），各处再各写一遍 toast 必然口径不一致。
 */
export function useFileActionRunner(): (fn: () => Promise<ActionResult> | ActionResult) => Promise<ActionResult> {
  const { toast } = useToast();
  return React.useCallback(async (fn) => {
    try {
      const r = await fn();
      toast({ title: r.ok ? "完成" : "没做成", description: r.message, tone: r.ok ? "success" : "danger" });
      return r;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "没做成", description: message, tone: "danger" });
      return { ok: false, message };
    }
  }, [toast]);
}

export interface FileOpenMenuProps {
  /** 项目端口（null = 不在某个项目里，系统打开 / 下载会退化或不可用） */
  port: string | null;
  path: string;
  kind: FileKind;
  /** 这个文件此刻已经在右侧「文件」模块里 → 第一项显示成「当前」而不是可点项 */
  inPane?: boolean;
  /** 不在右侧预览时，点第一项把它开进右侧文件模块 */
  onPreview?: (path: string) => void;
  className?: string;
  /** 触发按钮的形态：图标按钮（查看器工具栏）或整行菜单（卡片行尾） */
  trigger?: "icon" | "text";
  label?: string;
}

/**
 * 「打开方式」菜单 —— 六个动作**只有一个实现**（file-actions.ts），
 * 每轮文件卡片 / 文件 tab / 查看器工具栏都挂它，避免三处各写一遍然后行为漂移。
 *
 * 现在查看器工具栏那颗按钮换成了「分体按钮」（components/open-in-app-button.tsx：左半用记住的
 * App 打开、右半挑 App），但这个菜单**没有退休**：本机一个可探测的 App 都没有 / 探测失败 /
 * 非 macOS 时，分体按钮就是渲染它 —— 六个动作一个都不能少。所以这里改行为等于同时改那条退化路径。
 *
 * 平台差异照实说（做不到的不假装能做到）：
 *  · macOS 的「在文件管理器里显示」会在 Finder 里**选中**该文件；Linux 只能开到所在目录；
 *  · 其它平台后端直接回 501（见 legacy/routes-open-path.ts），这里把原因显示出来；
 *  · 桌面版（WKWebView）的「下载」与「新窗口」可能被宿主拦下 —— 失败会把原因说出来，
 *    不会静默无反应。
 */
export function FileOpenMenu({
  port, path, kind, inPane, onPreview, className, trigger = "icon", label,
}: FileOpenMenuProps) {
  const [busy, setBusy] = React.useState(false);
  const runAction = useFileActionRunner();

  const run = React.useCallback(async (fn: () => Promise<ActionResult> | ActionResult) => {
    setBusy(true);
    try {
      await runAction(fn);
    } finally {
      setBusy(false);
    }
  }, [runAction]);

  const items: { key: string; icon: React.ReactNode; label: string; run: () => void }[] = [];

  if (inPane) {
    items.push({
      key: "here",
      icon: <Check className="text-success" />,
      label: `已在右侧预览（${kindLabel(kind)}）`,
      run: () => {},
    });
  } else if (onPreview) {
    items.push({
      key: "preview",
      icon: <MonitorPlay />,
      label: "在右侧文件模块预览",
      run: () => onPreview(path),
    });
  }

  items.push(
    {
      key: "default",
      icon: <ExternalLink />,
      label: "用系统默认应用打开",
      run: () => void run(() => openWithSystemApp(port, path)),
    },
    {
      key: "reveal",
      icon: <FolderOpen />,
      label: "在文件管理器里显示",
      run: () => void run(() => revealInFileManager(port, path)),
    },
    {
      key: "copy",
      icon: <Copy />,
      label: "复制路径",
      run: () => void run(() => copyFilePath(port, path)),
    },
    {
      key: "download",
      icon: <Download />,
      label: "下载 / 另存",
      run: () => {
        if (!port) { void runAction(async () => ({ ok: false, message: "还没有选中任务，无法下载" })); return; }
        void run(() => downloadProjectFile(port, path));
      },
    },
  );

  // 「新窗口打开」只对能在浏览器里独立渲染的类型有意义（html / 图片 / pdf / 音视频）
  if (canOpenInNewWindow(kind)) {
    items.push({
      key: "newwindow",
      icon: <ExternalLink />,
      label: "在新窗口打开",
      run: () => {
        if (!port) { void runAction(async () => ({ ok: false, message: "还没有选中任务，无法打开" })); return; }
        void runAction(async () => openInNewWindow(port, path));
      },
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger === "icon" ? (
          <button
            type="button"
            aria-label="打开方式"
            title="打开方式"
            disabled={busy}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors duration-fast",
              "hover:bg-surface-hover hover:text-text-primary disabled:opacity-50",
              className,
            )}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-text-tertiary transition-colors duration-fast",
              "hover:bg-surface-hover hover:text-text-primary disabled:opacity-50",
              className,
            )}
          >
            {label ?? "打开方式"}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>打开方式</DropdownMenuLabel>
        {items.map((item, index) => (
          <React.Fragment key={item.key}>
            {index === 1 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              // inPane 那条是状态说明，不是动作
              disabled={item.key === "here"}
              /**
               * **不要**在这里 preventDefault —— Radix 的 MenuItem 只有事件没被
               * defaultPrevented 时才关菜单（`@radix-ui/react-menu` 的 handleSelect：
               * `if (itemSelectEvent.defaultPrevented) … else rootContext.onClose()`），
               * 补上它菜单就会**永远不关**（仓库里其余 7 处 dropdown 也没有这句）。
               * 动作本身是异步的、会自己弹 toast 说结果，不需要靠「菜单不合上」来留痕。
               */
              onSelect={() => item.run()}
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default FileOpenMenu;
