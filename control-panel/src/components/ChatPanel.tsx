"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Send, Loader2, StopCircle, Settings2, Check, DollarSign, Paperclip, X, FileIcon, Plus, Play, Download, VolumeX, Pause, Square, RotateCcw, AlertTriangle, Trash2, Search, PanelRightOpen, PanelRight, FolderOpen, ChevronDown, HardDrive, ArrowUp, Shield, ShieldOff, Eye, ClipboardList, XCircle, Target } from "lucide-react";
import { Hint } from "@/components/ui/tooltip";
import { IconButton } from "@/components/ui/icon-button";
import { loadSavedStyle } from "./AIStyleSelector";
import MessageList from "./MessageList";
import { SubagentBar, reduceSubagents, type SubagentInfo } from "./subagent-bar";
import { SubagentView } from "./subagent-view";
import { ComposerBox, PermissionSelect } from "./composer-box";
import { GoalBar } from "./goal-bar";
import { usePermissionMode, usePlanMode, readDraftPlanMode, writeDraftPlanMode } from "@/lib/permission";
import { useGoal, readDraftGoal, writeDraftGoal, clearDraftGoal } from "@/lib/goal";
import { goalPhaseLabel, goalSummary, parseGoalCommand, truncateGoal } from "@/lib/goal-command";
import { useToast, type ToastOptions } from "@/components/ui/toast";
import type { SlashCommand } from "@/components/slash-menu";
import { isExitPlanModeTool } from "@/lib/plan-mode";
import { Message, sendChatMessage, submitUserInput, stopGeneration, getHistory, HistoryRecord, submitBrowserResult, switchVersion, switchToLatest, setPreviewVersion, uploadFile, UploadedFile, TodoItem, checkProjectExists, createProject, importProject, resetProject, clearDoveCloud, listSubagents, type Project, type Goal, type GoalAction, type GoalPostBody } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import UserInputDialog from "./UserInputDialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { ConsoleLog, NetworkRequest } from "@/hooks/useDevToolsBridge";
import { useSpeechSynthesis } from "@/hooks/useSpeechSynthesis";
import PromptReplacementDialog, { getEnabledReplacements, PromptReplacement } from "./PromptReplacementDialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { mergeLogContent, sanitizeLogContent } from "@/lib/logs";

const SETTINGS_KEY = "chat_settings";

// 模型选项
const MODEL_OPTIONS = [
  { value: "deepseek-flash", label: "DeepSeek V4.1 Flash" },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

// 设置类型
/**
 * 输入框占位符 —— 定位是「通用 agent」，不是「网页生成器」。
 *
 * 原来的「做一个 SaaS 产品官网，深色科技风，含定价与 FAQ」把能力框死在建站上，
 * 用户看到会以为它只会做网页。实际上它能查资料、跑命令、写代码、做分析。
 */
const NEW_TASK_PLACEHOLDER = "交给我一件事：查资料、写代码、做分析、跑命令都行…";
const COMPOSER_PLACEHOLDER = "说点什么，或让我做点什么…";

interface ChatSettings {
  model: string;
  enableThinking: boolean;
  continuousChat: boolean;  // 连续对话模式
  enableMemory: boolean;    // 记忆模式
  suggestionAutoSend: boolean;  // 建议点击后自动发送
  enableRecommendFiles: boolean;  // 推荐文件开关（仅普通模式生效）
}

// 默认设置
const DEFAULT_SETTINGS: ChatSettings = {
  model: "deepseek-flash",
  enableThinking: true,   // 默认开启
  continuousChat: true,   // 默认开启
  enableMemory: true,     // 默认开启
  suggestionAutoSend: true,  // 默认自动发送
  enableRecommendFiles: true,  // 默认开启
};

// 转换 usage 格式（兼容新旧格式）
function convertUsageFormat(usage: Record<string, unknown> | undefined): Message['usage'] | undefined {
  if (!usage) return undefined;
  
  // 检查是否为新格式（有 sonnet 字段）
  if (usage.sonnet) {
    return usage as Message['usage'];
  }
  
  // 旧格式转换为新格式
  const isOpus = (usage.model as string)?.includes('opus');
  const inputTokens = (usage.input_tokens as number) || 0;
  const outputTokens = (usage.output_tokens as number) || 0;
  const cacheReadTokens = (usage.cache_read_tokens as number) || 0;
  const cacheCreationTokens = (usage.cache_creation_tokens as number) || 0;
  const totalCost = (usage.total_cost as number) || 0;
  
  return {
    model: isOpus ? 'opus' : 'sonnet',
    model_escalated: false,
    total_cost: totalCost,
    sonnet: isOpus ? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost: 0,
    } : {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      cost: totalCost,
    },
    opus: isOpus ? {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      cost: totalCost,
    } : {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost: 0,
    },
  };
}

// 加载设置
function loadSettings(): ChatSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  return DEFAULT_SETTINGS;
}

// 将后端历史记录转换为前端 Message 格式
function convertHistoryToMessages(history: HistoryRecord[]): Message[] {
  const messages: Message[] = [];
  
  // 计算版本号：只有 is_modified 为 true 的记录才有版本号
  let versionCounter = 0;
  
  for (const record of history) {
    // 用户消息
    messages.push({
      id: record.id + "_user",
      role: "user",
      content: record.user,
      timestamp: new Date(record.start_time),
      skipped_by_restore: record.skipped_by_restore,
    });
    
    // AI 消息
    const aiContent = record.events
      .filter(e => e.type === "text" && e.content)
      .map(e => e.content)
      .join("");
    
    // 提取 ask_user 信息
    const askUserEvent = record.events.find(
      e => e.type === "tool_info" && e.tool === "ask_user"
    );
    
    // 如果有代码变化，版本号 +1
    const currentVersion = record.is_modified ? ++versionCounter : undefined;
    
    // 处理 events，同时计算 todos
    let todoList: TodoItem[] = [];
    const convertedEvents: Message['events'] = [];
    
    for (const e of record.events) {
      if (e.type === "text") {
        convertedEvents.push({ type: "text" as const, content: e.content });
      } else if (e.type === "log") {
        convertedEvents.push({ type: "log" as const, content: e.content });
      } else if (e.type === "thinking") {
        convertedEvents.push({ type: "thinking" as const, content: e.content });
      } else if (e.type === "todo_update" && e.todos) {
        // 处理 todo_update 事件
        const isFirstTodo = !e.merge;  // merge=false 为新建
        
        if (e.merge) {
          // 合并模式：根据 id 更新或添加
          const todoMap = new Map(todoList.map(t => [t.id, t]));
          for (const todo of e.todos) {
            todoMap.set(todo.id, { ...todoMap.get(todo.id), ...todo });
          }
          todoList = Array.from(todoMap.values());
        } else {
          // 替换模式
          todoList = e.todos;
        }
        
        convertedEvents.push({
          type: "todo_update" as const,
          todos: e.todos,
          merge: e.merge,
          isFirstTodo,
        });
      } else if (e.type === "tool_info") {
        if (e.tool === "ask_user") {
          convertedEvents.push({ 
            type: "ask_user" as const, 
            question: e.info?.replace("question: ", ""),
            questionType: (e as { questionType?: "single" | "multiple" }).questionType || "single",
            suggestions: e.suggestions,
            userAnswer: e.userAnswer
          });
        } else {
          convertedEvents.push({ type: "tool_info" as const, tool: e.tool, info: e.info });
        }
      }
    }
    
    const aiMessage: Message = {
      id: record.id + "_ai",
      role: "assistant",
      content: aiContent,
      timestamp: new Date(record.end_time),
      events: convertedEvents,
      todos: todoList.length > 0 ? todoList : undefined,
      // 费用统计（兼容新旧格式）
      usage: convertUsageFormat(record.usage),
      // 版本号（只有修改了代码才有）
      version_number: currentVersion,
      // Git commit hash（用于切换版本）
      commit_hash: record.commit_hash,
      // 是否被恢复操作跳过
      skipped_by_restore: record.skipped_by_restore,
    };
    
    messages.push(aiMessage);
  }
  
  return messages;
}

// DevTools Bridge 类型
interface DevToolsBridge {
  isReady: boolean;
  isReadyRef?: React.MutableRefObject<boolean>;
  checkReady?: () => boolean;
  consoleLogs: ConsoleLog[];
  networkRequests: NetworkRequest[];
  getConsoleLogs: () => Promise<ConsoleLog[]>;
  getNetworkRequests: () => Promise<NetworkRequest[]>;
  clearLogs: () => Promise<void>;
  refreshAndClearLogs?: () => Promise<void>;
  captureScreenshot?: (fullPage?: boolean) => Promise<string | null>;
}

interface ChatPanelProps {
  devToolsBridge?: DevToolsBridge;
  onVersionChange?: (version: number | null) => void;
  onLatestVersionChange?: (version: number) => void;
  latestVersion?: number;  // 最新版本号
  projectId?: string | null;  // 项目ID（端口号）
  onProjectSelect?: (port: string) => void;  // 项目选择回调
  onRefreshPreview?: () => void;  // 刷新预览面板
  onLoadingChange?: (isLoading: boolean) => void;  // 加载状态变化回调
  onStartDevServer?: () => void;  // 启动开发服务器（发消息时触发）
  externalBuildError?: string | null;  // 外部传入的构建错误（如版本切换时的构建错误）
  onClearBuildError?: () => void;  // 清除外部构建错误
  externalRuntimeError?: string | null;  // 外部传入的运行时错误
  onClearRuntimeError?: () => void;  // 清除外部运行时错误
  onSwitchingVersionChange?: (switching: boolean) => void;  // 版本切换状态变化回调
  onPreviewReady?: (newVersion: number) => void;  // 预览构建完成回调（用于静态模式刷新）
  onBuildStart?: () => void;  // 开始构建回调（用于静态模式显示 loading）
  enableHotReload?: boolean;  // 热更新开关状态（传给后端）
  onFileModifying?: (isModifying: boolean) => void;  // 文件修改工具调用回调（用于提前展示预览面板）
  /** 打开项目内文件（消息流里的交付物卡片）—— 由 App 接到右侧预览面板 */
  onOpenFile?: (path: string) => void;
  onProjectCreated?: () => void;  // 新建项目后的回调（用于刷新目录树）
  asideCollapsed?: boolean;        // 预览区是否已收起
  onToggleAside?: () => void;      // 收起/展开预览区
  onQuickCreateTask?: (text: string) => void;  // 空状态里直接开新任务
  projects?: Project[];                        // 起始页的项目选择器用
  draftProject?: string | null;                // 起始页预选的项目
  onDraftProjectChange?: (project: string | null) => void;
  onChooseFolder?: () => void;                 // 唤起系统选择框并接入项目
  pendingMessage?: string | null;  // 建好任务后要自动发出的第一条消息
  onPendingMessageConsumed?: () => void;
}

