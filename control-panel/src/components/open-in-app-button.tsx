"use client";

/**
 * 「打开方式」**分体按钮**（文件查看器工具栏右上角）—— 交互口径参考 DSH（DeepSeek Harness）
 * 的 open-in-app：左半 = 用记住的那个 App 打开，右半 = 箭头，菜单里列已探测到的 App
 * （记住的那个标「（默认）」），底部固定「显示文件位置」「复制路径」。
 *
 * 结构（为什么这么切）：
 *   · 左半是**一个动作**（点了就打开），右半是**一个菜单**（挑 App）—— 合成一个按钮就必然
 *     有「点哪儿」的歧义，分成两块是最不容易点错的排法；
 *   · 菜单里那一串 App 是**可滚动区**，底部两条不跟着滚（否则 App 一多，「复制路径」就被顶走了）。
 *
 * 退化路径（**不许变砖**）：
 *   · 清单还在路上 → 一枚骨架（灰条）；点了没反应也好过先给个错的 App；
 *   · 探测失败 / 一个 App 都没探到 / 非 macOS → 直接渲染原来的 `FileOpenMenu`
 *     （系统默认应用 / 下载 / 新窗口 / 复制路径 一个都不少）；
 *   · 图标抽不到 → lucide 通用图标（不占位、不抖）。
 *
 * 记住的选择存 localStorage，键名见 lib/open-in-app.ts；**只在打开成功之后**才记 ——
 * 把一次失败也记住，下次点同一个按钮还是打不开。
 *
 * 尺寸：高度 24px（`h-6`）与工具栏其余按钮齐平；圆角用 Dove 的 `rounded-md`，
 * 不用 DSH 的 9px —— 这一条的取舍写在交付说明里（同一排按钮的圆角必须一致）。
 */
import * as React from "react";
import {
  AppWindow, Check, ChevronDown, Copy, Download, ExternalLink, FolderOpen,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { Hint } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileOpenMenu } from "@/components/file-open-menu";
import { canOpenInNewWindow, kindLabel, type FileKind } from "@/lib/file-kinds";
import {
  copyFilePath, downloadProjectFile, openInNewWindow, openWithSystemApp, revealInFileManager,
} from "@/lib/file-actions";
import { openProjectPathWithApp, type OpenInAppEntry } from "@/lib/api";
import {
  pickDefaultApp, readRememberedAppId, rememberAppId, useAppIconUrl, useOpenInApps,
} from "@/lib/open-in-app";

export interface OpenInAppButtonProps {
  /** 项目端口（null = 不在某个项目里，内核会退回工作区根边界） */
  port: string | null;
  path: string;
  kind: FileKind;
  /** 这个文件此刻已经在右侧「文件」模块里 → 菜单顶部显示状态而不是动作（同 FileOpenMenu） */
  inPane?: boolean;
  className?: string;
}

/** 一个 App 的图标：取不到就退回通用图标（不占位、不抖） */
function AppGlyph({ id, className }: { id: string; className?: string }) {
  const url = useAppIconUrl(id);
  if (url) return <img src={url} alt="" className={cn("size-3.5 shrink-0", className)} />;
  return <AppWindow className={cn("size-3.5 shrink-0 text-text-tertiary", className)} />;
}

/** 主按钮上那枚图标：跟着「当前默认 App」走（每个 App 的图标在 lib/open-in-app.ts 里缓存） */
function ChosenGlyph({ app, url }: { app: OpenInAppEntry; url: string | null }) {
  if (url) return <img src={url} alt="" className="size-3.5 shrink-0" />;
  // 「显示位置」那个 App（访达）用文件夹图标，比一个通用窗口更像它要做的事
  return app.action === "reveal"
    ? <FolderOpen className="size-3.5 shrink-0" />
    : <AppWindow className="size-3.5 shrink-0" />;
}

