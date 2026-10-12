"use client";

import { useRef, useState, useEffect, useMemo } from "react";
import { RefreshCw, CirclePower, Loader2, Settings2, History, Play, Plus, ChevronDown, Check, PanelRight, Globe, FolderTree, ScrollText, TriangleAlert } from "lucide-react";
import { resetProject, createProject, checkProjectExists, getVersionList, switchVersion, setPreviewVersion, VersionInfo, restartProjectServer } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PreviewFilesPane } from "@/components/preview-files-pane";
import { normalizeProjectPath } from "@/lib/presented-files";
import {
  addressOf, filePreviewUrl, fileRelOf, frameSrcFor, isProxied, normalizePreviewInput,
  type PreviewContext,
} from "@/lib/preview-url";
import { SessionLogView } from "@/components/session-log-view";
import { cn } from "@/lib/utils";

type PreviewTab = "files" | "browser" | "log";

/** 刷新按钮用的 _dove=<n>：只加在 iframe 的 src 上，不动真实 URL / 代理参数 */
function withNonce(src: string, nonce: number): string {
  if (!src || !nonce) return src;
  try { const u = new URL(src); u.searchParams.set("_dove", String(nonce)); return u.href; } catch { return src; }
}

interface PreviewPanelProps {
  url: string;
  iframeRef?: React.RefObject<HTMLIFrameElement | null>;
  historyVersion?: number | null;
  latestVersion?: number;
  onBackToLatest?: () => void;
  projectId?: string | null;
  onProjectSelect?: (port: string) => void;
  onVersionChange?: (version: number) => void;
  onRefreshPreview?: () => void;
  isGenerating?: boolean;  // AI 是否正在生成
  isStartingServer?: boolean;  // 是否正在启动服务器
  isSwitchingToCache?: boolean;  // 是否正在切换到缓存
  isRefreshingPreview?: boolean;  // 是否正在刷新静态预览
  onBuildError?: (error: string) => void;  // 构建错误回调
  isSwitchingVersion?: boolean;  // 外部传入的版本切换状态
  onSwitchingVersionChange?: (switching: boolean) => void;  // 版本切换状态变化回调
  devServerPort?: string | null;  // 实际热更新端口
  onDevServerPortChange?: (port: string | null) => void;  // 实际热更新端口变化回调
  onStartDevServer?: () => void;  // 启动开发服务器（浏览器空态里的按钮）
  asideCollapsed?: boolean;  // 右侧对话区是否已折叠
  onToggleAside?: () => void;  // 折叠/展开右侧对话区
  /** agent 产出的网页：直接在浏览器标签打开（force = 用户自己点的交付物卡片） */
  openTarget?: { path: string; token: number; force?: boolean } | null;
  /** 内核说「预览就绪」（preview_ready）→ 每次自增，把右侧切回浏览器标签 */
  focusToken?: number;
}