export default function ChatPanel({ devToolsBridge, onVersionChange, onLatestVersionChange, latestVersion, projectId, onProjectSelect, onRefreshPreview, onLoadingChange, onStartDevServer, externalBuildError, onClearBuildError, externalRuntimeError, onClearRuntimeError, onSwitchingVersionChange, onPreviewReady, onBuildStart, enableHotReload, onFileModifying, onOpenFile, onProjectCreated, onQuickCreateTask, pendingMessage, onPendingMessageConsumed, asideCollapsed, onToggleAside, projects = [], draftProject, onDraftProjectChange, onChooseFolder }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  // 子代理状态（顶部状态栏）。内核的 subagent_text 不带 label，
  // 流式文本按「最近一个 running 的」归并 —— 见 reduceSubagents。
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  // A4：点进去看的那个子代理。null = 主对话
  const [viewing, setViewing] = useState<{ id: string; label: string } | null>(null);
  // 权限模式：**一个 hook 管两种情况**
  //   projectId 有值 → 这个项目的权限（后端线程 metadata）
  //   projectId 为空 → 新会话页，存成「下一个项目的默认值」
  // 以前这两条路各写一份，导致新会话页选了完全访问、进会话又变回工作区。
  const [permission, changePermission] = usePermissionMode(projectId);
  /**
   * 计划模式（B5）—— 线程级的第二根权限轴：不改权限档，只让内核把写类工具
   * 从工具表里裁掉（硬只读）。模型交计划走 ExitPlanMode + 既有审批通道，
   * 用户批准后**内核自己**把这一位关掉 —— 所以除 change 外还要 refresh。
   */
  const [planMode, changePlanMode, refreshPlanMode] = usePlanMode(projectId);
  /**
   * 长期目标 —— **线程级**（每线程至多一个）。目标 active 时内核会在每轮结束后
   * 自动再开一轮，所以面板只给两个入口：输入框上方的状态条、输入框里的 /goal 命令。
   * 两者共用同一个 apply（见 runGoalCommand / runGoalBarAction）。
   */
  const { goal, pending: goalPending, apply: applyGoal, refresh: refreshGoal } = useGoal(projectId);
  /** 轻量提示（进入/退出计划模式给个明确反馈） */
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [isLoadingState, setIsLoadingState] = useState(false);
  /**
   * 有回合正在跑的会话（key = projectId）。**可以同时有多个。**
   *
   * 为什么不能只用一个布尔：用户可以在 A 会话发完消息后切到 B 会话干活。
   * 原来 isLoading 是全局的，于是：
   *   · 切到 B 时，B 显示「生成中」（其实是 A 在跑）
   *   · A 跑完把标志清掉，如果那时用户在 B，B 的输入框状态也是错的
   */
  const [runningProjects, setRunningProjects] = useState<Set<string>>(() => new Set());
  /**
   * 当前正在看哪个会话 —— 给**流回调**判断用。
   *
   * 为什么必须是 ref：流回调是 sendChatMessage 里注册的长生命周期闭包，
   * 它捕获的是**发送那一刻**的 projectId。用户切走后，闭包里的值不会变，
   * 于是旧流的 setMessages 会一直往**新会话**的消息列表里追加（实测：乱入）。
   * ref 每次渲染更新，闭包读到的永远是"现在在看哪个"。
   */
  const viewedProjectRef = useRef<string | null>(null);
  useEffect(() => { viewedProjectRef.current = projectId ?? null; }, [projectId]);
  /**
   * 正在跑的那一轮的消息**镜像**，带「它属于哪个会话」。
   *
   * 为什么需要：用户在 A 发完消息切到 B，A 的流还在收事件。原来的做法是
   * 「切走就不写视图」—— 事件直接丢了，切回 A 只剩「AI 正在思考」，
   * 之前的推理过程和工具详情全没了（用户实测报的）。
   *
   * 现在改成：**照写，但写进这个镜像**（不写视图）。切回来时从镜像恢复。
   * 保留 project 字段是为了判断「镜像里这份是不是当前会话的」——
   * 不是的话（比如 A 跑完后又切到 C）就不能拿它当起点。
   */
  const messagesMirrorRef = useRef<{ project: string; list: Message[] }>({ project: "\u0000none", list: [] });
  /** messages 的最新值（供流回调做起点，闭包里读 state 会拿到旧值） */
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [startDraft, setStartDraft] = useState("");
  // 新会话页的「计划模式」草稿：此时还没有线程，只能先存着，建项目时由 App 落地
  const [draftPlan, setDraftPlan] = useState(() => readDraftPlanMode());
  // 新会话页写的目标草稿（还没有线程可挂，建任务时由 App 落地）
  const [draftGoal, setDraftGoal] = useState<string | null>(() => readDraftGoal());
  const [folderMode, setFolderMode] = useState(false);
  const [folderPath, setFolderPath] = useState("");

  const submitStartDraft = () => {
    const text = startDraft.trim();
    if (!text) return;

    // /goal 在新会话页**也能用**：这时还没有线程，所以先记成草稿，
    // 建好任务后由 App 自动落地（不再是"目标要绑定到任务"那种拒绝）。
    const cmd = parseGoalCommand(text);
    if (cmd) {
      setStartDraft("");
      if (cmd.kind === "create") {
        writeDraftGoal(cmd.objective);
        setDraftGoal(cmd.objective);
        toast({ title: "已记下长期目标", description: "建好任务后自动生效，每轮结束会接着推进", tone: "info" });
      } else if (cmd.kind === "status") {
        toast(draftGoal
          ? { title: "待生效的目标", description: draftGoal, tone: "info" }
          : { title: "还没有目标", description: "输入 /goal <目标描述>；建好任务后自动生效", tone: "info" });
      } else if (cmd.kind === "blocked") {
        toast({ title: "先有任务才能标阻塞", description: "建好任务后再 /goal blocked <原因>", tone: "warning" });
      } else if (cmd.action === "clear") {
        clearDraftGoal(); setDraftGoal(null);
        toast({ title: "已清掉待生效的目标", tone: "default" });
      } else {
        toast({ title: "还没有任务", description: "暂停 / 继续 / 完成要落在具体任务上：先建任务，再在它的输入框里操作", tone: "info" });
      }
      return;
    }

    setStartDraft("");
    onQuickCreateTask?.(text);
  };
  
  // 包装 setIsLoading，同时通知父组件
  const setIsLoading = (loading: boolean) => {
    setIsLoadingState(loading);
    onLoadingChange?.(loading);
  };
  /**
   * 「当前会话」是否在跑 —— **不是全局的**。
   * 用户在 A 发完消息切到 B 时，B 不该显示生成中；切回 A 时 A 要显示。
   */
  const isLoading = runningProjects.has(projectId ?? "");
  const [currentRoute, setCurrentRoute] = useState("/");
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stats, setStats] = useState<{
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    rounds: number;
  } | null>(null);
  
  // 用户输入对话框状态
  const [userInputDialog, setUserInputDialog] = useState<{
    open: boolean;
    question: string;
    suggestions?: string[];
    sessionId?: string;
  }>({
    open: false,
    question: "",
    suggestions: undefined,
    sessionId: undefined,
  });

  // 黑科技菜单状态
  const [labMenuOpen, setLabMenuOpen] = useState(false);
  const [promptReplacementDialogOpen, setPromptReplacementDialogOpen] = useState(false);
  
  // Clear Dove Cloud 状态
  const [clearCloudDialogOpen, setClearCloudDialogOpen] = useState(false);
  const [clearCloudLoading, setClearCloudLoading] = useState(false);

  // AI 风格状态
  const [aiStyle, setAiStyle] = useState(() => loadSavedStyle());

  // Build 错误状态
  const [buildError, setBuildError] = useState<string | null>(null);

  // 项目选择相关状态
  const [portInput, setPortInput] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [showPortPopover, setShowPortPopover] = useState(false);
  
  // 重置项目相关状态
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  
  // 导入项目相关状态
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importVersionId, setImportVersionId] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  
  // 附件上传状态
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // 语音朗读 Hook
  const speechSynthesis = useSpeechSynthesis();
  
  // 版本切换 loading 状态
  const [isSwitchingVersion, setIsSwitchingVersion] = useState(false);

  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const currentSessionId = useRef<string | null>(null);
  const pendingNewVersionRef = useRef<number | null>(null);  // 当前会话产生的新版本号（用于 preview_ready 回调）
  const isNearBottomRef = useRef(true);
  const isInitializedRef = useRef(false);
  const hasRestoredVersionRef = useRef(false);  // 跟踪本次对话是否触发了版本恢复
  const lastProjectIdRef = useRef<string | null>(null);

  // 初始化设置（只执行一次）
  useEffect(() => {
    if (!isInitializedRef.current) {
      const savedSettings = loadSettings();
      setSettings(savedSettings);
      isInitializedRef.current = true;
    }
  }, []);

  // 加载历史记录的函数（可复用）
  const loadHistory = async (port: string, switchLatest: boolean = false) => {
    try {
      if (switchLatest) {
        await switchToLatest(port).catch(() => {
          // 忽略错误，可能已经在最新版本
        });
      }
      
      const data = await getHistory(port);
      if (data.history && data.history.length > 0) {
        const convertedMessages = convertHistoryToMessages(data.history);
        setMessages(convertedMessages);
        
        // 计算最新版本号（有 is_modified 的记录数量）
        const latestVersion = data.history.filter((r: HistoryRecord) => r.is_modified).length;
        onLatestVersionChange?.(latestVersion);
        
        // 初次加载时，直接跳到底部（不要平滑滚动）
        if (isInitialLoadRef.current) {
          setTimeout(() => {
            scrollToBottom(true);
            isInitialLoadRef.current = false;
          }, 50);
        }
        
        // 最新版本使用热更新，不需要设置 setPreviewVersion
        // 父组件会根据 latestVersion 决定使用热更新 URL
      } else {
        // 没有历史记录时清空消息
        setMessages([]);
        onLatestVersionChange?.(0);
        isInitialLoadRef.current = false;
      }
    } catch (error) {
      console.error("Failed to load history from API:", error);
    }
  };
  
  // 只更新 skipped_by_restore 标记，不替换整个消息列表（避免闪烁和滚动）
  const updateSkippedMarks = async (port: string) => {
    try {
      const data = await getHistory(port);
      if (data.history && data.history.length > 0) {
        // 构建 record_id -> skipped_by_restore 的映射
        const skippedMap = new Map<string, boolean>();
        for (const record of data.history) {
          // 用户消息和 AI 消息的 id 是 record.id + "_user" 和 record.id + "_ai"
          skippedMap.set(record.id + "_user", record.skipped_by_restore || false);
          skippedMap.set(record.id + "_ai", record.skipped_by_restore || false);
        }
        
        // 只更新 skipped_by_restore 字段
        setMessages(prev => prev.map(msg => ({
          ...msg,
          skipped_by_restore: skippedMap.get(msg.id) || false,
        })));
      }
    } catch (error) {
      console.error("Failed to update skipped marks:", error);
    }
  };

  // 当 projectId 变化时加载历史记录
  useEffect(() => {
    // 只有 projectId 有值且与上次不同时才加载
    if (projectId && projectId !== lastProjectIdRef.current) {
      lastProjectIdRef.current = projectId;
      // ⚠️ 这个会话**有正在跑的回合** → 从镜像恢复，不要 loadHistory。
      //    loadHistory 读的是服务端历史，而那一轮还没结束、历史里还没有它 ——
      //    覆盖上去就是「AI 正在思考」但过程全空（用户实测报的就是这个）。
      if (messagesMirrorRef.current.project === projectId) {
        setMessages(messagesMirrorRef.current.list);
      } else {
        loadHistory(projectId, true);
      }
    }
  }, [projectId]);

  // 设置变化时保存到 localStorage
  useEffect(() => {
    if (isInitializedRef.current) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
  }, [settings]);

  // 更新设置
  const updateSettings = (newSettings: Partial<ChatSettings>) => {
    setSettings(prev => ({ ...prev, ...newSettings }));
  };

  // 是否是初次加载（用于决定滚动方式）
  const isInitialLoadRef = useRef(true);

  const scrollToBottom = (instant: boolean = false) => {
    messagesEndRef.current?.scrollIntoView({ 
      behavior: instant ? "instant" : "smooth" 
    });
  };

  // 检测是否在底部附近（允许 100px 的误差）
  const checkIfNearBottom = () => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    
    const threshold = 100;
    const isNear = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    isNearBottomRef.current = isNear;
    return isNear;
  };

  // 处理滚动事件
  const handleScroll = () => {
    checkIfNearBottom();
  };

  // 只有在底部时才自动滚动（初次加载由 loadHistory 处理）
  useEffect(() => {
    if (isNearBottomRef.current && !isInitialLoadRef.current) {
    scrollToBottom();
    }
  }, [messages]);

  // 任务建好后，把它当作第一条消息自动发出
  useEffect(() => {
    if (projectId && pendingMessage) {
      onPendingMessageConsumed?.();
      void handleSend(pendingMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pendingMessage]);

  // 处理文件选择
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !projectId) return;
    
    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        const uploaded = await uploadFile(file, projectId);
        setAttachments(prev => [...prev, uploaded]);
      }
    } catch (error) {
      console.error("文件上传失败:", error);
      alert(error instanceof Error ? error.message : "文件上传失败");
    } finally {
      setIsUploading(false);
      // 清空 input，以便可以重复选择同一文件
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };
  
  // 移除附件
  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

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
        onProjectCreated?.();
      }
      
      // 选择项目
      onProjectSelect(port);
      setShowPortPopover(false);
      setPortInput("");
    } catch (error) {
      console.error("进入项目失败:", error);
      alert(`进入项目失败: ${error}`);
    } finally {
      setIsCreating(false);
    }
  };

  // 重置项目
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

  // 导入项目
  const handleImportProject = async () => {
    if (!projectId || !importVersionId.trim()) {
      return;
    }
    
    setIsImporting(true);
    try {
      const result = await importProject(projectId, importVersionId.trim());
      if (result.success) {
        console.log("✅ 项目导入成功:", result);
        // 关闭对话框并清空输入
        setShowImportDialog(false);
        setImportVersionId("");
        
        // 导入成功后启动开发服务器（自动开启热更新预览）
        // 这样可以直接查看导入的项目，无需刷新页面
        onStartDevServer?.();
        console.log("🚀 导入成功，正在启动开发服务器...");
      } else {
        alert(`导入失败: ${result.message}`);
      }
    } catch (error) {
      console.error("导入项目失败:", error);
      alert(`导入失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsImporting(false);
    }
  };

  // ── 长期目标：人类入口 ──────────────────────────────────────────
  // 目标是内核的状态机，面板只负责把用户的操作翻译成 POST /goal。
  // 命令（/goal xxx）和状态条按钮**走同一个 runGoalAction** —— 区别只在"打字"还是"点按"。

  /** 操作成功后的文案。轮次只在这里出现：状态条刻意不显示进度（见 goal-bar.tsx） */
  const toastGoalDone = (action: GoalAction, g: Goal | null): ToastOptions => {
    switch (action) {
      case "create":
        return {
          title: "已设定长期目标",
          description: `每轮结束后自动接着推进（最多 ${g?.max_rounds ?? "?"} 轮），随时 /goal pause 暂停`,
          tone: "success",
        };
      case "pause":
        return { title: "已暂停自动推进", description: "目标还在、进度也在；/goal resume 继续", tone: "default" };
      case "resume":
        return { title: "已继续自动推进", description: "内核会在每轮结束后自动再开一轮", tone: "success" };
      case "complete":
        return { title: "目标已完成", description: "自动推进已停；要清掉记录就 /goal clear", tone: "success" };
      case "blocked":
        return { title: "已标记为阻塞", description: "卡点写清楚了，接手时能直接看懂", tone: "warning" };
      default:
        return { title: "已清除目标", description: "可以重新设一个新目标了", tone: "default" };
    }
  };

  /**
   * 执行一次目标操作 + 反馈。**不抛错**：失败按内核的 code 给一句能照做的提示 ——
   * 409 GOAL_ALREADY_EXISTS = 已有未完成目标（先 clear）；404 = 还没有目标；400 = 状态不允许。
   */
  const runGoalAction = async (body: GoalPostBody): Promise<void> => {
    const res = await applyGoal(body);
    if (!res.ok) {
      const already = res.code === "GOAL_ALREADY_EXISTS";
      toast({
        title: already ? "已有未完成的目标" : "目标操作没成功",
        description: already ? "先 /goal clear 清掉它，或 /goal complete 收尾，再设新的" : res.message,
        tone: "warning",
      });
      return;
    }
    toast(toastGoalDone(body.action, res.goal));
  };

  /**
   * 输入框里的 /goal —— **面板自己处理，不发给模型**。
   * 返回 true 表示这条输入已经被吃掉（调用方直接 return，不要走发送流程）。
   */
  const runGoalCommand = async (raw: string): Promise<boolean> => {
    const cmd = parseGoalCommand(raw);
    if (!cmd) return false;
    setInput("");                       // 命令不进消息流，输入框立刻清空

    // 裸 /goal：拉一次现状，把 phase / objective / 轮次说清楚
    if (cmd.kind === "status") {
      const res = await refreshGoal();
      if (!res.ok) {
        toast({ title: "读不到目标状态", description: res.message, tone: "warning" });
        return true;
      }
      const g = res.goal;
      toast(g
        ? {
            title: `目标 · ${goalPhaseLabel(g.phase)}`,
            description: `${truncateGoal(g.objective, 80)} · ${goalSummary(g)}`,
            tone: "info",
          }
        : {
            title: "还没有长期目标",
            description: "输入 /goal <目标描述> 设一个：内核会跨多轮自动推进",
            tone: "default",
          });
      return true;
    }

    if (cmd.kind === "create") {
      await runGoalAction({ action: "create", objective: cmd.objective });
      return true;
    }
    if (cmd.kind === "blocked") {
      // 内核也会 400，这里先挡一道 —— 提示能直接告诉用户该怎么写
      if (!cmd.reason) {
        toast({ title: "标阻塞要写原因", description: "用法：/goal blocked <是什么具体条件卡住了>", tone: "warning" });
        return true;
      }
      await runGoalAction({ action: "blocked", blocked_reason: cmd.reason });
      return true;
    }
    await runGoalAction({ action: cmd.action });
    return true;
  };

  /** 状态条上的按钮 —— 和 /goal 命令走同一条路，只是不用打字 */
  const runGoalBarAction = (action: GoalAction) => { void runGoalAction({ action }); };

  const handleSend = async (messageText?: string, isNewProject: boolean = false) => {
    const textToSend = messageText || input;
    // /goal … 是**面板命令**，不发模型。刻意放在 isLoading 检查之前：一轮正在跑的时候
    // 也要能 /goal pause / complete。只拦"手动发送"这条路 —— messageText 是程序自动发的
    // （重试 / 继续 / 建完任务后的第一条），里面以 /goal 开头也只是普通正文。
    if (messageText === undefined && (await runGoalCommand(textToSend))) return;
    if (!textToSend.trim() || isLoading) return;

    // ⚠️ 这个会话在这次 send 里是哪个 —— 流回调靠它判断「事件还该不该写进当前视图」。
    //    必须在这里**捕获**（闭包），不能到回调里再读 projectId（那时可能是别的会话了）。
    const streamProject = projectId ?? "";
    // 立即设置 loading 状态，防止重复发送
    setIsLoading(true);
    setRunningProjects((prev) => new Set(prev).add(streamProject));
    /**
     * 用户是不是还停在这个会话上看。
     * 切走之后旧流继续收，但**不再写视图** —— 服务端照跑、历史照存，只是不往别的会话里灌。
     */
    const stillViewing = () => viewedProjectRef.current === streamProject;
    /**
     * 这一轮流的所有消息更新都走这里 —— **切走也不丢**。
     *   在看这个会话  → 同时写镜像和视图
     *   切走了        → 只写镜像（服务端照跑，切回来能恢复）
     */
    const applyMessages = (updater: (prev: Message[]) => Message[]) => {
      const base = messagesMirrorRef.current.project === streamProject
        ? messagesMirrorRef.current.list
        : messagesRef.current;          // 这一轮刚开始：以当前视图为起点
      const next = updater(base);
      messagesMirrorRef.current = { project: streamProject, list: next };
      if (stillViewing()) setMessages(next);
    };
    // 新的一轮开始 → 清掉上一轮已完成的子代理（还在跑的保留）
    pruneSubagents();
    
    // 清空输入框（放在前面，给用户即时反馈）
    if (!messageText) {
      setInput("");
    }

    // 发消息时启动开发服务器（如果还没启动）
    onStartDevServer?.();

    // 发消息前自动切回最新版本
    if (projectId) {
      try {
        await switchToLatest(projectId);
        // 通知父组件已切回最新版本
        onVersionChange?.(null);
      } catch (error) {
        // 忽略错误，可能已经在最新版本
        console.log("切换到最新版本:", error);
      }
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: textToSend,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    
    // 发送消息后强制滚动到底部
    setTimeout(() => scrollToBottom(), 50);

    // 清理上次对话的状态
    pendingNewVersionRef.current = null;

    // 创建一个新的 AI 消息用于流式更新
    const aiMessageId = (Date.now() + 1).toString();
    
    // 用于跟踪最后一个工具的参数（检测 project_plan.md 创建）
    let lastToolParams: { tool?: string; params?: Record<string, unknown> } | null = null;
    const aiMessage: Message = {
      id: aiMessageId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      toolCalls: [],
      events: [],
    };

    setMessages((prev) => [...prev, aiMessage]);

    // 构建消息内容（如有附件，追加文件信息）
    let finalMessage = textToSend;
    const currentAttachments = [...attachments];
    
    if (currentAttachments.length > 0) {
      const attachmentInfo = currentAttachments.map(a => 
        `- 文件: ${a.name} (${a.type}, file_id: ${a.id})`
      ).join("\n");
      finalMessage = `${textToSend}\n\n[用户上传了以下文件，你可以使用 save_uploaded_file 工具将文件保存到项目中]\n${attachmentInfo}`;
      // 清空附件列表
      setAttachments([]);
    }
    
    try {
      // 获取启用的提示词替换规则
      const enabledReplacements = getEnabledReplacements();
      
      await sendChatMessage(
        {
          message: finalMessage,
          route: currentRoute,
          if_history: !isNewProject,
          if_thinking: settings.enableThinking,
          if_new_project: isNewProject,
          model: settings.model,
          continuous_chat: settings.continuousChat,
          if_memory: settings.enableMemory,
          project_id: projectId || undefined,
          prompt_replacements: enabledReplacements.length > 0 ? enabledReplacements : undefined,
          if_hot_reload: enableHotReload,
          if_recommend_files: settings.enableRecommendFiles,
          attachments: currentAttachments.length > 0 ? currentAttachments.map(a => ({
            file_id: a.id,
            filename: a.name,
            mime_type: a.type,
            size: a.size,
          })) : undefined,
          ai_style_x: aiStyle.x,
          ai_style_y: aiStyle.y,
        },
        (event) => {
          // ⚠️ 用户已经切走 → **这个流的事件不再写进当前视图**。
          //
          // 为什么必须挡：流回调是长生命周期闭包，setMessages/setSubagents 都是
          // ChatPanel 的**全局** state。不挡的话，在 A 会话跑着的回合会把
          // 推理过程、工具详情、子代理状态全灌进用户后来打开的 B 会话（实测踩过）。
          // 服务端那一轮照跑、历史照存 —— 切回去 loadHistory 就能看到结果。
          if (!stillViewing()) return;

          // 处理会话 ID
          if (event.type === "session_id") {
            currentSessionId.current = event.content || null;
            console.log("收到会话 ID:", currentSessionId.current);
          } 
          // 处理 ask_user 事件 - 放到消息流中
          else if (event.type === "ask_user") {
            applyMessages((prev) =>
              prev.map((msg) =>
                msg.id === aiMessageId
                  ? {
                      ...msg,
                      askUser: {
              question: event.question || "",
              questionType: event.question_type || "single",
              suggestions: event.suggestions,
                        answered: false,
                      },
                      events: [
                        ...(msg.events || []),
                        { 
                          type: "ask_user" as const, 
                          question: event.question,
                          questionType: event.question_type || "single",
                          suggestions: event.suggestions 
                        }
                      ]
                    }
                  : msg
              )
            );
          }
          // 处理 browser_action 事件（获取 console/network 日志）
          else if (event.type === "browser_action") {
            const action = event.action;
            const sessionId = currentSessionId.current;
            
            // 使用 checkReady() 获取最新状态，避免闭包问题
            const isReady = devToolsBridge?.checkReady?.() ?? devToolsBridge?.isReady;
            console.log("🔧 收到 browser_action:", { action, sessionId, isReady });
            
            if (sessionId && devToolsBridge) {
              (async () => {
                try {
                  let result: unknown;
                  
                  if (action === "read_console") {
                    console.log("📋 正在获取 console 日志...");
                    result = await devToolsBridge.getConsoleLogs();
                    console.log("📋 获取 console 日志成功:", result);
                  } else if (action === "read_network") {
                    console.log("🌐 正在获取 network 请求...");
                    result = await devToolsBridge.getNetworkRequests();
                    console.log("🌐 获取 network 请求成功:", result);
                  } else if (action === "capture_screenshot") {
                    console.log("📸 正在捕获预览截图...");
                    const fullPage = (event as { full_page?: boolean }).full_page ?? false;
                    const requireUserAssistance = (event as { require_user_assistance?: boolean }).require_user_assistance ?? false;
                    const instruction = (event as { instruction?: string }).instruction || "请提供截图";
                    
                    if (requireUserAssistance) {
                      // 用户协助模式：添加到消息事件中，显示内嵌组件
                      console.log("📸 需要用户协助截图，添加到消息事件...");
                      applyMessages((prev) =>
                        prev.map((msg) =>
                          msg.id === aiMessageId
                            ? {
                                ...msg,
                                events: [
                                  ...(msg.events || []),
                                  { 
                                    type: "screenshot_request" as const, 
                                    instruction,
                                    sessionId,
                                    fullPage,
                                  }
                                ]
                              }
                            : msg
                        )
                      );
                      // 不立即提交结果，等待用户操作
                      return;
                    }
                    
                    // 自动截图模式（原有逻辑）
                    if (devToolsBridge.captureScreenshot) {
                      const screenshot = await devToolsBridge.captureScreenshot(fullPage);
                      if (screenshot) {
                        result = { screenshot };
                        console.log("📸 截图成功");
                      } else {
                        result = { error: "截图失败" };
                        console.error("📸 截图失败");
                      }
                    } else {
                      result = { error: "captureScreenshot 方法不可用" };
                      console.error("📸 captureScreenshot 方法不可用");
                    }
                  }
                  
                  // 提交结果给后端
                  console.log("📤 提交结果给后端...");
                  await submitBrowserResult(sessionId, action || "", result);
                  console.log("✅ 提交成功");
                } catch (error) {
                  console.error("处理 browser_action 失败:", error);
                  // 发送空结果，避免后端一直等待
                  await submitBrowserResult(sessionId, action || "", { error: String(error) });
                }
              })();
            } else {
              const currentReady = devToolsBridge?.checkReady?.() ?? devToolsBridge?.isReady;
              console.warn("⚠️ browser_action 条件不满足:", { sessionId, isReady: currentReady });
              // 即使条件不满足，也要发送空结果，避免后端超时
              if (sessionId) {
                submitBrowserResult(sessionId, action || "", { error: "DevTools Bridge not ready" });
              }
            }
          } 
          else if (event.type === "log") {
            applyMessages((prev) =>
              prev.map((msg) =>
                msg.id === aiMessageId
                  ? (() => {
                      const incomingContent = sanitizeLogContent(event.content);
                      if (!incomingContent) {
                        return msg;
                      }

                      const events = [...(msg.events || [])];
                      const lastEvent = events[events.length - 1];

                      if (lastEvent?.type === "log") {
                        events[events.length - 1] = {
                          ...lastEvent,
                          content: mergeLogContent(lastEvent.content, incomingContent),
                        };
                      } else {
                        events.push({
                          type: "log" as const,
                          content: incomingContent,
                        });
                      }

                      return { ...msg, events };
                    })()
                  : msg
              )
            );
          } else if (event.type === "text") {
            // 流式语音朗读：将文本片段传给朗读器
            if (event.content) {
              speechSynthesis.appendText(event.content);
            }
            
            applyMessages((prev) =>
              prev.map((msg) =>
                msg.id === aiMessageId
                  ? {
                      ...msg,
                      content: msg.content + event.content,
                      events: [
                        ...(msg.events || []),
                        { type: "text", content: event.content }
                      ]
                    }
                  : msg
              )
            );
          } else if (event.type === "tool_start") {
            // 检测文件修改工具，提前通知父组件展示预览面板
            const fileModifyTools = ["edit_file", "new_file", "create_file", "write_file", "delete_file"];
            if (fileModifyTools.includes(event.tool || "")) {
              onFileModifying?.(true);
            }
            
            applyMessages((prev) =>
              prev.map((msg) =>
                msg.id === aiMessageId
                  ? {
                      ...msg,
                      toolCalls: [
                        ...(msg.toolCalls || []),
                        { tool: event.tool || "", info: "" },
                      ],
                      events: [
                        ...(msg.events || []),
                        { type: "tool_start", tool: event.tool }
                      ]
                    }
                  : msg
              )
            );
          } else if (event.type === "tool_info") {
            applyMessages((prev) =>
              prev.map((msg) => {
                if (msg.id === aiMessageId) {
                  const updatedToolCalls = [...(msg.toolCalls || [])];
                  if (updatedToolCalls.length > 0) {
                    const lastIndex = updatedToolCalls.length - 1;
                    updatedToolCalls[lastIndex] = {
                      ...updatedToolCalls[lastIndex],
                      info: updatedToolCalls[lastIndex].info
                        ? updatedToolCalls[lastIndex].info + "\n" + event.info
                        : event.info || "",
                    };
                  }
                  
                  return {
                    ...msg,
                    toolCalls: updatedToolCalls,
                    events: [
                      ...(msg.events || []),
                      { type: "tool_info", info: event.info }
                    ]
                  };
                }
                return msg;
              })
            );
          } else if (event.type === "tool_params") {
            // 记录最后一个工具的参数（用于 tool_result 时检测）
            lastToolParams = { tool: event.tool, params: event.params };
            
            // 保存完整的工具参数（用于继续生成）
            applyMessages((prev) =>
              prev.map((msg) => {
                if (msg.id === aiMessageId) {
                  return {
                    ...msg,
                    events: [
                      ...(msg.events || []),
                      { type: "tool_params", tool: event.tool, params: event.params }
                    ]
                  };
                }
                return msg;
              })
            );
          } else if (event.type === "tool_result") {
            lastToolParams = null;  // 清除
            
            // 保存工具执行结果（用于继续生成）
            applyMessages((prev) =>
              prev.map((msg) => {
                if (msg.id === aiMessageId) {
                  return {
                    ...msg,
                    events: [
                      ...(msg.events || []),
                      { type: "tool_result", tool: event.tool, result: event.result }
                    ]
                  };
                }
                return msg;
              })
            );

            // ExitPlanMode 的批准发生在工具内部：用户点「允许」后内核随即把 planMode
            // 置回 false。面板不知道那一刻，只能等工具结果回来重读 —— chip 才会消失。
            if (isExitPlanModeTool(event.tool)) {
              void refreshPlanMode();
            }
          } else if (event.type === "todo_update") {
            // 更新当前消息的 todo 列表
            const newTodos = event.todos || [];
            const merge = event.merge ?? true;
            
            console.log("📋 收到 todo_update 事件:", { newTodos, merge, aiMessageId });
            
            applyMessages((prev) =>
              prev.map((msg) => {
                if (msg.id === aiMessageId) {
                  let updatedTodos = msg.todos || [];
                  // 根据 merge 参数判断：merge=false 为新建，merge=true 为更新
                  const isFirstTodo = !merge;
                  
                  if (merge) {
                    // 合并模式：根据 id 更新或添加
                    const todoMap = new Map(updatedTodos.map(t => [t.id, t]));
                    for (const todo of newTodos) {
                      todoMap.set(todo.id, { ...todoMap.get(todo.id), ...todo });
                    }
                    updatedTodos = Array.from(todoMap.values());
                  } else {
                    // 替换模式
                    updatedTodos = newTodos;
                  }
                  
                  // 将 todo_update 作为事件添加到 events 数组中（用于按顺序渲染）
                  const todoEvent = {
                    type: "todo_update" as const,
                    todos: newTodos,
                    merge,
                    isFirstTodo,
                  };
                  
                  return { 
                    ...msg, 
                    todos: updatedTodos,
                    events: [...(msg.events || []), todoEvent]
                  };
                }
                return msg;
              })
            );
          } else if (event.type === "stats") {
            // 新格式：后端直接返回计算好的 usage（包含分模型统计）
            const usage = event.usage;
            const sonnet = usage?.sonnet;
            const opus = usage?.opus;
            
            // 合并 token 用于 stats 显示
            const totalInputTokens = (sonnet?.input_tokens || 0) + (opus?.input_tokens || 0);
            const totalOutputTokens = (sonnet?.output_tokens || 0) + (opus?.output_tokens || 0);
            const totalCacheReadTokens = (sonnet?.cache_read_tokens || 0) + (opus?.cache_read_tokens || 0);
            const totalCacheCreationTokens = (sonnet?.cache_creation_tokens || 0) + (opus?.cache_creation_tokens || 0);
            
            setStats({
              input_tokens: totalInputTokens,
              output_tokens: totalOutputTokens,
              cache_read_tokens: totalCacheReadTokens,
              cache_creation_tokens: totalCacheCreationTokens,
              rounds: event.rounds || 0,
            });
            
            // 注意：不再在 stats 时触发 onBuildStart，改为在 build_start 事件时触发
            // 这样 loading 时间更短，用户体验更好
            
            applyMessages((prev) => {
              // 计算版本号（如果有代码变化）
              let newVersionNumber: number | undefined = undefined;
              if (event.is_modified) {
                // 计算当前已有的最大版本号
                const maxVersion = prev.reduce((max, msg) => {
                  return msg.version_number ? Math.max(max, msg.version_number) : max;
                }, 0);
                newVersionNumber = maxVersion + 1;
                // 更新最新版本号
                onLatestVersionChange?.(newVersionNumber);
                // 重置文件修改状态（已有版本，不需要提前展示预览面板了）
                onFileModifying?.(false);
                // 保存到 ref，供 preview_ready 事件使用
                pendingNewVersionRef.current = newVersionNumber;
              }
              
              return prev.map((msg) =>
                msg.id === aiMessageId
                  ? { 
                      ...msg, 
                      timestamp: new Date(),
                      usage: {
                        model: usage?.model || "sonnet",
                        model_escalated: event.model_escalated || false,
                        total_cost: usage?.total_cost || 0,
                        sonnet: {
                          input_tokens: sonnet?.input_tokens || 0,
                          output_tokens: sonnet?.output_tokens || 0,
                          cache_read_tokens: sonnet?.cache_read_tokens || 0,
                          cache_creation_tokens: sonnet?.cache_creation_tokens || 0,
                          cost: sonnet?.cost || 0,
                        },
                        opus: {
                          input_tokens: opus?.input_tokens || 0,
                          output_tokens: opus?.output_tokens || 0,
                          cache_read_tokens: opus?.cache_read_tokens || 0,
                          cache_creation_tokens: opus?.cache_creation_tokens || 0,
                          cost: opus?.cost || 0,
                        },
                      },
                      version_number: newVersionNumber,
                    }
                  : msg
              );
            });
            
            // 收到 stats 就表示 AI 输出完成，立即执行"完成"处理
            // 后端的记忆更新和 Git commit 会在后台继续执行
            setIsLoading(false);
            
            // 刷新语音缓冲区，朗读剩余的文本
            speechSynthesis.flushBuffer();
            
            // 一轮结束顺手对齐一次计划模式：批准 / 拒绝 / 用户手点都可能在这一轮里发生，
            // 面板本地状态和线程 metadata 不该有分歧
            void refreshPlanMode();

            // 目标也一样：模型有 UpdateGoal 工具，它可能在这一轮里自己把目标标完成 / 标阻塞，
            // 状态条不重读就会一直挂着"进行中"（轮次也是每轮变的）
            void refreshGoal();
            
            // 注意：现在预览刷新由 preview_ready 事件触发，这里不再需要刷新
            
            // 每次消息完成后都刷新 skipped_by_restore 标记
            // 这样无论是 AI 触发的版本恢复，还是用户手动切换版本后再对话，都能正确更新
            if (projectId) {
              setTimeout(() => {
                updateSkippedMarks(projectId);
              }, 500);
            }
          } else if (event.type === "commit") {
            // Git commit 完成，更新 commit_hash
            if (event.commit_hash) {
              applyMessages((prev) =>
                prev.map((msg) =>
                  msg.id === aiMessageId
                    ? { ...msg, commit_hash: event.commit_hash }
                  : msg
              )
            );
              console.log(`📝 版本已保存: ${event.commit_hash}`);
            }
          } else if (event.type === "build_start") {
            // 后端即将开始构建（或跳过构建直接切换预览）
            // 此时通知父组件显示 loading（比 stats 时更精准）
            console.log("🔨 开始构建/切换预览");
            onBuildStart?.();
          } else if (event.type === "preview_ready") {
            // 预览构建完成（热更新模式下不需要手动刷新，Vite 会自动更新）
            console.log("🔨 预览构建完成");
            // 清除之前的 build 错误（如果有）
            setBuildError(null);
            // 通知父组件预览已就绪（用于静态模式刷新预览）
            // 优先使用事件中的版本号（来自 build_project_check 的即时刷新）
            // 否则使用 pendingNewVersionRef（来自最后的自动 build）
            const versionToUse = event.version || pendingNewVersionRef.current;
            if (versionToUse) {
              onPreviewReady?.(versionToUse);
              pendingNewVersionRef.current = null;  // 清除，避免重复触发
            }
          } else if (event.type === "build_error") {
            // 构建失败，显示错误提示
            console.log("❌ 构建失败:", event.error);
            setBuildError(event.error || "构建失败，未知错误");
          } else if (event.type === "restore_confirm") {
            // 版本恢复确认请求 - 添加到消息的 events 中，在聊天气泡内显示
            console.log("🔄 收到 restore_confirm 事件:", event);
            if (event.confirm_data) {
              console.log("🔄 confirm_data:", event.confirm_data);
              applyMessages((prev) =>
                prev.map((msg) =>
                  msg.id === aiMessageId
                    ? {
                        ...msg,
                        events: [
                          ...(msg.events || []),
                          {
                            type: "restore_confirm" as const,
                            confirmData: event.confirm_data,
                            confirmed: false,
                          },
                        ],
                      }
                    : msg
                )
              );
            } else {
              console.warn("⚠️ restore_confirm 事件没有 confirm_data");
            }
          } else if (event.type === "version_restored") {
            // 版本恢复成功
            console.log(`✅ 版本已恢复到: ${event.version}`);
            // 刷新预览面板
            onRefreshPreview?.();
            // 重置历史版本状态
            onVersionChange?.(null);
            // 延迟更新 skipped_by_restore 标记，确保后端已保存
            if (projectId) {
              setTimeout(() => {
                updateSkippedMarks(projectId);
              }, 500);
            }
          } else if (event.type === "thinking") {
            // 把 thinking 作为事件加入 events 数组，保持位置顺序
            applyMessages((prev) =>
              prev.map((msg) => {
                if (msg.id !== aiMessageId) return msg;
                
                const events = [...(msg.events || [])];
                const lastEvent = events[events.length - 1];
                
                // 如果上一个事件也是 thinking，合并内容（同一个 thinking 块的流式输出）
                if (lastEvent?.type === "thinking") {
                  events[events.length - 1] = {
                    ...lastEvent,
                    content: (lastEvent.content || "") + event.content
                  };
                } else {
                  // 否则新建一个 thinking 事件
                  events.push({
                    type: "thinking" as const,
                    content: event.content
                  });
                }
                
                return { ...msg, events };
              })
            );
          } else if (event.type === "error") {
            applyMessages((prev) =>
              prev.map((msg) =>
                msg.id === aiMessageId
                  ? { ...msg, content: `错误: ${event.message}`, error: true }
                  : msg
              )
            );
          } else if (event.type === "subagent") {
            // 子代理/后台任务的状态与流式内容 → 顶部状态栏
            setSubagents((prev) => reduceSubagents(prev, event as never));
          } else if (event.type === "interrupted") {
            // 用户终止生成，标记为中断状态（也显示继续/重试按钮）
            applyMessages((prev) =>
              prev.map((msg) =>
                msg.id === aiMessageId
                  ? { ...msg, interrupted: true }
                  : msg
              )
            );
          } else if (event.type === "locked") {
            // 项目被锁定（其他人正在生成）
            applyMessages((prev) =>
              prev.map((msg) =>
                msg.id === aiMessageId
                  ? { ...msg, content: `⏳ ${event.content || "项目正在生成中，请稍候再试"}`, error: true }
                  : msg
              )
            );
            setIsLoading(false);
          }
        }
      );
    } catch (error) {
      console.error("发送消息失败:", error);
      // 错误也要写进**这个会话的**镜像，别糊到用户正在看的别的会话上
      applyMessages((prev) =>
        prev.map((msg) =>
          msg.id === aiMessageId
            ? { ...msg, content: `发送失败: ${error}`, error: true }
            : msg
        )
      );
    } finally {
      // 回合结束 → 服务端历史已经是权威（这一轮已写进去），镜像退休。
      // 放在清 running 之前，保证切回来时走 loadHistory 拿到完整结果。
      if (messagesMirrorRef.current.project === streamProject) {
        messagesMirrorRef.current = { project: "\u0000none", list: [] };
      }
      // ⚠️ 清 running 标记必须在 finally 里、且**不看 stillViewing** ——
      //    用户切走之后这个回合结束了，标记必须清掉，否则切回来会一直显示「生成中」。
      setRunningProjects((prev) => {
        const next = new Set(prev);
        next.delete(streamProject);
        return next;
      });
      setIsLoading(false);
    }
  };

  // 拉历史子代理（A3）—— 否则刷新之后顶栏空着，之前跑过的就点不进去了。
  // 实时的那些由 SSE 事件驱动，这里只补「已经落盘的」。
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    // ⚠️ 先**清空**：子代理状态是全局的，切会话时必须整个换掉，
    //    否则 A 会话的子代理会一直挂在 B 会话的顶栏上（实测踩过）。
    setSubagents([]);
    setViewing(null);          // 正在看的子代理也属于上一个会话
    void listSubagents(projectId)
      .then((list) => {
        if (!alive || list.length === 0) return;
        setSubagents(list.map((s) => ({
          key: s.id, id: s.id, label: s.label, background: s.background,
          parentId: s.parentId || undefined,      // A5 树的父子关系
          status: s.status === "error" ? "error" : "done",
          steps: [], stepCount: 0,
        })));
      })
      .catch(() => { /* 拉不到就算了，不影响实时通道 */ });
    return () => { alive = false; };
  }, [projectId]);

  /** 发新消息前：保留还在跑的子代理，清掉上一轮的已完成项 */
  const pruneSubagents = () => {
    setSubagents((prev) => (prev.length === 0 ? prev : prev.filter((a) => a.status === "running")));
  };

  const handleActionClick = (action: string) => {
    if (settings.suggestionAutoSend) {
      // 自动发送
      handleSend(action);
    } else {
      // 填入输入框
      setInput(action);
    }
  };

  const handleAskUserSubmit = async (messageId: string, answer: string | string[]) => {
    // 标记该消息的 askUser 已回复，并保存用户的回复
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId && msg.askUser
          ? { ...msg, askUser: { ...msg.askUser, answered: true, userAnswer: answer } }
          : msg
      )
    );

    // 提交用户输入到后端（多选时转为 JSON 字符串）
    const answerToSubmit = Array.isArray(answer) ? JSON.stringify(answer) : answer;
    if (currentSessionId.current) {
      try {
        await submitUserInput(currentSessionId.current, answerToSubmit);
        console.log("用户输入已提交:", answerToSubmit);
      } catch (error) {
        console.error("提交用户输入失败:", error);
      }
    }
  };

  const handleClearChat = () => {
    setMessages([]);
  };

  // 处理版本切换
  const handleVersionClick = async (commitHash: string, versionNumber: number) => {
    // 生成过程中或正在切换版本时不允许再次切换
    if (isLoading || isSwitchingVersion) {
      console.log("⚠️ 生成过程中或正在切换版本，不能切换版本");
      return;
    }
    
    if (!projectId) return;
    
    setIsSwitchingVersion(true);
    onSwitchingVersionChange?.(true);
    try {
      // 如果是最新版本，不需要设置预览版本（使用热更服务器）
      const isLatest = versionNumber === latestVersion;
      
      if (!isLatest) {
      // 设置预览版本（使用缓存的构建结果）
        const result = await setPreviewVersion(projectId, versionNumber);
        
        // 检查是否有构建错误
        if (!result.success && result.error) {
          console.error("版本构建失败:", result.error);
          // 设置构建错误状态
          setBuildError(result.error);
        } else {
          // 构建成功，清除之前的错误
          setBuildError(null);
          onClearBuildError?.();
        }
      } else {
        // 最新版本，清除预览版本设置
        await setPreviewVersion(projectId, null);
        // 清除之前的错误
        setBuildError(null);
        onClearBuildError?.();
      }
      
      // 切换版本时清除运行时错误
      onClearRuntimeError?.();
      
      // 切换代码版本
      await switchVersion(commitHash, projectId);
      console.log(`已切换到版本 ${versionNumber} (${commitHash})`);
      
      // 通知父组件当前在历史版本（最新版本传 null）
      onVersionChange?.(isLatest ? null : versionNumber);
      
      // 刷新 iframe 预览
      onRefreshPreview?.();
    } catch (error) {
      console.error("切换版本失败:", error);
    } finally {
      setIsSwitchingVersion(false);
      onSwitchingVersionChange?.(false);
    }
  };

  const handleStop = async () => {
    try {
      // 只停当前会话 —— 别的会话可能也在跑（多会话并行）
      await stopGeneration(projectId);
      setIsLoading(false);
      console.log("已发送终止请求");
    } catch (error) {
      console.error("终止请求失败:", error);
    }
  };

  // 重试（重新发送用户消息）
  // 注：临时分支在失败/中断时已由后端自动丢弃
  const handleRetry = () => {
    // 找到最后一条用户消息，用于重新发送
    const lastUserMessage = [...messages].reverse().find(m => m.role === "user");
    const retryContent = lastUserMessage?.content || "";
    
    // 移除最后一条 AI 消息（错误/中断的）
    setMessages(prev => {
      const newMessages = [...prev];
      for (let i = newMessages.length - 1; i >= 0; i--) {
        if (newMessages[i].role === "assistant" && (newMessages[i].error || newMessages[i].interrupted)) {
          newMessages.splice(i, 1);
          break;
        }
      }
      return newMessages;
    });
    
    // 自动重新发送用户消息
    if (retryContent) {
      setTimeout(() => {
        handleSend(retryContent);
      }, 100);
    }
  };

  const handleUserInputSubmit = async (answer: string) => {
    if (!userInputDialog.sessionId) {
      console.error("没有会话 ID");
      return;
    }

    try {
      await submitUserInput(userInputDialog.sessionId, answer);
      console.log("用户输入已提交:", answer);
      
      // 关闭对话框
      setUserInputDialog({
        open: false,
        question: "",
        suggestions: undefined,
        sessionId: undefined,
      });
    } catch (error) {
      console.error("提交用户输入失败:", error);
      alert(`提交失败: ${error}`);
    }
  };

  // 处理版本恢复确认（内联组件版本）
  const handleRestoreConfirmInline = async (messageId: string) => {
    if (!currentSessionId.current) {
      console.error("没有会话 ID");
      return;
    }

    // 更新消息状态，标记为已确认
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? {
              ...msg,
              events: msg.events?.map((e) =>
                e.type === "restore_confirm"
                  ? { ...e, confirmed: true, userChoice: "confirm" as const }
                  : e
              ),
            }
          : msg
      )
    );

    try {
      await submitUserInput(currentSessionId.current, "确认");
      console.log("用户确认恢复版本");
    } catch (error) {
      console.error("提交确认失败:", error);
      alert(`提交失败: ${error}`);
    }
  };

  // 处理版本恢复取消（内联组件版本）
  const handleRestoreCancelInline = async (messageId: string) => {
    // 更新消息状态，标记为已取消
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? {
              ...msg,
              events: msg.events?.map((e) =>
                e.type === "restore_confirm"
                  ? { ...e, confirmed: true, userChoice: "cancel" as const }
                  : e
              ),
            }
          : msg
      )
    );

    if (currentSessionId.current) {
      try {
        await submitUserInput(currentSessionId.current, "取消");
        console.log("用户取消恢复版本");
      } catch (error) {
        console.error("提交取消失败:", error);
      }
    }
  };

  // 处理截图提交（内嵌组件版本）
  const handleScreenshotSubmitInline = async (messageId: string, sessionId: string, screenshot: string) => {
    // 更新消息状态，标记为已提交
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? {
              ...msg,
              events: msg.events?.map((e) =>
                e.type === "screenshot_request" && e.sessionId === sessionId
                  ? { ...e, submitted: true, screenshot }
                  : e
              ),
            }
          : msg
      )
    );

    try {
      // 提交截图结果给后端
      await submitBrowserResult(
        sessionId,
        "capture_screenshot",
        { screenshot, user_assisted: true }
      );
      console.log("✅ 用户协助截图已提交");
    } catch (error) {
      console.error("提交截图失败:", error);
      alert(`提交失败: ${error}`);
    }
  };

  // 处理截图取消（内嵌组件版本）
  const handleScreenshotCancelInline = async (sessionId: string) => {
    // 更新消息状态，标记为已取消
    setMessages((prev) =>
      prev.map((msg) => ({
        ...msg,
        events: msg.events?.map((e) =>
          e.type === "screenshot_request" && e.sessionId === sessionId
            ? { ...e, cancelled: true }
            : e
        ),
      }))
    );

    try {
      // 发送取消信号给后端
      await submitBrowserResult(
        sessionId,
        "capture_screenshot",
        { error: "用户取消了截图" }
      );
      console.log("⚠️ 用户取消了截图");
    } catch (error) {
      console.error("提交取消信号失败:", error);
    }
  };

  // 判断是否为紧凑模式（无版本且无消息）
  // 三栏布局下对话区始终占满整列，不再需要浮动紧凑卡片
  const isCompactMode = false;
  // 判断是否需要居中内容（有消息但无版本，内容不要撑太开）
  const shouldCenterContent = latestVersion === 0 && messages.length > 0;

  // ── 斜杠命令：/plan 开关 + /goal ────────────────────────
  // 斜杠菜单只认「第一行、以 / 开头、还没打空格」的查询词（见 slash-menu.tsx 的 slashQuery），
  // 所以带参数的写法**匹配不到**：
  //   · /plan  → **一条命令做开关**：不在计划模式时叫「计划模式」，在的时候叫「退出计划模式」
  //   · /goal  → 没目标时"接着写"（insert "/goal "，用户补描述）；已有目标时只报现状。
  //             带参数的那半边（/goal pause、/goal clear…）走发送路径的 runGoalCommand ——
  //             菜单和提交本来就是两段，别指望菜单能匹配到空格后面的内容。
  const slashCommands = useMemo<SlashCommand[]>(() => [
    planMode
      ? {
          name: "plan",
          title: "退出计划模式",
          description: "关掉硬只读，写类工具恢复可用",
          hint: "Enter 执行",
          keywords: ["plan", "jihua", "exit"],
        }
      : {
          name: "plan",
          title: "计划模式",
          description: "先调研、出计划、等你批准再动手",
          hint: "Enter 执行",
          keywords: ["plan", "jihua"],
        },
    goal
      ? {
          name: "goal",
          title: `目标：${truncateGoal(goal.objective, 24)}`,
          description: goal.phase === "active"
            ? "再次输入 /goal <新目标> 不会覆盖，先 /goal clear"
            : `${goalPhaseLabel(goal.phase)} · /goal resume 继续，/goal clear 清除`,
          hint: "查看",
          keywords: ["goal", "mubiao", "目标"],
        }
      : {
          name: "goal",
          title: "设定长期目标",
          description: "跨多轮自动推进；做完/卡住由它来管",
          hint: "继续输入",
          insert: "/goal ",
          keywords: ["goal", "mubiao", "目标"],
        },
  ], [planMode, goal]);

  // ── 新会话页的斜杠命令 ──────────────────────────────────
  // 那里还没有线程：/plan 只能存**草稿**（建项目时由 App 落地），
  // /goal 必须先有任务 —— 直接说清楚，不假装能设。
  const toggleDraftPlan = () => {
    const next = !draftPlan;
    setDraftPlan(next);
    writeDraftPlanMode(next);
    toast(next
      ? { title: "新任务将以计划模式开始", description: "先调研、出计划，等你批准再动手", tone: "info" }
      : { title: "已取消计划模式", description: "新任务直接动手", tone: "default" });
  };

  const startCommands = useMemo<SlashCommand[]>(() => [
    draftPlan
      ? { name: "plan", title: "取消计划模式（新任务）", description: "新任务将直接动手，不再先出计划", hint: "Enter 执行", keywords: ["plan", "jihua"] }
      : { name: "plan", title: "计划模式（新任务）", description: "新任务先调研、出计划、等你批准再动手", hint: "Enter 执行", keywords: ["plan", "jihua"] },
    { name: "goal", title: "设定长期目标", description: "跨多轮自动推进；建好任务后自动生效", hint: "继续输入", insert: "/goal ", keywords: ["goal", "mubiao", "目标"] },
  ], [draftPlan]);

  const handleStartSlashCommand = (cmd: SlashCommand) => {
    if (cmd.name === "plan") { toggleDraftPlan(); return; }
    // /goal 只把输入框置成 "/goal "（命令的 insert），接着写目标描述即可：
    // 落地分两步 —— submitStartDraft 存草稿，App.handleCreateProject 建任务时写进内核。
  };

  /** 开 / 关计划模式（就是 POST /permission 的 planMode 位），并给一句明确反馈 */
  const applyPlanMode = (on: boolean) => {
    void changePlanMode(on);
    toast(on
      ? { title: "已进入计划模式", description: "描述你的任务，我会先给计划", tone: "info" }
      : { title: "已退出计划模式", description: "写类工具已恢复，可以直接动手", tone: "default" });
  };

  const handleSlashCommand = (cmd: SlashCommand) => {
    if (cmd.name === "plan") { applyPlanMode(!planMode); return; }
    if (cmd.name === "goal") {
      // 没目标时不用做事：输入框已经被置成 "/goal "（命令的 insert），用户接着写描述就行。
      // 已有目标时只把现状说清楚 —— 选中一条命令不该顺手改掉别人的目标，改要显式 /goal clear。
      if (goal) {
        toast({
          title: `目标 · ${goalPhaseLabel(goal.phase)}`,
          description: `${truncateGoal(goal.objective, 80)} · ${goalSummary(goal)}`,
          tone: "info",
        });
      }
      return;
    }
  };

  /** 左下角 chip 的「点击退出」和斜杠命令走同一条路 */
  const exitPlanMode = () => applyPlanMode(false);

  // 没选任务时的起始页：居中一个输入框，直接说话就开工（对齐 codex / DSH）
  if (!projectId) {
    return (
      <div className="flex h-full flex-col bg-surface-raised">
        {/* 欢迎语占满剩余空间并居中；输入框**贴底** —— 对齐 DSH / codex 的形态 */}
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="text-center">
            <img
              src="/dove-icon.png"
              alt="Dove"
              className="mx-auto size-10 rounded-md"
              draggable={false}
            />
            <h1 className="mt-3 text-sm font-bold text-text-primary">开始一个新任务</h1>
          </div>
        </div>

        {/* 输入区：贴底（留出和侧栏一致的下边距） */}
        <div className="px-6 pb-6">
          <div className="mx-auto w-full max-w-[640px]">
            {/* ⚠️ 这张卡片**不能加 overflow-hidden**：斜杠菜单浮在输入框上方，
                一旦被裁就只剩半行（实测踩过）。圆角靠子元素自身不需要裁剪。 */}
            <div className="flex flex-col rounded-2xl border border-border-default bg-surface-raised shadow-sm transition-[border-color,box-shadow] duration-fast focus-within:border-accent-ring focus-within:shadow-focus">
              {/* 左上角：项目 / 文件夹选择 */}
              <div className="flex items-center gap-1.5 px-2.5 pt-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-text-secondary transition-colors duration-fast hover:bg-[rgb(var(--nb-75))] hover:text-text-primary"
                    >
                      <FolderOpen className="size-3.5" />
                      <span className="max-w-[13rem] truncate">{draftProject || "选择项目"}</span>
                      <ChevronDown className="size-3 text-text-tertiary" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    <DropdownMenuLabel>工作目录</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => onDraftProjectChange?.(null)}>
                      <Plus />
                      不使用项目（自动建文件夹）
                    </DropdownMenuItem>
                    {projects.filter((p) => (p.project || "").trim()).length > 0 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>已有项目</DropdownMenuLabel>
                        {[...new Set(projects.map((p) => (p.project || "").trim()).filter(Boolean))].map(
                          (name) => (
                            <DropdownMenuItem key={name} onSelect={() => onDraftProjectChange?.(name)}>
                              <FolderOpen />
                              {name}
                            </DropdownMenuItem>
                          )
                        )}
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onChooseFolder?.()}>
                      <HardDrive />
                      选择项目…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              

              <ComposerBox
                autoFocus
                value={startDraft}
                onChange={setStartDraft}
                onSubmit={submitStartDraft}
                sendDisabled={!startDraft.trim()}
                sendTitle="创建任务并开始"
                placeholder={NEW_TASK_PLACEHOLDER}
                hint="Enter 开始 · Shift+Enter 换行"
                commands={startCommands}
                onSlashCommand={handleStartSlashCommand}
                leftActions={
                  <>
                    {/* 新会话页还没有项目，所以这里配的是**新项目的默认权限**，
                        存 localStorage，建项目时写进线程 metadata。 */}
                    <PermissionSelect
                      surface="defaults"
                      value={permission}
                      onChange={(m) => void changePermission(m)}
                    />
                    {/* 计划模式草稿：点一下取消；建项目时落地，见 App.handleCreateProject */}
                    {draftPlan && (
                      <button
                        type="button"
                        title="取消：新任务不再以计划模式开始"
                        aria-label="取消计划模式"
                        onClick={toggleDraftPlan}
                        className="group flex h-7 items-center gap-1 rounded-full bg-surface-inset px-2 text-2xs text-text-secondary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
                      >
                        <ClipboardList className="size-3 group-hover:hidden" />
                        <XCircle className="hidden size-3 group-hover:block" />
                        <span>计划模式（新任务）</span>
                      </button>
                    )}
                    {/* 目标草稿：建好任务后会自动落地，这里只显示它存在 + 一个图标式清除 */}
                    {draftGoal && (
                      <span className="flex h-7 min-w-0 items-center gap-1 rounded-full bg-surface-inset px-2 text-2xs text-text-secondary">
                        <Target className="size-3 shrink-0 text-text-tertiary" />
                        <span className="max-w-[12rem] truncate" title={"目标：" + draftGoal}>目标：{draftGoal}</span>
                        <button
                          type="button"
                          title="取消这个目标"
                          aria-label="取消这个目标"
                          onClick={() => { clearDraftGoal(); setDraftGoal(null); }}
                          className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    )}
                  </>
                }
                className="rounded-none border-0 bg-transparent shadow-none focus-within:border-transparent focus-within:shadow-none"
              />
            </div>


          </div>
        </div>
      </div>
    );
  }

  // A4：切到子代理视图。它是**独立视图 + 面包屑**（对齐 DSH 的 Session hierarchy），
  // 不是弹窗 —— 这样过程记录有整块空间，长内容也读得下去。
  if (viewing && projectId) {
    const live = subagents.find((a) => a.id === viewing.id);
    return (
      <SubagentView
        projectKey={projectId}
        subagentId={viewing.id}
        label={viewing.label}
        running={live?.status === "running"}
        liveSteps={live?.steps ?? []}
        onBack={() => setViewing(null)}
      />
    );
  }

  return (
    <div className={`flex h-full flex-col overflow-hidden bg-surface-raised transition-all duration-normal ease-emphasized ${isCompactMode ? 'items-center justify-center' : ''}`}>
      {/* 紧凑模式的内部容器 */}
      <div className={`transition-all duration-300 ease-out ${isCompactMode ? 'w-full max-w-[540px] aspect-[9/4] flex flex-col border border-border/50 shadow-lg rounded-lg overflow-hidden' : 'contents'}`}>
      {/* 顶部标题栏 */}
      <div className="pane-header justify-between">
        {/* 左侧：当前任务名（过长省略） */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium text-text-primary">
            {projects.find((p) => p.port === projectId)?.display_name ||
              projects.find((p) => p.port === projectId)?.name_text ||
              `任务 ${projectId}`}
          </span>
        </div>
        {/* 右侧：预览区开关（常驻，收起时是"展开"） */}
        {asideCollapsed && onToggleAside && (
          <Hint label="展开预览区" shortcut="⌘⇧P">
            <button
              type="button"
              aria-label="展开预览区"
              onClick={onToggleAside}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors duration-fast hover:bg-[rgb(var(--nb-75))] hover:text-text-primary"
            >
              <PanelRightOpen className="size-4" />
            </button>
          </Hint>
        )}

        {/* 右侧：其他操作按钮 */}
        <div className="flex items-center gap-1">
          
        </div>
      </div>

      {/* 子代理状态栏：常驻在消息列表上方，点标签看每个子代理的实时输出 */}
      {!isCompactMode && (
        <SubagentBar
          agents={subagents}
          onClearDone={() => setSubagents((prev) => prev.filter((a) => a.status === "running"))}
          onOpen={(a) => setViewing({ id: a.id, label: a.label })}
        />
      )}

      {/* 消息列表 - 紧凑模式时隐藏 */}
      <div 
        ref={messagesContainerRef}
        className={`overflow-y-auto transition-all duration-300 ease-out ${isCompactMode ? 'flex-[0] opacity-0' : 'flex-1 opacity-100'}`}
        onScroll={handleScroll}
      >
        {!isCompactMode && (
          <div className={`transition-all duration-300 ${shouldCenterContent ? 'max-w-2xl mx-auto' : ''}`}>
            <div className="mx-auto flex min-h-0 w-full max-w-[880px] flex-1 flex-col px-6">
              <MessageList
                messages={messages}
                onActionClick={handleActionClick}
                isLoading={isLoading}
                isSwitchingVersion={isSwitchingVersion}
                showLogs={false}
                onAskUserSubmit={handleAskUserSubmit}
                onVersionClick={handleVersionClick}
                onRestoreConfirm={handleRestoreConfirmInline}
                onRestoreCancel={handleRestoreCancelInline}
                onScreenshotSubmit={handleScreenshotSubmitInline}
                onScreenshotCancel={handleScreenshotCancelInline}
                onRetry={handleRetry}
                onOpenFile={onOpenFile}
              />
            </div>
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Build 错误提示（合并内部错误和外部错误） */}
      {(buildError || externalBuildError) && (
        <div className="px-3 py-2 bg-destructive/10 border-t border-destructive/20">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-medium text-destructive shrink-0">构建错误</span>
              <span className="text-xs text-muted-foreground truncate">当前版本存在构建错误，可能影响网站发布</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <details className="relative">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground px-2 py-1">
                  详情
                </summary>
                <div className="absolute bottom-full right-0 mb-1 w-[300px] p-2 bg-popover border rounded-md shadow-lg z-50">
                  <pre className="text-[10px] overflow-auto max-h-[200px] whitespace-pre-wrap break-all text-muted-foreground">
{buildError || externalBuildError}
                  </pre>
                </div>
              </details>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setBuildError(null);
                  onClearBuildError?.();
                }}
              >
                忽略
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  // 构造修复消息并直接发送
                  const errorToFix = buildError || externalBuildError;
                  const fixMessage = `请修复以下构建错误：\n\n\`\`\`\n${errorToFix}\n\`\`\``;
                  setBuildError(null);
                  onClearBuildError?.();
                  // 直接调用发送逻辑
                  handleSend(fixMessage);
                }}
                disabled={isLoading}
              >
                修复
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 运行时错误提示 */}
      {externalRuntimeError && (
        <div className="px-3 py-2 bg-orange-500/10 border-t border-orange-500/20">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-medium text-orange-600 shrink-0">运行时错误</span>
              <span className="text-xs text-muted-foreground truncate">页面存在运行时错误，可能导致白屏或功能异常</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <details className="relative">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground px-2 py-1">
                  详情
                </summary>
                <div className="absolute bottom-full right-0 mb-1 w-[350px] p-2 bg-popover border rounded-md shadow-lg z-50">
                  <pre className="text-[10px] overflow-auto max-h-[200px] whitespace-pre-wrap break-all text-muted-foreground">
{externalRuntimeError}
                  </pre>
                </div>
              </details>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onClearRuntimeError?.();
                }}
              >
                忽略
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-7 text-xs bg-orange-600 hover:bg-orange-700"
                onClick={() => {
                  // 构造修复消息并直接发送
                  const fixMessage = `页面出现运行时错误，请检查并修复：\n\n\`\`\`\n${externalRuntimeError}\n\`\`\``;
                  onClearRuntimeError?.();
                  // 直接调用发送逻辑
                  handleSend(fixMessage);
                }}
                disabled={isLoading}
              >
                修复
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 输入区域 - 紧凑模式时撑满剩余空间，紧凑模式隐藏分割线 */}
      <div className={`shrink-0 px-6 pb-4 pt-1 transition-all duration-normal ease-emphasized ${isCompactMode ? 'flex flex-1 flex-col' : ''} ${shouldCenterContent ? 'flex justify-center' : ''}`}>
        <div className={`transition-all duration-300 ${shouldCenterContent ? 'w-full max-w-2xl' : 'contents'}`}>
        {/* 附件预览 */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-inset px-2 py-1 text-2xs text-text-secondary"
              >
                <FileIcon className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="max-w-[150px] truncate">{file.name}</span>
                <button
                  onClick={() => removeAttachment(file.id)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        
        <div className={`relative ${isCompactMode ? 'flex flex-1 flex-col' : ''}`}>
          {/* 隐藏的文件输入（附件按钮在 ComposerBox 的 leftActions 插槽里） */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* 输入卡片 —— 和起始页**同一个 ComposerBox**（结构 / 发送按钮 / 斜杠菜单只有一份）。
              项目页多出来的东西（附件 / 权限 / 计划模式 / 设置 / 朗读）全走 leftActions 插槽，
              长期目标状态条走 topLeft 插槽 —— 没有目标时 GoalBar 自己返回 null，不占位置。 */}
          <ComposerBox
            value={input}
            onChange={setInput}
            onSubmit={() => handleSend()}
            placeholder={COMPOSER_PLACEHOLDER}
            hint="Enter 发送 · Shift+Enter 换行"
            sending={isLoading}
            onStop={handleStop}
            commands={slashCommands}
            onSlashCommand={handleSlashCommand}
            topLeft={goal ? <GoalBar goal={goal} pending={goalPending} onAction={runGoalBarAction} /> : undefined}
            className="mx-auto w-full max-w-[880px] rounded-xl"
            textareaClassName={isCompactMode ? 'min-h-0 flex-1' : undefined}
            leftActions={
              <>
                {/* 计划模式 chip：只在开启时出现；点一下 = POST planMode:false */}
                {planMode && (
                  <button
                    type="button"
                    title="退出计划模式"
                    aria-label="退出计划模式"
                    onClick={exitPlanMode}
                    className="group flex h-7 items-center gap-1 rounded-full bg-surface-inset px-2 text-2xs text-text-secondary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
                  >
                    {/* 常态是计划图标，悬停换成"取消"圈 —— 对齐 DSH 的 PlanChip（rest / hover 两个 glyph），
                        文字只说状态，不写"点击退出" */}
                    <ClipboardList className="size-3 group-hover:hidden" />
                    <XCircle className="hidden size-3 group-hover:block" />
                    <span>计划模式</span>
                  </button>
                )}


            {/* 附件上传按钮 */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading || !projectId}
              className="flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full transition-colors disabled:opacity-50"
              title="上传附件 (最大 20MB)"
            >
              {isUploading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Paperclip className="w-3.5 h-3.5" />
              )}
            </button>
            
            
            {/* 权限模式 —— 和新会话页**同一个组件** */}
            <PermissionSelect
              surface="session"
              value={permission}
              onChange={(m) => void changePermission(m)}
              disabled={!projectId}
            />

            {/* 设置按钮 */}
            <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="设置"
                  title="设置"
                  className="flex size-7 items-center justify-center rounded-full text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary"
                >
                  <Settings2 className="size-3.5" />
                </button>
              </PopoverTrigger>
            <PopoverContent className="w-64 p-3" align="start" side="top">
              <div className="space-y-4">
                {/* 模型选择 */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">Model</Label>
                  <div className="space-y-1">
                    {MODEL_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => updateSettings({ model: option.value })}
                        className={`w-full flex items-center justify-between px-3 py-2 text-sm rounded-md transition-colors ${
                          settings.model === option.value
                            ? "bg-primary/10 text-primary"
                            : "hover:bg-muted"
                        }`}
                      >
                        <span>{option.label}</span>
                        {settings.model === option.value && (
                          <Check className="w-4 h-4" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Think 开关 */}
                <div className="flex items-center justify-between">
                  <Label htmlFor="thinking-switch" className="text-xs font-medium text-muted-foreground">
                    Enable Thinking
                  </Label>
                  <Switch
                    id="thinking-switch"
                    checked={settings.enableThinking}
                    onCheckedChange={(checked) => updateSettings({ enableThinking: checked })}
                  />
                </div>

                {/* 连续对话模式开关 */}
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="continuous-chat-switch" className="text-xs font-medium text-muted-foreground">
                      Continuous Chat
                    </Label>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">使用完整对话历史</p>
                  </div>
                  <Switch
                    id="continuous-chat-switch"
                    checked={settings.continuousChat}
                    onCheckedChange={(checked) => updateSettings({ continuousChat: checked })}
                  />
                </div>

                {/* 记忆模式开关 */}
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="memory-switch" className="text-xs font-medium text-muted-foreground">
                      Memory
                    </Label>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">携带长期记忆</p>
                  </div>
                  <Switch
                    id="memory-switch"
                    checked={settings.enableMemory}
                    onCheckedChange={(checked) => updateSettings({ enableMemory: checked })}
                  />
                </div>

                {/* 推荐文件开关 - 只在非 Full Chat 模式下显示 */}
                {!settings.continuousChat && (
                  <div className="flex items-center justify-between">
                    <div>
                      <Label htmlFor="recommend-files-switch" className="text-xs font-medium text-muted-foreground">
                        Recommend Files
                      </Label>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">AI 推荐相关文件</p>
                    </div>
                    <Switch
                      id="recommend-files-switch"
                      checked={settings.enableRecommendFiles}
                      onCheckedChange={(checked) => updateSettings({ enableRecommendFiles: checked })}
                    />
                  </div>
                )}

                {/* 分割线 */}
                <div className="border-t border-border my-2" />

                {/* 语音朗读开关 */}
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="speech-switch" className="text-xs font-medium text-muted-foreground">
                      Voice Reading
                    </Label>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">流式语音朗读</p>
                  </div>
                  <Switch
                    id="speech-switch"
                    checked={speechSynthesis.isEnabled}
                    onCheckedChange={(checked) => speechSynthesis.setEnabled(checked)}
                  />
                </div>

                {/* 语音设置（仅在启用时显示） */}
                {speechSynthesis.isEnabled && (
                  <>
                    {/* 音量调节 */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-medium text-muted-foreground">
                          音量: {Math.round(speechSynthesis.settings.volume * 100)}%
                        </Label>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.1"
                        value={speechSynthesis.settings.volume}
                        onChange={(e) => speechSynthesis.updateSettings({ volume: parseFloat(e.target.value) })}
                        className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                      />
                    </div>

                    {/* 语音选择 */}
                    {speechSynthesis.voices.length > 0 && (
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground">语音</Label>
                        <select
                          value={speechSynthesis.currentVoice?.voice_id || ''}
                          onChange={(e) => speechSynthesis.setVoice(e.target.value)}
                          className="w-full px-2 py-1.5 text-xs bg-muted rounded-md border-0 focus:ring-1 focus:ring-primary"
                        >
                          {speechSynthesis.voices.map((voice) => (
                            <option key={voice.voice_id} value={voice.voice_id}>
                              {voice.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </>
                )}
              </div>
            </PopoverContent>
            </Popover>
            
            {/* 语音控制按钮（朗读时显示） */}
            {speechSynthesis.isEnabled && speechSynthesis.isSpeaking && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => speechSynthesis.isPaused ? speechSynthesis.resume() : speechSynthesis.pause()}
                  className="flex items-center justify-center w-7 h-7 text-accent hover:bg-accent-subtle rounded-full transition-colors"
                  title={speechSynthesis.isPaused ? "继续朗读" : "暂停朗读"}
                >
                  {speechSynthesis.isPaused ? (
                    <Play className="w-3.5 h-3.5" />
                  ) : (
                    <Pause className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => speechSynthesis.stop()}
                  className="flex items-center justify-center w-7 h-7 text-accent hover:bg-accent-subtle rounded-full transition-colors"
                  title="停止朗读"
                >
                  <Square className="w-3 h-3" />
                </button>
              </div>
            )}
              </>
            }
          />
        </div>
        </div>{/* shouldCenterContent 内部容器闭合 */}
      </div>

      {/* 用户输入对话框 */}
      <UserInputDialog
        open={userInputDialog.open}
        question={userInputDialog.question}
        suggestions={userInputDialog.suggestions}
        onSubmit={handleUserInputSubmit}
        onClose={() =>
          setUserInputDialog({
            open: false,
            question: "",
            suggestions: undefined,
            sessionId: undefined,
          })
        }
      />

      {/* 提示词替换弹窗 */}
      <PromptReplacementDialog
        open={promptReplacementDialogOpen}
        onOpenChange={setPromptReplacementDialogOpen}
      />

      {/* Clear Dove Cloud 确认对话框 */}
      <Dialog open={clearCloudDialogOpen} onOpenChange={setClearCloudDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-danger">
              <AlertTriangle className="h-5 w-5" />
              Clear Dove Cloud
            </DialogTitle>
            <DialogDescription className="text-left space-y-2">
              <p className="font-medium text-danger">⚠️ This is a destructive operation!</p>
              <p>This will permanently delete:</p>
              <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                <li>All database tables and their data</li>
                <li>All Edge Functions</li>
              </ul>
              <p className="text-sm text-muted-foreground mt-2">
                This action cannot be undone. Make sure you have a backup if needed.
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setClearCloudDialogOpen(false)}
              disabled={clearCloudLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                setClearCloudLoading(true);
                try {
                  const result = await clearDoveCloud();
                  if (result.success) {
                    alert(`✅ ${result.message}\n\nTables deleted: ${result.tables_deleted?.join(', ') || 'none'}\nFunctions deleted: ${result.functions_deleted?.join(', ') || 'none'}`);
                  } else {
                    alert(`⚠️ ${result.message}\n\nFailed tables: ${result.tables_failed?.join(', ') || 'none'}\nFailed functions: ${result.functions_failed?.join(', ') || 'none'}`);
                  }
                  setClearCloudDialogOpen(false);
                } catch (error) {
                  alert(`❌ Failed to clear Dove Cloud: ${error instanceof Error ? error.message : 'Unknown error'}`);
                } finally {
                  setClearCloudLoading(false);
                }
              }}
              disabled={clearCloudLoading}
            >
              {clearCloudLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Clearing...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete All
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 导入项目对话框 */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              导入项目
            </DialogTitle>
            <DialogDescription>
              输入远程版本号 ID，将从服务器下载并覆盖当前项目。
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={importVersionId}
              onChange={(e) => setImportVersionId(e.target.value)}
              placeholder="请输入版本号 ID"
              disabled={isImporting}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isImporting && importVersionId.trim()) {
                  handleImportProject();
                }
              }}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button 
              variant="outline" 
              onClick={() => {
                setShowImportDialog(false);
                setImportVersionId("");
              }}
              disabled={isImporting}
            >
              取消
            </Button>
            <Button 
              onClick={handleImportProject}
              disabled={isImporting || !importVersionId.trim()}
            >
              {isImporting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  导入中...
                </>
              ) : (
                "确认导入"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重置确认对话框 */}
      <Dialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              重置项目
            </DialogTitle>
            <DialogDescription>
              确定要重置吗？当前项目将被删除并重新创建，无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={cancelReset}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmReset}>
              确认重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>{/* 紧凑模式内部容器闭合 */}
    </div>
  );
}
