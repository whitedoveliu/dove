"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { readDraftPermission, readDraftPlanMode, writeDraftPlanMode, type PermissionMode } from "@/lib/permission";
import { readDraftGoal, clearDraftGoal } from "@/lib/goal";
import PreviewPanel from "@/components/PreviewPanel";
import ChatPanel from "@/components/ChatPanel";
import { useDevToolsBridge } from "@/hooks/useDevToolsBridge";
import { AppShell } from "@/components/shell/app-shell";
import { ProjectSidebar } from "@/components/shell/project-sidebar";
import { FilePeek } from "@/components/shell/file-peek";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  switchToLatest,
  checkProjectExists,
  setPreviewVersion,
  startProjectServer,
  stopProjectServer,
  stopProjectServerBeacon,
  getVersionList,
  getProjects,
  createTask,
  deleteProject,
  setPermissionMode,
  setPlanMode,
  postGoal,
  attachFolder,
  chooseFolder,
  checkHealth,
  getProjectInfo,
  type Project,
} from "@/lib/api";
import { normalizeProjectPath } from "@/lib/presented-files";

// 获取 API 主机地址（支持局域网访问）
const getApiHost = () => typeof window !== "undefined" ? window.location.hostname : "localhost";

function ControlPanel() {
  // 项目选择状态
  const [projectId, setProjectId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [devServerPort, setDevServerPort] = useState<string | null>(null);
  
  const [historyVersion, setHistoryVersion] = useState<number | null>(null);
  const [latestVersion, setLatestVersion] = useState<number>(0);
  const [isGenerating, setIsGenerating] = useState(false);
  
  // 开发服务器状态
  const [isDevServerReady, setIsDevServerReady] = useState(false);
  const [isStartingServer, setIsStartingServer] = useState(false);
  const [isSwitchingToCache, setIsSwitchingToCache] = useState(false);  // 正在切换到缓存
  const [isRefreshingPreview, setIsRefreshingPreview] = useState(false);  // 正在刷新静态预览
  
  // 热更新固定开启：dev server 常驻，旧版的开关已移除
  const enableHotReload = true;
  
  // Build 错误状态（用于在 ChatPanel 显示）
  const [buildError, setBuildError] = useState<string | null>(null);
  
  // 运行时错误状态
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  
  // 版本切换状态（统一管理）
  const [isSwitchingVersion, setIsSwitchingVersion] = useState(false);
  
  // 文件修改中状态（用于提前展示预览面板）
  const [isFileModifying, setIsFileModifying] = useState(false);
  

  // ==================== 目录面板（左侧项目树）====================
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [asideCollapsed, setAsideCollapsed] = useState(false);
  const [health, setHealth] = useState<"unknown" | "online" | "offline">("unknown");
  const [activeFile, setActiveFile] = useState<{ port: string; path: string } | null>(null);
  const { toast } = useToast();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  
  // 空闲计时器（用于自动关闭服务器）
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 分钟
  
  /**
   * 打开项目内文件预览（消息流里的交付物卡片 / 正文里的文件路径）。
   *
   * 复用目录面板那条链：setActiveFile → 右侧 FilePeek → readProjectFile(port, path)。
   * 那条链只认**项目内相对路径**（后端是 join(项目根, path)），所以这里做两件事：
   *   · 字符串归一化（反斜杠转正斜杠、去掉 "./" 前缀）
   *   · 万一是绝对路径，按项目根裁成相对路径；拿不到项目根就原样试，
   *     FilePeek 会显示「文件不存在」，不会静默失败
   */
  const handleOpenProjectFile = useCallback(async (path: string) => {
    const port = projectId;
    if (!port) return;
    setAsideCollapsed(false);   // 预览区收起了就先展开，否则点了什么都看不到
    let target = normalizeProjectPath(path);
    if (target.startsWith("/")) {
      try {
        const info = await getProjectInfo(port);
        const root = String(info.react_app_path ?? "").replace(/\/+$/, "");
        if (root && target.startsWith(root + "/")) target = target.slice(root.length + 1);
      } catch {
        /* 拿不到项目根：按原样试，让 FilePeek 报错 */
      }
    }
    setActiveFile({ port, path: target });
  }, [projectId]);

  // 处理运行时错误的回调
  const handleRuntimeError = useCallback((error: { message: string; source?: string; lineno?: number; stack?: string }) => {
    // 格式化错误信息
    const errorMessage = error.stack 
      ? `${error.message}\n\n${error.source ? `Source: ${error.source}:${error.lineno}` : ''}\n\nStack:\n${error.stack}`
      : `${error.message}${error.source ? `\n\nSource: ${error.source}:${error.lineno}` : ''}`;
    setRuntimeError(errorMessage);
  }, []);

  const buildStaticPreviewUrl = useCallback((port: string, version?: number | null, bustCache = false) => {
    const baseUrl = version && version > 0
      ? `http://${getApiHost()}:8008/preview/${port}/?version=${version}`
      : `http://${getApiHost()}:8008/preview/${port}/`;
    return bustCache ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}_t=${Date.now()}` : baseUrl;
  }, []);

  const buildHotPreviewUrl = useCallback((projectPort: string, actualPort?: string | null) => {
    return `http://${getApiHost()}:${actualPort || projectPort}/`;
  }, []);
  
  // 判断当前是否使用服务器预览（热更新 URL）
  const isUsingDevServer = useCallback(() => {
    if (!projectId || !previewUrl || !enableHotReload) return false;
    try {
      const url = new URL(previewUrl);
      return url.port !== "8008";
    } catch {
      return false;
    }
  }, [projectId, previewUrl, enableHotReload]);
  
  // 空闲超时处理：切换到 build 缓存并关闭服务器
  const handleIdleTimeout = useCallback(async () => {
    // 只有在使用服务器预览时才处理
    if (!isUsingDevServer() || !projectId) {
      return;
    }
    
    // 显示切换提示
    setIsSwitchingToCache(true);
    
    try {
      // 1. 设置预览版本为最新版本
      if (latestVersion > 0) {
        await setPreviewVersion(projectId, latestVersion);
      }
      
      // 2. 切换 URL 到静态预览（带版本号，避免缓存问题）
      const staticUrl = latestVersion > 0 
        ? buildStaticPreviewUrl(projectId, latestVersion)
        : buildStaticPreviewUrl(projectId);
      setPreviewUrl(staticUrl);
      setDevServerPort(null);
      console.log(`📦 已切换到静态预览: ${staticUrl}`);
      
      // 3. 关闭开发服务器
      await stopProjectServer(projectId);
      setIsDevServerReady(false);
      setDevServerPort(null);
      console.log('🛑 开发服务器已关闭');
      
      // 延迟隐藏提示，让用户能看到
      setTimeout(() => {
        setIsSwitchingToCache(false);
      }, 1500);
    } catch (error) {
      console.error('空闲切换失败:', error);
      setIsSwitchingToCache(false);
    }
  }, [projectId, latestVersion, isUsingDevServer, buildStaticPreviewUrl]);
  
  // 重置空闲计时器
  const resetIdleTimer = useCallback(() => {
    // 清除现有计时器
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    
    // 只有在使用服务器预览时才启动计时器
    if (isUsingDevServer()) {
      idleTimerRef.current = setTimeout(handleIdleTimeout, IDLE_TIMEOUT);
    }
  }, [isUsingDevServer, handleIdleTimeout]);
  
  // 监听用户活动，重置空闲计时器
  useEffect(() => {
    const handleActivity = () => {
      resetIdleTimer();
    };
    
    // 监听各种用户活动事件
    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('mousedown', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('scroll', handleActivity, true);
    window.addEventListener('touchstart', handleActivity);
    
    // 初始启动计时器
    resetIdleTimer();
    
    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('mousedown', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('scroll', handleActivity, true);
      window.removeEventListener('touchstart', handleActivity);
      
      // 清理计时器
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
    };
  }, [resetIdleTimer]);
  
  // 当 previewUrl 变化时，重新评估是否需要计时
  useEffect(() => {
    resetIdleTimer();
  }, [previewUrl, resetIdleTimer]);
  
  // 页面关闭/刷新时自动关闭服务器
  useEffect(() => {
    const handleBeforeUnload = () => {
      // 使用 sendBeacon 确保请求能在页面关闭时发送成功
      // 只有开启热更新时才需要关闭服务器
      if (projectId && isDevServerReady && enableHotReload) {
        stopProjectServerBeacon(projectId);
        console.log(`🛑 页面关闭，服务器 ${projectId} 已发送关闭请求`);
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [projectId, isDevServerReady, enableHotReload]);
  
  // 开始构建回调（静态模式下显示 loading）
  const handleBuildStart = useCallback(() => {
    // 热更常开：构建交给 dev server，静态模式那套 loading 已不需要
  }, []);
  
  // 预览构建完成回调：热更模式下只需清理 loading
  const handlePreviewReady = useCallback(async (_newVersion: number) => {
    setIsRefreshingPreview(false);
  }, []);
  
  // iframe 用户活动回调（用于重置空闲计时器）
  const handleIframeUserActivity = useCallback(() => {
    resetIdleTimer();
  }, [resetIdleTimer]);
  
  // DevTools Bridge - 与 iframe 通信
  const devToolsBridge = useDevToolsBridge(iframeRef, handleRuntimeError, handleIframeUserActivity);

  // 刷新 iframe 预览
  const refreshPreview = () => {
    if (iframeRef.current) {
      const currentSrc = iframeRef.current.src;
      // 移除旧的 _refresh 参数，添加新的
      const baseUrl = currentSrc.split('?')[0];
      const params = new URLSearchParams(currentSrc.split('?')[1] || '');
      params.delete('_refresh');
      params.set('_refresh', String(Date.now()));
      iframeRef.current.src = `${baseUrl}?${params.toString()}`;
      console.log(`🔄 预览已刷新`);
    }
  };

  // 检查是否有保存的项目
  useEffect(() => {
    const initProject = async () => {
      // 支持 ?project=<端口> 深链，便于分享与调试
      const urlProject = new URLSearchParams(window.location.search).get("project");
      const savedPort = urlProject || localStorage.getItem("dove_port");
      if (savedPort) {
        try {
          // 检查项目是否存在以及服务器是否运行
          const { exists, running, actual_port } = await checkProjectExists(savedPort);
          
          if (exists) {
            setProjectId(savedPort);
            setIsDevServerReady(running);
            setDevServerPort(running ? (actual_port || savedPort) : null);
            
            // 获取最新版本号
            try {
              const versionResult = await getVersionList(savedPort, 1);
              if (versionResult.success && versionResult.versions.length > 0) {
                const latestVer = versionResult.versions[0].version_number;
                setLatestVersion(latestVer);
                
                // 如果服务器已运行，使用热更新 URL；否则使用带版本号的静态 URL
                if (running) {
                  // 服务器运行时，清除预览版本设置，使用热更新
                  await setPreviewVersion(savedPort, null);
                  setPreviewUrl(buildHotPreviewUrl(savedPort, actual_port || savedPort));
                  console.log(`📦 项目 ${savedPort} 初始化，使用热更新预览（服务器已运行）`);
                } else {
                  // 服务器未运行时，使用带版本号的静态 URL
                  // 注意：必须在URL中带version参数，因为后端多worker模式下内存状态不共享
                  setPreviewUrl(buildStaticPreviewUrl(savedPort, latestVer));
                  console.log(`📦 项目 ${savedPort} 初始化，使用静态预览 v${latestVer}（服务器未运行）`);
                }
              } else {
                // 没有版本，显示空白提示
                setPreviewUrl("");
                console.log(`📦 项目 ${savedPort} 初始化，暂无版本`);
              }
            } catch (error) {
              console.error("获取版本列表失败:", error);
              // 回退到无版本的静态 URL
              setPreviewUrl(buildStaticPreviewUrl(savedPort));
            }
          } else {
            // 项目不存在，清除保存的端口
            localStorage.removeItem("dove_port");
          }
        } catch (error) {
          console.error("初始化项目失败:", error);
        }
      }
    };
    
    initProject();
  }, [buildHotPreviewUrl, buildStaticPreviewUrl]);

  // 选择项目
  const handleProjectSelect = async (port: string) => {
    // 切换项目前，先关闭当前项目的服务器（仅热更新模式）
    if (projectId && projectId !== port && isDevServerReady && enableHotReload) {
      try {
        await stopProjectServer(projectId);
        console.log(`🛑 切换项目，已关闭旧服务器 ${projectId}`);
      } catch (error) {
        console.error("关闭旧服务器失败:", error);
      }
    }
    
    setProjectId(port);
    setIsDevServerReady(false);  // 重置服务器状态
    setDevServerPort(null);
    localStorage.setItem("dove_port", port);
    
    // 检查服务器状态
    try {
      const { running, actual_port } = await checkProjectExists(port);
      setIsDevServerReady(running);
      setDevServerPort(running ? (actual_port || port) : null);
      
      // 获取最新版本号
      try {
        const versionResult = await getVersionList(port, 1);
        if (versionResult.success && versionResult.versions.length > 0) {
          const latestVer = versionResult.versions[0].version_number;
          setLatestVersion(latestVer);
          
          // 如果服务器已运行，使用热更新 URL；否则使用带版本号的静态 URL
          if (running) {
            setPreviewUrl(buildHotPreviewUrl(port, actual_port || port));
            console.log(`📦 项目 ${port} 选择，使用热更新预览（服务器已运行）`);
          } else {
            setPreviewUrl(buildStaticPreviewUrl(port, latestVer));
            console.log(`📦 项目 ${port} 选择，使用静态预览 v${latestVer}（服务器未运行）`);
          }
        } else {
          // 没有版本，显示空白提示
          setPreviewUrl("");
          console.log(`📦 项目 ${port} 选择，暂无版本`);
        }
      } catch (error) {
        console.error("获取版本列表失败:", error);
        setPreviewUrl(buildStaticPreviewUrl(port));
      }
    } catch (error) {
      console.error("检查服务器状态失败:", error);
      setPreviewUrl(buildStaticPreviewUrl(port));
    }
  };


  // 启动开发服务器（用于发送消息时）
  const handleStartDevServer = useCallback(async () => {
    // 热更新关闭时不启动服务器
    if (!projectId || isDevServerReady || isStartingServer || !enableHotReload) return;
    
    setIsStartingServer(true);
    console.log(`🚀 正在启动开发服务器 ${projectId}...`);
    
    try {
      const result = await startProjectServer(projectId);
      const hintedPort = result.actual_port || null;
      console.log(`✅ 开发服务器 ${projectId} 启动命令已发送${hintedPort ? `，实际端口: ${hintedPort}` : ""}`);
      
      // 等待服务器完全启动后再切换 URL 和隐藏 toast
      setTimeout(async () => {
        try {
          const status = await checkProjectExists(projectId);
          if (status.running) {
            const actualPort = status.actual_port || hintedPort || projectId;
            setIsDevServerReady(true);
            setDevServerPort(actualPort);
            // 只有在查看最新版本时才切换到热更新 URL
            if (historyVersion === null || historyVersion === latestVersion) {
              setPreviewUrl(buildHotPreviewUrl(projectId, actualPort));
              console.log(`🔄 已切换到热更新预览`);
            }
          } else {
            setIsDevServerReady(false);
            setDevServerPort(null);
            console.warn(`⚠️ 开发服务器 ${projectId} 启动后仍未就绪`);
          }
        } catch (statusError) {
          console.error("检查开发服务器状态失败:", statusError);
          setIsDevServerReady(false);
          setDevServerPort(null);
        } finally {
          setIsStartingServer(false);
        }
      }, 3000); // 等待 3 秒让服务器完全启动
    } catch (error) {
      console.error("启动服务器失败:", error);
      setIsStartingServer(false);
    }
  }, [projectId, isDevServerReady, isStartingServer, historyVersion, latestVersion, enableHotReload, buildHotPreviewUrl]);

  // 切回最新版本
  const handleBackToLatest = async () => {
    if (!projectId) return;
    
    setIsSwitchingVersion(true);
    try {
      // 清除预览版本设置
      await setPreviewVersion(projectId, null);
      await switchToLatest(projectId);
      setHistoryVersion(null);
      // 清除构建错误（最新版本应该是正常的）
      setBuildError(null);
      // 根据服务器状态决定使用哪个 URL
      if (isDevServerReady) {
        setPreviewUrl(buildHotPreviewUrl(projectId, devServerPort));
      } else if (latestVersion > 0) {
        // 服务器未运行时，使用带版本号的静态 URL
        // 注意：必须在URL中带version参数，因为后端多worker模式下内存状态不共享
        setPreviewUrl(buildStaticPreviewUrl(projectId, latestVersion));
      } else {
        setPreviewUrl("");
      }
    } catch (error) {
      console.error("切回最新版本失败:", error);
    } finally {
      setIsSwitchingVersion(false);
    }
  };
  
  // 处理版本变化（来自 PreviewPanel 或 ChatPanel）
  const handleVersionChange = (version: number | null) => {
    const previousHistoryVersion = historyVersion;
    setHistoryVersion(version);
    // 切换版本时清除运行时错误
    setRuntimeError(null);
    
    if (!projectId) return;
    
    // 根据版本决定使用哪个 URL
    if (version === null || version === latestVersion) {
      // 切到最新版本
      if (isDevServerReady && enableHotReload) {
        // 热更新开启且服务器运行时，使用热更新 URL
        setPreviewUrl(buildHotPreviewUrl(projectId, devServerPort));
      } else if (previousHistoryVersion !== null && previousHistoryVersion !== latestVersion && latestVersion > 0) {
        // 从历史版本切回最新版本（静态模式），需要更新 URL
        setPreviewUrl(buildStaticPreviewUrl(projectId, latestVersion, true));
      }
      // 如果之前就在最新版本（previousHistoryVersion === null），不改变 URL
      // 这样发消息时不会触发刷新导致白屏
    } else {
      // 切换到历史版本：使用静态缓存 URL（用户主动切换历史版本时）
      setPreviewUrl(buildStaticPreviewUrl(projectId, version, true));
    }
  };

  // ==================== 目录面板交互 ====================

  // 加载项目列表 + 后端健康状态
  const loadProjects = useCallback(async (silent = false) => {
    if (!silent) setProjectsLoading(true);
    try {
      const [list, healthResult] = await Promise.all([
        getProjects(),
        checkHealth().catch(() => null),
      ]);
      setProjects(list.projects ?? []);
      setHealth(healthResult ? "online" : "offline");
    } catch (error) {
      console.error("加载项目列表失败:", error);
      setHealth("offline");
    } finally {
      if (!silent) setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    const timer = window.setInterval(() => void loadProjects(true), 15000);
    return () => window.clearInterval(timer);
  }, [loadProjects]);

  // Cmd/Ctrl + B 折叠目录面板
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 切到新任务时按"有没有产出"给个初始态；之后完全听用户的，不再自动改
  useEffect(() => {
    setAsideCollapsed(latestVersion === 0 && !isDevServerReady);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 新建任务：只给名字（+ 可选项目），端口由后端分配，目录名即任务名
  /**
   * 彻底删除任务：项目目录（含 git 版本历史）+ 数据库记录。
   *
   * ⚠️ 不可恢复，所以确认框必须**把后果写全** ——
   * 只说「删除」用户不知道文件会不会没，说清「代码和版本历史一起删」
   * 他才能判断要不要先备份。
   *
   * 后端另有一道保护：路径不在工作区内时只清数据库、不碰文件
   * （见 legacy/routes-project.ts 的 safe 判断）。
   */
  const handleDeleteProject = async (port: string) => {
    const target = projects.find((p) => p.port === port);
    const name = (target?.title || target?.project || target?.path || port).trim();
    const ok = window.confirm(
      `彻底删除「${name}」？\n\n` +
      `会删掉：\n` +
      `  · 项目文件 ${target?.path ?? ""}\n` +
      `  · 版本历史（git）\n` +
      `  · 该任务的对话记录\n\n` +
      `⚠️ 不可恢复。要留就先备份。`
    );
    if (!ok) return;
    try {
      // ⚠️ 用 id 而不是 port —— 导入/接入的项目 port 是 "0"，用它必然 404
      const r = await deleteProject(target?.id ?? port);
      toast({
        title: r.message || "已删除",
        description: r.warning,
        tone: r.warning ? "warning" : "success",
      });
      // 删完之后**重新拉一次列表，再确认当前选中的项目还在不在** ——
      // 不要只比 `projectId === port`：port 是字符串（导入的项目是 "0"），
      // 而且删的未必是当前打开的那个，比对容易漏。
      // 漏了的后果就是：界面停在一个已经删掉的项目上，再发消息又"回到"它。
      await loadProjects();
      try {
        const { projects: fresh } = await getProjects();
        if (projectId && !fresh.some((p) => p.port === projectId)) {
          setProjectId(null);
          // ⚠️ localStorage 也要清 —— App 启动时会从它恢复选中项目（App.tsx 的 savedPort）。
          //    不清的话下次打开又指向这个已经不存在的端口。
          localStorage.removeItem("dove_port");
        }
      } catch { /* 拉不到就保守不动 */ }
    } catch (e) {
      toast({ title: "删除失败", description: String(e), tone: "danger" });
    }
  };

  /**
   * 建项目。可选 `permission`：建好后**在选中它之前**把权限落库。
   *
   * ⚠️ 顺序很关键：ChatPanel 的 usePermissionMode 在 projectId 变化时会**立刻读一次**。
   *    如果先 handleProjectSelect 再写权限，那次读到的还是旧值（workspace），
   *    而写完又不会再读 —— 表现出来就是「新会话选了完全访问，进去还是工作区」。
   *    实测踩过。
   */
  const handleCreateProject = async (input: { name: string; project?: string; permission?: PermissionMode }) => {
    try {
      const result = await createTask(input);
      if (!result.success) throw new Error(result.message);
      const port = result.project?.port;
      toast({
        title: `已创建任务「${result.project?.name ?? input.name}」`,
        description: result.project?.path,
        tone: "success",
      });
      // 先落权限，再选中 —— 见上面注释
      if (port && input.permission) {
        try { await setPermissionMode(port, input.permission); }
        catch { /* 设不上也得继续，别把建项目本身搞挂 */ }
      }
      // 新会话页选的「计划模式」草稿同样在这里落地：**必须赶在第一条消息之前**，
      // 否则第一轮就不是硬只读了（内核每轮开始才读线程 metadata）。
      if (port && readDraftPlanMode()) {
        try {
          await setPlanMode(port, true);
          writeDraftPlanMode(false);   // 用完即清，别让下一个新任务莫名其妙又是计划模式
        } catch { /* 设不上不影响建项目 */ }
      }
      // 新会话页写的「长期目标」草稿也在这里落地 —— 目标在内核里是线程级的，
      // 所以只能等任务建好再写；同样要赶在第一条消息之前，第一轮就知道自己有目标。
      const draftGoal = readDraftGoal();
      if (port && draftGoal) {
        try {
          await postGoal(port, { action: "create", objective: draftGoal });
          clearDraftGoal();
        } catch { /* 目标没设上不能挡住建任务 */ }
      }
      await loadProjects(true);
      if (port) {
        await handleProjectSelect(port);
        setAsideCollapsed(true);   // 新任务先不看预览
      }
      return port;
    } catch (error) {
      toast({
        title: "创建任务失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
      return undefined;
    }
  };

  // 空状态里直接说话即可开工：用首行截断当任务名，建好后自动把原话发出去
  const handleQuickCreateTask = async (text: string) => {
    const firstLine = text.trim().split("\n")[0].trim();
    const name = firstLine.slice(0, 24) || "新任务";
    // 新会话页选的权限，连同建项目一起交下去 —— 由 handleCreateProject
    // 保证「先落权限、再选中项目」的顺序（见那边的注释）。
    await handleCreateProject({
      name,
      project: draftProject ?? undefined,
      permission: readDraftPermission(),
    });
    setPendingMessage(text);
  };

  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  // 起始页上预选的项目（不弹窗也能把新会话挂到某个项目下）
  const [draftProject, setDraftProject] = useState<string | null>(null);

  // 点「新会话」：不弹窗，直接回到聊天主界面
  const handleStartNewSession = () => {
    setProjectId(null);
    localStorage.removeItem("dove_port");
    setPreviewUrl("");
    setLatestVersion(0);
    setIsDevServerReady(false);
    setActiveFile(null);
    setAsideCollapsed(true);
    setDraftProject(null);
    setPendingMessage(null);
  };

  // 在某个项目下新建会话：进主界面 + 预选该项目
  const handleNewSessionInProject = (project: string) => {
    handleStartNewSession();
    setDraftProject(project);
  };

  // 接入本地已有文件夹（Codex 的 open folder）：先唤起系统选择框
  const handleChooseAndAttach = async () => {
    try {
      const picked = await chooseFolder();
      if (!picked.success || !picked.path) return;   // 用户取消就什么都不做
      const result = await attachFolder({ path: picked.path });
      toast({ title: result.message, description: result.project?.path, tone: "success" });
      await loadProjects(true);
      if (result.project?.port) await handleProjectSelect(result.project.port);
    } catch (error) {
      toast({
        title: "接入文件夹失败",
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    }
  };

  // 目录树中的服务器操作（可作用于任意项目）
  const handleStartServerFor = async (port: string) => {
    try {
      const result = await startProjectServer(port);
      toast({
        title: `项目 ${port} 正在启动开发服务器`,
        description: result.actual_port ? `实际端口 ${result.actual_port}` : undefined,
        tone: "info",
      });
      window.setTimeout(() => void loadProjects(true), 3000);
    } catch (error) {
      toast({ title: "启动服务器失败", description: String(error), tone: "danger" });
    }
  };

  const handleStopServerFor = async (port: string) => {
    try {
      await stopProjectServer(port);
      if (port === projectId) {
        setIsDevServerReady(false);
        setDevServerPort(null);
        if (latestVersion > 0) setPreviewUrl(buildStaticPreviewUrl(port, latestVersion, true));
      }
      toast({ title: `项目 ${port} 服务器已停止`, tone: "default" });
      window.setTimeout(() => void loadProjects(true), 1500);
    } catch (error) {
      toast({ title: "停止服务器失败", description: String(error), tone: "danger" });
    }
  };

  return (
    <AppShell
      asideCollapsed={asideCollapsed}
      sidebarCollapsed={sidebarCollapsed}
      onSidebarCollapsedChange={setSidebarCollapsed}
      sidebar={
        <ProjectSidebar
          projects={projects}
          loading={projectsLoading}
          activePort={projectId}
          collapsed={sidebarCollapsed}
          health={health}
          activeFile={activeFile?.port === projectId ? activeFile.path : null}
          onCollapsedChange={setSidebarCollapsed}
          onSelectProject={handleProjectSelect}
          onCreateProject={(input) => void handleCreateProject(input)}
          onNewSession={handleStartNewSession}
          onNewSessionInProject={handleNewSessionInProject}
          onRefreshProjects={() => void loadProjects()}
          onStartServer={handleStartServerFor}
          onStopServer={handleStopServerFor}
          onDeleteProject={handleDeleteProject}
          onSelectFile={(port, entry) => {
            setActiveFile({ port, path: entry.path });
            if (port !== projectId) void handleProjectSelect(port);
          }}
        />
      }
      main={
        <div className="pane flex-1">
          <ChatPanel
            devToolsBridge={devToolsBridge}
            onVersionChange={handleVersionChange}
            onLatestVersionChange={setLatestVersion}
            latestVersion={latestVersion}
            projectId={projectId}
            onProjectSelect={handleProjectSelect}
            onRefreshPreview={refreshPreview}
            onLoadingChange={setIsGenerating}
            onStartDevServer={handleStartDevServer}
            externalBuildError={buildError}
            onClearBuildError={() => setBuildError(null)}
            externalRuntimeError={runtimeError}
            onClearRuntimeError={() => setRuntimeError(null)}
            onSwitchingVersionChange={setIsSwitchingVersion}
            onPreviewReady={handlePreviewReady}
            onBuildStart={handleBuildStart}
            enableHotReload={enableHotReload}
            onFileModifying={setIsFileModifying}
            onOpenFile={(path) => void handleOpenProjectFile(path)}
            onProjectCreated={() => void loadProjects(true)}
            onQuickCreateTask={(text) => void handleQuickCreateTask(text)}
            projects={projects}
            draftProject={draftProject}
            onDraftProjectChange={setDraftProject}
            onChooseFolder={() => void handleChooseAndAttach()}
            pendingMessage={pendingMessage}
            asideCollapsed={asideCollapsed}
            onToggleAside={() => setAsideCollapsed((prev) => !prev)}
            onPendingMessageConsumed={() => setPendingMessage(null)}
          />
        </div>
      }
      aside={
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="pane flex-1">
            <PreviewPanel
              url={previewUrl}
              iframeRef={iframeRef}
              historyVersion={historyVersion}
              latestVersion={latestVersion}
              onBackToLatest={handleBackToLatest}
              projectId={projectId}
              onProjectSelect={handleProjectSelect}
              onVersionChange={handleVersionChange}
              onRefreshPreview={refreshPreview}
              isGenerating={isGenerating}
              isStartingServer={isStartingServer}
              isSwitchingToCache={isSwitchingToCache}
              isRefreshingPreview={isRefreshingPreview}
              onBuildError={setBuildError}
              isSwitchingVersion={isSwitchingVersion}
              onSwitchingVersionChange={setIsSwitchingVersion}
              devServerPort={devServerPort}
              onDevServerPortChange={setDevServerPort}
              onStartDevServer={handleStartDevServer}
              asideCollapsed={asideCollapsed}
              onToggleAside={() => setAsideCollapsed((prev) => !prev)}
            />
          </div>

          {activeFile && (
            <FilePeek
              port={activeFile.port}
              path={activeFile.path}
              onClose={() => setActiveFile(null)}
            />
          )}
        </div>
      }
    />
  );
}

export default function Home() {
  return (
    <TooltipProvider delayDuration={260} skipDelayDuration={400}>
      <ToastProvider>
        <ControlPanel />
      </ToastProvider>
    </TooltipProvider>
  );
}