export function OpenInAppButton({ port, path, kind, inPane, className }: OpenInAppButtonProps) {
  const { toast } = useToast();
  const list = useOpenInApps();
  const [remembered, setRemembered] = React.useState<string | null>(readRememberedAppId);
  const [busy, setBusy] = React.useState(false);

  const chosen = pickDefaultApp(list.apps, remembered);
  const chosenIcon = useAppIconUrl(chosen?.id ?? null);

  /** 带 toast 的动作执行器（结果照返回，决定要不要记住这次选择） */
  const run = React.useCallback(async (fn: () => Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string }) => {
    setBusy(true);
    try {
      const r = await fn();
      toast({ title: r.ok ? "完成" : "没做成", description: r.message, tone: r.ok ? "success" : "danger" });
      return r.ok;
    } catch (e) {
      toast({ title: "没做成", description: e instanceof Error ? e.message : String(e), tone: "danger" });
      return false;
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const openWith = React.useCallback(async (app: OpenInAppEntry) => {
    const ok = await run(() => openProjectPathWithApp({ projectId: port, path, appId: app.id }));
    if (ok) {
      rememberAppId(app.id);
      setRemembered(app.id);
    }
  }, [run, port, path]);

  // 空态提示：清单为空 / 探测失败 / 还没回来时，界面上给的是骨架或原菜单（见下面）

  // ① 探测失败 / 一个 App 都没装 → 原样退回原来的「打开方式」菜单（六个动作一个不少）
  if (list.status === "error" || (list.status === "ready" && list.apps.length === 0)) {
    return <FileOpenMenu port={port} path={path} kind={kind} inPane={inPane} className="size-6" />;
  }

  // ② 清单还在路上 → 骨架（DSH 的「查询中的骨架」，点了没反应好过先给个错的 App）
  if (list.status === "loading" || !chosen) {
    return (
      <div
        aria-hidden
        className={cn("h-6 w-11 shrink-0 animate-pulse-soft rounded-md bg-surface-hover", className)}
      />
    );
  }

  const mainLabel = chosen.action === "reveal" ? `显示文件位置（${chosen.name}）` : `用 ${chosen.name} 打开`;

  return (
    <div className={cn("flex h-6 shrink-0 items-stretch overflow-hidden rounded-md border border-border-subtle", className)}>
      <Hint label={mainLabel}>
        <button
          type="button"
          aria-label={mainLabel}
          disabled={busy}
          onClick={() => void openWith(chosen)}
          className={cn(
            "flex h-full items-center gap-1 px-1.5 text-text-secondary transition-colors duration-fast",
            "hover:bg-surface-hover hover:text-text-primary disabled:opacity-50",
          )}
        >
          <ChosenGlyph app={chosen} url={chosenIcon} />
        </button>
      </Hint>

      <span aria-hidden className="my-1 w-px shrink-0 bg-border-subtle" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="选择其他打开方式"
            title="打开方式"
            disabled={busy}
            className={cn(
              "flex h-full items-center px-0.5 text-text-tertiary transition-colors duration-fast",
              "hover:bg-surface-hover hover:text-text-primary disabled:opacity-50",
            )}
          >
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 p-0">
          <div className="p-1">
            <DropdownMenuLabel>打开方式</DropdownMenuLabel>
            {inPane && (
              <DropdownMenuItem disabled>
                <Check className="text-success" />
                <span className="truncate">已在右侧预览（{kindLabel(kind)}）</span>
              </DropdownMenuItem>
            )}
          </div>

          {/* 应用列表：可滚动（App 多起来不会把底部的固定动作顶走） */}
          <div className="max-h-64 overflow-y-auto p-1">
            {list.apps.map((app) => (
              <DropdownMenuItem key={app.id} onSelect={() => void openWith(app)}>
                <AppGlyph id={app.id} />
                <span className="truncate">{app.name}</span>
                {app.id === chosen.id && (
                  <span className="ml-auto shrink-0 text-2xs text-text-tertiary">（默认）</span>
                )}
              </DropdownMenuItem>
            ))}
          </div>

          <DropdownMenuSeparator className="mx-0 my-0" />

          {/* 固定底栏：契约要求的「显示文件位置 / 复制路径」，外加原文案的其余动作（不丢功能） */}
          <div className="p-1">
            <DropdownMenuItem onSelect={() => void run(() => revealInFileManager(port, path))}>
              <FolderOpen />
              <span className="truncate">显示文件位置</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void run(() => copyFilePath(port, path))}>
              <Copy />
              <span className="truncate">复制路径</span>
            </DropdownMenuItem>
          </div>

          <DropdownMenuSeparator className="mx-0 my-0" />

          <div className="p-1">
            <DropdownMenuItem onSelect={() => void run(() => openWithSystemApp(port, path))}>
              <ExternalLink />
              <span className="truncate">用系统默认应用打开</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                if (!port) { toast({ title: "没做成", description: "还没有选中任务，无法下载", tone: "danger" }); return; }
                void run(() => downloadProjectFile(port, path));
              }}
            >
              <Download />
              <span className="truncate">下载 / 另存</span>
            </DropdownMenuItem>
            {canOpenInNewWindow(kind) && (
              <DropdownMenuItem
                onSelect={() => {
                  if (!port) { toast({ title: "没做成", description: "还没有选中任务，无法打开", tone: "danger" }); return; }
                  void run(async () => openInNewWindow(port, path));
                }}
              >
                <ExternalLink />
                <span className="truncate">在新窗口打开</span>
              </DropdownMenuItem>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default OpenInAppButton;