export default function PreviewPanel({ url, iframeRef, historyVersion, latestVersion, onBackToLatest, projectId, onProjectSelect, onVersionChange, onRefreshPreview, isGenerating, isStartingServer, isSwitchingToCache, isRefreshingPreview, onBuildError, isSwitchingVersion: externalSwitching, onSwitchingVersionChange, devServerPort, onDevServerPortChange, onStartDevServer, asideCollapsed, onToggleAside, openTarget, focusToken }: PreviewPanelProps) {
  const [tab, setTab] = useState<PreviewTab>("browser");
  // 浏览器标签默认停在空态：用户点「运行开发服务器」或自己输网址后才接管
  const [currentUrl, setCurrentUrl] = useState("");
  const [inputUrl, setInputUrl] = useState(url);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  /** 刷新计数：只影响 iframe 的 src（_dove=<n>），不破坏真实 URL / 代理参数 */
  const [frameNonce, setFrameNonce] = useState(0);
  /** 用户手动在地址栏输过 → 之后不再自动抢他的画面 */
  const manualNavRef = useRef(false);
  /** 当前画面是某个具体文件（agent 产出 / 用户点卡片）→ 不被项目预览顶掉 */
  const pinnedFileRef = useRef(false);
  /** 用户表达过「要运行」→ App 一产出预览地址就接管 */
  const wantRunRef = useRef(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  
  // 项目选择相关状态
  const [portInput, setPortInput] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [showPortPopover, setShowPortPopover] = useState(false);
  
  // 版本列表相关状态
  const [showVersionPopover, setShowVersionPopover] = useState(false);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [isSwitchingVersion, setIsSwitchingVersion] = useState(false);
  const [loadedForVersion, setLoadedForVersion] = useState<number | null>(null); // 记录已加载的版本号
  
  // 服务器重启状态
  const [isRestartingServer, setIsRestartingServer] = useState(false);
  
  // 地址归一化 / 代理判定用的上下文（面板里 projectId 就是端口号字符串）
  const previewCtx: PreviewContext = useMemo(() => ({
    projectId: projectId ?? null,
    currentUrl,
    devServerPort: devServerPort ?? null,
    origin: typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8790",
    panelHost: typeof window !== "undefined" ? window.location.hostname : "127.0.0.1",
  }), [projectId, currentUrl, devServerPort]);
  const ctxRef = useRef(previewCtx);
  ctxRef.current = previewCtx;

  /** iframe 真正加载的地址：外站走同源代理，本机 / 项目预览直连 */
  const frameSrc = useMemo(
    () => withNonce(frameSrcFor(currentUrl, previewCtx), frameNonce),
    [currentUrl, previewCtx, frameNonce],
  );
  const proxied = isProxied(currentUrl, previewCtx);
  const staticPreview = /:8008\/preview\//.test(currentUrl) || fileRelOf(currentUrl, previewCtx) !== null;

  // 切换项目：接管标志复位，重新跟随新项目的预览
  useEffect(() => {
    manualNavRef.current = false;
    pinnedFileRef.current = false;
    setAddressError(null);
  }, [projectId]);

  // App / 内核给的项目预览地址 —— 自动跟随并切到浏览器标签；用户接管过就不抢
  useEffect(() => {
    if (!url) {
      if (!manualNavRef.current && !pinnedFileRef.current) { setCurrentUrl(""); setInputUrl(""); }
      return;
    }
    // 「用户点了运行」优先于接管标志：跑起来的开发服务器就是要接管画面
    if (!wantRunRef.current && (manualNavRef.current || pinnedFileRef.current)) return;
    wantRunRef.current = false;
    setCurrentUrl(url);
    setInputUrl(addressOf(url, ctxRef.current));
    setProxyError(null);
    setTab("browser");
  }, [url, projectId]);

  // agent 产出的网页（Present 的 .html / 用户点交付物卡片）→ 浏览器标签直接打开它
  useEffect(() => {
    if (!openTarget || !openTarget.path) return;
    if (!openTarget.force && manualNavRef.current) return;   // 用户自己输过地址 → 不抢
    const rel = normalizeProjectPath(openTarget.path);
    pinnedFileRef.current = true;
    setCurrentUrl(filePreviewUrl(rel, ctxRef.current));
    setInputUrl(rel);
    setAddressError(null);
    setProxyError(null);
    setFrameNonce((n) => n + 1);
    setTab("browser");
  }, [openTarget?.token]);

  // 收到 preview_ready（focusToken 自增）→ 切回浏览器标签，让用户直接看到刚产出的页面
  useEffect(() => {
    if (!focusToken) return;
    if (manualNavRef.current) return;   // 用户接管过地址栏 → 不抢
    setTab("browser");
  }, [focusToken]);

  // 外站代理探针：只取状态与可读原因（不下载 body）；失败就在面板里显示原因
  useEffect(() => {
    if (!currentUrl || !isProxied(currentUrl, ctxRef.current)) { setProxyError(null); return; }
    const probeUrl = frameSrcFor(currentUrl, ctxRef.current) + "&probe=1";
    const ac = new AbortController();
    let alive = true;
    fetch(probeUrl, { signal: ac.signal, cache: "no-store", headers: { Accept: "application/json" } })
      .then(async (r) => {
        const data = await r.json().catch(() => null) as { ok?: boolean; message?: string } | null;
        if (!alive) return;
        // 老内核没有这个路由 → 返回的不是代理 JSON，此时保持安静，交给 iframe 自己显示
        if (data && data.ok === false) setProxyError(data.message ?? `代理返回 ${r.status}`);
        else setProxyError(null);
      })
      .catch(() => { /* 探针失败不打扰：iframe 里还有代理渲染的错误页 */ });
    return () => { alive = false; ac.abort(); };
  }, [currentUrl, frameNonce]);

  // 监听 iframe 内部导航，更新地址栏显示
  // 通过 postMessage 接收 iframe 发送的 URL 变化通知（解决跨域问题）
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // 验证消息类型
      if (event.data?.type === 'IFRAME_URL_CHANGE' && event.data?.url) {
        setInputUrl(addressOf(String(event.data.url), ctxRef.current));
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [projectId]);

  // 加载版本列表
  const loadVersions = async () => {
    if (!projectId) return;
    
    setIsLoadingVersions(true);
    try {
      const result = await getVersionList(projectId, 30);
      if (result.success) {
        setVersions(result.versions);
        // 记录当前加载的最新版本号（从返回结果中获取）
        setLoadedForVersion(result.current_version || 0);
        console.log(`📜 版本列表已加载，当前版本: ${result.current_version}，共 ${result.versions.length} 个版本`);
      }
    } catch (error) {
      console.error("加载版本列表失败:", error);
    } finally {
      setIsLoadingVersions(false);
    }
  };

  // 切换版本
  const handleVersionSelect = async (version: VersionInfo) => {
    if (!projectId || !version.commit_hash) return;
    
    setIsSwitchingVersion(true);
    onSwitchingVersionChange?.(true);
    try {
      // 如果是最新版本，不需要设置预览版本（使用热更服务器）
      const isLatest = version.version_number === latestVersion;
      
      if (!isLatest) {
      // 设置预览版本（使用缓存的构建结果）
        const result = await setPreviewVersion(projectId, version.version_number);
        console.log("📦 setPreviewVersion 结果:", result);
        
        // 检查是否有构建错误
        if (!result.success && result.error) {
          console.error("版本构建失败:", result.error);
          // 通知父组件构建错误
          onBuildError?.(result.error);
        } else {
          // 构建成功，清除之前的错误
          onBuildError?.("");
        }
      } else {
        // 最新版本，清除预览版本设置
        await setPreviewVersion(projectId, null);
        // 清除之前的错误
        onBuildError?.("");
      }
      
      // 切换代码版本
      await switchVersion(version.commit_hash, projectId);
      onVersionChange?.(version.version_number);
      // 用户主动切版本 = 主动看这个项目的预览 → 解除接管，让 url 跟着更新
      manualNavRef.current = false;
      pinnedFileRef.current = false;
      setShowVersionPopover(false);
      // 刷新预览
      onRefreshPreview?.();
    } catch (error) {
      console.error("切换版本失败:", error);
      alert(`切换版本失败: ${error}`);
    } finally {
      setIsSwitchingVersion(false);
      onSwitchingVersionChange?.(false);
    }
  };

  // 当最新版本变化时，重新加载版本列表
  useEffect(() => {
    // latestVersion 变化且有效时，刷新版本列表
    if (latestVersion !== undefined && latestVersion !== null && latestVersion > 0) {
      // 只有当 latestVersion 比已加载的版本更新时才刷新
      if (latestVersion > (loadedForVersion || 0)) {
        console.log(`📜 检测到新版本: ${loadedForVersion} -> ${latestVersion}，重新加载版本列表`);
        loadVersions();
      }
    }
  }, [latestVersion]);

  // 打开版本列表时加载数据（仅首次）
  useEffect(() => {
    if (showVersionPopover && versions.length === 0) {
      loadVersions();
    }
  }, [showVersionPopover]);
  
  // 创建或进入项目
  const handleEnterProject = async () => {
    if (!portInput.trim() || !onProjectSelect) return;
    
    const port = portInput.trim();
    
    // 验证端口号
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 3000 || portNum > 3009) {
      alert("请输入有效的端口号（3000-3009）");
      return;
    }
    if (portNum === 3006) {
      alert("3006 端口已被控制面板占用，请选择其他端口");
      return;
    }
    
    setIsCreating(true);
    
    try {
      // 检查项目是否存在
      const { exists } = await checkProjectExists(port);
      
      if (!exists) {
        // 项目不存在，创建新项目
        await createProject(port);
      }
      
      // 选择项目
      onProjectSelect(port);
      setShowPortPopover(false);
      setPortInput("");
      
      // 刷新预览
      manualNavRef.current = false;
      pinnedFileRef.current = false;
      const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
      openUrl(`http://${host}:8008/preview/${port}/`, false);
    } catch (error) {
      console.error("进入项目失败:", error);
      alert(`进入项目失败: ${error}`);
    } finally {
      setIsCreating(false);
    }
  };

  /** 打开一个地址：地址栏显示人话，iframe 用真实 URL（外站会自动走代理） */
  const openUrl = (target: string, pinned?: boolean) => {
    setCurrentUrl(target);
    setInputUrl(addressOf(target, ctxRef.current));
    if (pinned !== undefined) pinnedFileRef.current = pinned;
    setAddressError(null);
    setProxyError(null);
    setFrameNonce((n) => n + 1);
  };

  const handleUrlChange = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = inputUrl.trim();
    if (!raw) {
      // 清空地址栏回车 → 回到「随时可以浏览」空态，并把自动接管权交回去
      manualNavRef.current = false;
      pinnedFileRef.current = false;
      setCurrentUrl("");
      setInputUrl("");
      setAddressError(null);
      setProxyError(null);
      return;
    }
    const next = normalizePreviewInput(raw, ctxRef.current);
    if (!next.ok) {
      // 非法输入给明确提示，不静默变空白
      setAddressError(next.message);
      return;
    }
    manualNavRef.current = true;   // 用户接管：之后的项目预览 / 自动打开都不再抢
    openUrl(next.url, next.kind === "file");
  };

  /** 空态里的「运行开发服务器」：先解除接管，再让 App 去启动 */
  const handleStartDevServer = () => {
    manualNavRef.current = false;
    pinnedFileRef.current = false;
    wantRunRef.current = true;
    onStartDevServer?.();
  };

  const handleRefresh = () => {
    if (!currentUrl) return;
    // 只换 iframe src 上的 _dove=<n>：代理参数、项目文件路径都不受影响
    setFrameNonce((n) => n + 1);
  };

  const handleRestartServer = async () => {
    if (!projectId || isRestartingServer) return;
    
    setIsRestartingServer(true);
    try {
      const result = await restartProjectServer(projectId);
      if (result.success) {
        console.log(`✅ 服务器重启成功: ${result.message}`);
        if (result.actual_port) {
          const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
          const path = addressOf(currentUrl, ctxRef.current);
          manualNavRef.current = false;
          pinnedFileRef.current = false;
          openUrl(`http://${host}:${result.actual_port}${path}`);
          onDevServerPortChange?.(result.actual_port);
        }
        // 等待服务器启动后刷新预览
        setTimeout(() => {
          handleRefresh();
        }, 2000);
      } else {
        console.error("服务器重启失败:", result.message);
        alert(`服务器重启失败: ${result.message}`);
      }
    } catch (error) {
      console.error("服务器重启失败:", error);
      alert(`服务器重启失败: ${error}`);
    } finally {
      setIsRestartingServer(false);
    }
  };

  const handleResetProject = () => {
    setShowResetConfirm(true);
  };

  const confirmReset = async () => {
    if (!projectId) return;
    
    setShowResetConfirm(false);
    setIsResetting(true);
    
    try {
      await resetProject(projectId);
      console.log(`✅ 项目 ${projectId} 重置成功`);
      // 重置成功后刷新页面
      window.location.reload();
    } catch (error) {
      console.error("重置失败:", error);
      alert(`重置失败: ${error}`);
      setIsResetting(false);
    }
  };

  const cancelReset = () => {
    setShowResetConfirm(false);
  };

  // 状态标签：静态（老预览 / 项目文件）/ 实时（dev server）/ 外站（走代理）
  const previewKind: "static" | "live" | "external" = proxied ? "external" : (staticPreview ? "static" : "live");

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border-subtle bg-surface-raised">
      {/* 顶部标签栏：文件 / 浏览器 / 日志 */}
      <div className="pane-header justify-between gap-2">
        <Tabs value={tab} onValueChange={(value) => setTab(value as PreviewTab)}>
          <TabsList>
            <TabsTrigger value="files">
              <FolderTree />
              文件
            </TabsTrigger>
            <TabsTrigger value="browser">
              <Globe />
              浏览器
            </TabsTrigger>
            <TabsTrigger value="log">
              <ScrollText />
              日志
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* 折叠右侧对话区 */}
        {onToggleAside && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="收起预览区"
                  onClick={onToggleAside}
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors duration-fast hover:bg-[rgb(var(--nb-75))] hover:text-text-primary"
                >
                  <PanelRight className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">收起预览区</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* ---------------- 浏览器 ---------------- */}
        {/* 用 hidden 而不是卸载，切换标签时 iframe 不会白屏重载 */}
        <div className={cn("min-h-0 flex-1 flex-col", tab === "browser" ? "flex" : "hidden")}>
          <div className="flex h-10 shrink-0 items-center gap-1 px-2">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton size="sm" aria-label="刷新预览" onClick={handleRefresh}>
                    <RefreshCw />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom"><p className="text-xs">刷新预览</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton
                    size="sm"
                    aria-label="重启开发服务器"
                    onClick={handleRestartServer}
                    disabled={!projectId || isRestartingServer}
                  >
                    {isRestartingServer ? <Loader2 className="animate-spin" /> : <CirclePower />}
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom"><p className="text-xs">重启开发服务器（清理缓存）</p></TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-2xs text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
                    title="Configure site metadata: favicon, title, description, SEO keywords"
                  >
                    <Settings2 className="w-3 h-3" />
                    <span>Meta</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom"><p className="text-xs">站点元信息（favicon / 标题 / 描述）</p></TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <form
              onSubmit={handleUrlChange}
              className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-inset px-1.5"
            >
              <Globe className="size-3.5 shrink-0 text-text-tertiary" />
              <Input
                type="text"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                className="h-full min-w-0 flex-1 border-0 bg-transparent px-0.5 font-mono text-2xs text-text-secondary shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
                placeholder="输入 URL 或路径，回车访问"
                aria-label="地址栏"
              />
              {/* 静态 / 实时 / 外站 状态标签（只读指示器） */}
              {currentUrl && (
                <span
                  className={cn(
                    "shrink-0 cursor-default rounded-sm px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide",
                    previewKind === "static" && "bg-info-subtle text-info-fg",
                    previewKind === "live" && "bg-success-subtle text-success-fg",
                    previewKind === "external" && "bg-warning-subtle text-warning-fg",
                  )}
                  title={proxied ? currentUrl + "（经同源代理）" : currentUrl}
                >
                  {previewKind === "static" ? "静态" : previewKind === "live" ? "实时" : "外站"}
                </span>
              )}
              {/* 版本显示 - 点击展开版本列表 */}
              {latestVersion ? (
                <Popover open={showVersionPopover} onOpenChange={setShowVersionPopover}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-2xs font-medium transition-colors duration-fast",
                        historyVersion && historyVersion < latestVersion
                          ? "bg-warning-subtle text-warning-fg hover:bg-warning-subtle/70"
                          : "text-text-secondary hover:bg-surface-hover"
                      )}
                      title="点击查看版本历史"
                    >
                      {historyVersion && historyVersion < latestVersion ? (
                        <>
                          <History className="w-3 h-3" />
                          <span>历史 v{historyVersion}</span>
                        </>
                      ) : (
                        <span>v{latestVersion}</span>
                      )}
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-0" align="end">
                    <div className="p-3 border-b">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">版本历史</span>
                        {historyVersion && historyVersion < latestVersion && (
                          <button
                            onClick={() => {
                              if (isGenerating || isSwitchingVersion || externalSwitching) return;
                              onBackToLatest?.();
                              setShowVersionPopover(false);
                            }}
                            disabled={isGenerating || isSwitchingVersion || externalSwitching}
                            className={cn("text-xs text-primary hover:underline", (isGenerating || isSwitchingVersion || externalSwitching) && "opacity-50 cursor-not-allowed")}
                          >
                            {(isSwitchingVersion || externalSwitching) ? "切换中..." : "回到最新"}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="relative h-[300px]">
                      {/* 版本切换 loading 遮罩 */}
                      {(isSwitchingVersion || externalSwitching) && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
                          <div className="flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                            <span className="text-xs text-muted-foreground">正在切换版本...</span>
                          </div>
                        </div>
                      )}
                      <ScrollArea className="h-full">
                      {isLoadingVersions ? (
                        <div className="flex items-center justify-center py-8">
                          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                        </div>
                      ) : versions.length === 0 ? (
                        <div className="text-center py-8 text-sm text-muted-foreground">
                          暂无版本记录
                        </div>
                      ) : (
                        <div className="py-1">
                          {versions.map((version) => {
                            const isCurrentView = historyVersion 
                              ? version.version_number === historyVersion
                              : version.version_number === latestVersion;
                            const isLatest = version.version_number === latestVersion;
                            const isDisabled = isSwitchingVersion || externalSwitching || !version.commit_hash || isGenerating;
                            
                            return (
                              <button
                                key={version.version_number}
                                onClick={() => handleVersionSelect(version)}
                                disabled={isDisabled}
                                className={cn(
                                  "w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors",
                                  isCurrentView && "bg-muted/30",
                                  version.skipped && "opacity-50",
                                  isDisabled && "cursor-not-allowed opacity-50"
                                )}
                              >
                                <div className="flex items-start gap-2">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className={cn("text-sm font-medium", isCurrentView && "text-primary")}>
                                        版本 {version.version_number}
                                      </span>
                                      {isLatest && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                                          最新
                                        </span>
                                      )}
                                      {version.skipped && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                          已跳过
                                        </span>
                                      )}
                                    </div>
                                    {version.summary && (
                                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                        {version.summary}
                                      </p>
                                    )}
                                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                                      {version.timestamp}
                                    </p>
                                  </div>
                                  {isCurrentView && (
                                    <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </ScrollArea>
                    </div>
                  </PopoverContent>
                </Popover>
              ) : null}
            </form>
          </div>

          {/* 地址栏错误提示（非法输入 / 不支持的协议）—— 明确说出来，不静默变空白 */}
          {addressError && (
            <div className="mx-2 mb-1 flex items-start gap-1.5 rounded-md bg-danger-subtle px-2 py-1 text-2xs text-danger-fg">
              <TriangleAlert className="mt-px size-3 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{addressError}</span>
            </div>
          )}

          {/* iframe 预览区域 */}
          <div className="relative min-h-0 flex-1 overflow-hidden bg-surface-inset">
            {/* 服务器启动提示 Toast + 遮罩 */}
            {isStartingServer && (
              <>
                <div className="absolute inset-0 z-10 bg-surface-scrim/40" />
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 animate-slide-down">
                  <div className="flex items-center gap-2 rounded-sm border border-border-default bg-surface-overlay px-3 py-2 shadow-lg">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    <span className="text-sm font-medium">正在启动开发服务器...</span>
                  </div>
                </div>
              </>
            )}
            
            {/* 切换缓存提示 Toast + 遮罩 */}
            {isSwitchingToCache && (
              <>
                <div className="absolute inset-0 z-10 bg-surface-scrim/40" />
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 animate-slide-down">
                  <div className="flex items-center gap-2 rounded-sm border border-border-default bg-surface-overlay px-3 py-2 shadow-lg">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    <span className="text-sm font-medium">正在切换到静态缓存...</span>
                  </div>
                </div>
              </>
            )}
            
            {/* 刷新静态预览提示 Toast + 遮罩 */}
            {isRefreshingPreview && (
              <>
                <div className="absolute inset-0 z-10 bg-surface-scrim/40" />
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 animate-slide-down">
                  <div className="flex items-center gap-2 rounded-sm border border-border-default bg-surface-overlay px-3 py-2 shadow-lg">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    <span className="text-sm font-medium">正在刷新预览...</span>
                  </div>
                </div>
              </>
            )}

            {currentUrl && proxyError ? (
              /* 外站打不开：把代理给的结构化原因直接显示出来（而不是白屏） */
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <TriangleAlert className="size-6 text-danger" />
                <p className="text-sm font-medium text-text-primary">打不开这个页面</p>
                <p className="max-w-full break-words text-xs leading-relaxed text-text-tertiary">{proxyError}</p>
                <p className="max-w-full break-all font-mono text-2xs text-text-disabled">{currentUrl}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setProxyError(null); setFrameNonce((n) => n + 1); }}>重试</Button>
                  <Button size="sm" variant="ghost" onClick={() => { manualNavRef.current = false; pinnedFileRef.current = false; setProxyError(null); setCurrentUrl(""); setInputUrl(""); }}>清空</Button>
                </div>
              </div>
            ) : currentUrl ? (
              <iframe
                ref={iframeRef as React.LegacyRef<HTMLIFrameElement>}
                src={frameSrc}
                className="w-full h-full border-0"
                title="Preview"
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6">
                <EmptyState
                  icon={<Globe />}
                  title="随时可以浏览"
                  description="在地址栏输入 URL 浏览，或运行此项目的开发服务器"
                  action={
                    <Button
                      size="sm"
                      onClick={handleStartDevServer}
                      disabled={!projectId || !onStartDevServer || isStartingServer}
                      title={projectId ? "启动开发服务器" : "请先选择或新建任务"}
                    >
                      {isStartingServer ? <Loader2 className="animate-spin" /> : <Play />}
                      运行开发服务器
                    </Button>
                  }
                />
              </div>
            )}
          </div>
        </div>

        {/* ---------------- 文件 ---------------- */}
        <div className={cn("min-h-0 flex-1", tab === "files" ? "flex" : "hidden")}>
          <PreviewFilesPane
            port={projectId ?? null}
            devServerPort={devServerPort}
            className="flex-1"
          />
        </div>

        {/* ---------------- 日志 ---------------- */}
        <div className={cn("min-h-0 flex-1", tab === "log" ? "flex" : "hidden")}>
          <SessionLogView port={projectId ?? null} className="flex-1" />
        </div>
      </div>
    </div>
  );
}
