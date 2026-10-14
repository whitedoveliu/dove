"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, Loader2, StopCircle, DollarSign, Paperclip, X, FileIcon, Plus, Play, Download, VolumeX, Pause, Square, RotateCcw, AlertTriangle, Search, PanelRightOpen, PanelRight, FolderOpen, ChevronDown, HardDrive, ArrowUp, Shield, ShieldOff, Eye, ClipboardList, XCircle, Target, Scan, Network } from "lucide-react";
import { Hint } from "@/components/ui/tooltip";
import { IconButton } from "@/components/ui/icon-button";
import { loadSavedStyle } from "./AIStyleSelector";
import MessageList from "./MessageList";
import { SubagentBar, SubagentButtons, reduceSubagents, type SubagentInfo } from "./subagent-bar";
import { SubagentView } from "./subagent-view";
import { publishSubagents, requestOpenSubagentList } from "@/lib/subagent-feed";
import { ComposerBox, PermissionSelect } from "./composer-box";
import type { ComposerHandle } from "./composer-input";
import { DropFilesOverlay } from "./drop-overlay";
import { useSelectionQuoteMenu } from "./selection-quote-menu";
import { ComposerPlusMenu, type PlusMenuItem } from "./composer-plus-menu";
import { ComposerStatusLine, type ComposerStatusData } from "./composer-status-line";
import { ModelChip } from "./model-chip";
import { ModelSettingsButton, ModelSettingsDialog } from "./model-settings-dialog";
import { ModeChips, type ModeChipSpec } from "./mode-chip";
import { SteerQueueBar } from "./steer-queue-bar";
import { usageEntries } from "@/lib/models";
import { enqueueMessage, queueForProject, rekeyQueuedProject, removeQueuedMessage, takeQueueHead, type QueuedMessage } from "@/lib/steer-queue";
import { GoalBar } from "./goal-bar";
import { usePermissionMode, usePlanMode, readDraftPlanMode, writeDraftPlanMode } from "@/lib/permission";
import { useGoal, readDraftGoal, writeDraftGoal, clearDraftGoal } from "@/lib/goal";
import { goalPhaseLabel, goalSummary, parseGoalCommand, truncateGoal } from "@/lib/goal-command";
import { useToast, type ToastOptions } from "@/components/ui/toast";
import type { SlashCommand } from "@/components/slash-menu";
import { isExitPlanModeTool } from "@/lib/plan-mode";
import { extractPresentedFiles, isPresentTool, type PresentedFile } from "@/lib/presented-files";
import { findMessageElement } from "@/lib/message-anchor";
import { createPortal } from "react-dom";
import { PromptRail, type PromptRailItem } from "@/components/prompt-rail";
import { Message, sendChatMessage, streamFrom, captureScreen, submitUserInput, stopGeneration, steerMessage, getHistory, HistoryRecord, submitBrowserResult, switchVersion, switchToLatest, setPreviewVersion, uploadFile, UploadedFile, TodoItem, checkProjectExists, createProject, importProject, resetProject, listSubagents, getModelSettings, saveModelSettings, formatBytes, type Project, type Goal, type GoalAction, type GoalPostBody, type CaptureScreenResult, type SSEEvent } from "@/lib/api";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ConsoleLog, NetworkRequest } from "@/hooks/useDevToolsBridge";
import { useSpeechSynthesis } from "@/hooks/useSpeechSynthesis";
import PromptReplacementDialog, { getEnabledReplacements, PromptReplacement } from "./PromptReplacementDialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { mergeLogContent, sanitizeLogContent } from "@/lib/logs";

const SETTINGS_KEY = "chat_settings";

// 设置类型
/**
 * 输入框占位符 —— 定位是「通用 agent」，不是「网页生成器」。
 *
 * 原来的「做一个 SaaS 产品官网，深色科技风，含定价与 FAQ」把能力框死在建站上，
 * 用户看到会以为它只会做网页。实际上它能查资料、跑命令、写代码、做分析。
 */
const NEW_TASK_PLACEHOLDER = "交给我一件事：查资料、写代码、做分析、跑命令都行…";
const COMPOSER_PLACEHOLDER = "说点什么，或让我做点什么…";

/**
 * 面板侧的设置（`chat_settings`）—— 模型选择 + 建议自动发送。
 *
 * ⚠️ 模型**同时**存在两处，各有各的职责，别再往这里塞新的东西：
 *   · 内核（`<DOVE_CONFIG>/model.json`，见 lib/api.ts 的模型设置那一段）= 权威存储，
 *     决定内核默认用什么模型；
 *   · 这里 = 这台浏览器最后一次选的是哪个，负责「每一轮发出去的那个 model 字段」
 *     （行为和以前逐字节一致：`POST /api/chat` 的 body.model）。
 * 选一次两边一起写（见 applyModel），所以它们不会长期不一致。
 */
interface ChatSettings {
  model: string;
  suggestionAutoSend: boolean;  // 建议点击后自动发送（它一直没有 UI，沿用默认 true）
}

// 默认设置
const DEFAULT_SETTINGS: ChatSettings = {
  model: "deepseek-flash",
  suggestionAutoSend: true,  // 默认自动发送
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

/**
 * 这台浏览器**选过**模型吗？
 *
 * 用来决定启动时的对齐方向：选过 → 面板的值推到内核（用户上一版的意图不能被悄悄改掉）；
 * 没选过（第一次打开 / 新机器）→ 内核的值拉到面板（内核才是权威存储）。
 */
function hasSavedModelChoice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return false;
    const v = (JSON.parse(saved) as { model?: unknown }).model;
    return typeof v === "string" && v.trim().length > 0;
  } catch { return false; }
}

/**
 * 宿主注入的消息 —— 内核在 Swarm 轮会**多存一条**：role 是 user、正文用
 * <system-reminder>…</system-reminder> 包起来、origin 标成 injection。
 * 它不是用户说的话，回放时必须整条跳过（否则会顶着用户气泡出现在记录里）。
 * 两个判据都认：正文带包裹，或记录 / payload 上带 origin。实时流不带它，只有这条路要看。
 */
function isInjectedHistoryRecord(record: HistoryRecord): boolean {
  if (record.user.startsWith("<system-reminder>")) return true;
  const raw = record as HistoryRecord & { origin?: string; payload?: { origin?: string } };
  return raw.origin === "injection" || raw.payload?.origin === "injection";
}

// 将后端历史记录转换为前端 Message 格式
function convertHistoryToMessages(history: HistoryRecord[]): Message[] {
  const messages: Message[] = [];
  
  // 计算版本号：只有 is_modified 为 true 的记录才有版本号
  let versionCounter = 0;
  
  for (const record of history) {
    // 注入消息整条丢弃：用户气泡和 AI 气泡都不出现
    if (isInjectedHistoryRecord(record)) continue;

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
      // 这一轮改了哪些文件（**持久化回填**：兼容层把 turn_diff 按消息 id 落盘了，
      // 刷新 / 重开都还在）。每轮文件卡片优先读它，没有才退回实时的 turn_diff。
      ...(record.turn_files && record.turn_files.length > 0
        ? {
            turn_files: record.turn_files,
            turn_diff: {
              files: record.turn_files,
              truncated: record.turn_files_truncated === true,
              diff: record.turn_diff ?? "",
            },
          }
        : {}),
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
  /** Present 声明了交付物 —— App 用它把 .html 自动放到右侧浏览器标签 */
  onPresentedFiles?: (files: PresentedFile[]) => void;
  onProjectCreated?: () => void;  // 新建项目后的回调（用于刷新目录树）
  asideCollapsed?: boolean;        // 预览区是否已收起
  onToggleAside?: () => void;      // 收起/展开预览区
  /** 空状态里直接开新任务。返回 false = 任务没建起来，这句话**还在调用方手里**（要放回输入框） */
  onQuickCreateTask?: (text: string) => Promise<boolean>;
  projects?: Project[];                        // 起始页的项目选择器用
  draftProject?: string | null;                // 起始页预选的项目
  onDraftProjectChange?: (project: string | null) => void;
  onChooseFolder?: () => void;                 // 唤起系统选择框并接入项目
  /**
   * 要自动发出去的第一条消息（**带它属于哪个任务**，见 App.handleQuickCreateTask）。
   * `projectId === null` = 任务还在建 —— 那时链路上任何一次导航都可能把它收回去（App 的事）。
   */
  pendingMessage?: { projectId: string | null; text: string } | null;
  onPendingMessageConsumed?: () => void;
  /** 用户离开时被 App 收回来的那条消息（放回输入框 + 提示；token 变化 = 一次新的还原） */
  restoreDraft?: { text: string; token: number } | null;
}

/**
 * 一次**流式回合**的写入上下文。
 *
 * 为什么要有它：实时发送（handleSend 那次 POST）和重挂补看（streamFrom 的 SSE）
 * **必须共用同一套 reducer** —— 两份 reducer 的下场是两边慢慢长歪，而这两条路写出来的
 * 消息得是同一种东西。reducer 自己不认识「哪个线程」「哪条 AI 消息」「状态行怎么数」，
 * 全从这里拿（见 applyStreamEvent 开头那三行）。
 */
interface StreamTurn {
  /** 面板这一侧的线程键（端口）—— 镜像与 stillViewing 都按它认身份 */
  project: string;
  /** 这一轮写进哪条 AI 消息 */
  aiMessageId: string;
  /** 用户现在是不是正看着这个线程（切走了就一个字节都不许写） */
  stillViewing: () => boolean;
  /** 状态行：这一轮的起点与步数（重挂时起点只能是「挂上来的这一刻」，真起点早过去了） */
  turn: { project: string; startedAt: number; steps: number } | null;
  /** 本轮最后一次 tool_params —— Present 交付物要拿它和 tool_result 配对 */
  lastToolParams: { tool?: string; params?: Record<string, unknown> } | null;
}

export default function ChatPanel({ devToolsBridge, onVersionChange, onLatestVersionChange, latestVersion, projectId, onProjectSelect, onRefreshPreview, onLoadingChange, onStartDevServer, externalBuildError, onClearBuildError, externalRuntimeError, onClearRuntimeError, onSwitchingVersionChange, onPreviewReady, onBuildStart, enableHotReload, onFileModifying, onOpenFile, onPresentedFiles, onProjectCreated, onQuickCreateTask, pendingMessage, onPendingMessageConsumed, restoreDraft, asideCollapsed, onToggleAside, projects = [], draftProject, onDraftProjectChange, onChooseFolder }: ChatPanelProps) {
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
   * Swarm 模式 —— **面板侧的旗标**：内核只在发消息时收 `mode:"swarm"`（没有查询接口），
   * 所以状态放在这里。和计划模式一样"黏"：不主动关就一直开着，发下一轮也不重置。
   * 关着的时候请求体里没有这个字段（和以前逐字节一致，见 ChatRequest.mode）。
   */
  // Swarm 是**每轮**的请求状态（发送时作为 mode 字段带上）。
  // ⚠️ 但它必须**按线程**：切到别的任务要复位，否则下一个任务会莫名变成 swarm 回合、白烧 token。
  const [swarmOn, setSwarmOn] = useState(false);
  useEffect(() => {
    setSwarmOn(false);
    // 状态行也**按线程**：换任务就整个清掉 —— 上个任务的步数 / token / tok/s
    // 标在新任务上是假的（和 Swarm 旗标同一个道理）
    setStatusLine(null);
    turnRef.current = null;
  }, [projectId]);
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
   * 运行中排的队（本轮跑着的时候用户又发了几条）。
   *
   * 以前运行中发送**直接丢掉**；现在排进这里，回合结束后自动发下一条。
   * 它和「插话」是两条路：排队等整个回合跑完，插话只等这一步（step）跑完。
   * 停止（stop）不清空它 —— 排队的语义就是「这些都要发」。
   */
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  /**
   * 当前是否**有提问在等回答**。
   *
   * 为什么要有这个：AskUserQuestion 在内核里是**阻塞等待**的（默认 5 分钟超时才放行）。
   * 这段时间用户"打字回答"必须走 /api/user-input；一旦被当成"运行中插话"丢进队列或
   * steering，问题就永远收不到答案 —— 界面会整整卡 5 分钟，看起来就是"AI 正在思考…"不动。
   */
  const pendingQuestion = useMemo(
    () => [...messages].reverse().find((m) => m.askUser && !m.askUser.answered),
    [messages],
  );
  /** 正在插话的那一条（那一行的按钮转圈，同时挡住重复点） */
  const [steeringId, setSteeringId] = useState<string | null>(null);
  /** 队列的会话 key：草稿页（还没建项目）是 "" —— 见 lib/steer-queue.ts 的 project 字段 */
  const queueKey = projectId ?? "";
  const prevQueueKeyRef = useRef(queueKey);
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

  /* ── 重挂「正在跑的那一轮」（切走再回来 / 标签页切回前台 / 页面重开）────────────────
   * 面板侧的接线在下面那个 attach 流 effect；内核侧的契约见 routes-stream.ts。 */

  /**
   * 每个线程「我已经处理到哪一帧」—— 重挂时用 `after=<它>`，把看过的帧跳过去。
   * ⚠️ 帧序号每线程、**每轮从 1 起**（内核 beginTurn 归零），所以回合结束必须清掉：
   *    留着的话下一轮的 after 会大得离谱，重放一帧都补不回来。
   */
  const seenSeqRef = useRef(new Map<string, number>());
  /**
   * 重挂补看时那条 AI 消息的 id（每线程一个）。
   * 为什么不能每次重挂都新开一条：切走再切回来时视图是从镜像恢复的，那条消息已经在列表里，
   * 再开一条就是同一轮的过程画两遍。
   */
  const attachTurnRef = useRef(new Map<string, string>());
  /**
   * 现在挂着哪条线程的流（面板的键 = 端口）。
   * 流回调写任何东西之前都要比它 —— **第二道保险**：abort 到回调真正停下之间有延迟，
   * 在途的那几拍照样会把 A 的 delta 写进用户后来打开的 B（见 attach effect 的注释）。
   */
  const attachedThreadRef = useRef<string | null>(null);
  /**
   * 本面板**自己正在发的**那些线程（handleSend 的 POST 流还开着）。
   *
   * 为什么用 ref 而不是 runningProjects：重挂的流一旦挂上就会把线程写进 runningProjects，
   * 那个 state 进 effect 依赖 = 「挂上 → 状态变 → effect 重跑 → 清理函数把自己 abort 掉」。
   * 这里要的只是「自己那条 POST 流是不是权威」，它变了不需要重跑 effect。
   */
  const liveSendRef = useRef<Set<string>>(new Set());
  /**
   * 当前线程的消息列表**就位**了吗（历史拉完 / 镜像恢复完）。
   * 重挂的流要等它：重放先落进空列表、随后 loadHistory 再整体覆盖的话，
   * 刚补上来的推理过程会被冲掉。
   */
  const historyReadyRef = useRef<string | null>(null);
  /** 推一下重挂 effect（标签页回到前台 / 历史就位时各推一次） */
  const [attachTick, setAttachTick] = useState(0);

  const [startDraft, setStartDraft] = useState("");
  // 新会话页的「计划模式」草稿：此时还没有线程，只能先存着，建项目时由 App 落地
  const [draftPlan, setDraftPlan] = useState(() => readDraftPlanMode());
  // 新会话页写的目标草稿（还没有线程可挂，建任务时由 App 落地）
  const [draftGoal, setDraftGoal] = useState<string | null>(() => readDraftGoal());
  const [folderMode, setFolderMode] = useState(false);
  const [folderPath, setFolderPath] = useState("");

  const submitStartDraft = async () => {
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
    // 建任务 + 记下「这条消息要发到哪个任务」由 App 负责；返回 false 就是**没建起来**。
    // 失败时这句话必须回来：原来这里不管返回值，创建一失败，草稿已经清了、
    // 消息又发不出去 —— 用户看到的就是「我发的话变成了任务名，然后什么都没发生」。
    const accepted = await onQuickCreateTask?.(text);
    if (accepted !== true) {
      setStartDraft((prev) => (prev.trim() ? `${text}\n\n${prev}` : text));
      toast({
        title: "任务没建成，消息还在",
        description: "已把刚才那段话放回输入框 —— 直接再发一次即可",
        tone: "warning",
      });
      focusComposer();
    }
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
  /** 模型设置对话框（左下角齿轮 / 右下角 chip 都开它）的开关 */
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  /** 正在把选中的模型写进内核 —— chip 上转个圈，写失败也不回滚界面（见 applyModel） */
  const [modelSaving, setModelSaving] = useState(false);
  /**
   * 输入框下方状态行的数据（公式都写在 composer-status-line.tsx 里，这里只管攒数）。
   *
   * 两个来源，缺一不可：
   *   · 面板自己攒的：这一轮的**墙钟**和**工具调用数**（起点见 handleSend 的 turnRef）
   *   · 内核的 stats 事件：rounds + usage（token / 缓存）
   * null = 这个线程还没有任何可展示的数据（新线程 / 刚切过来）→ 整条不渲染。
   */
  const [statusLine, setStatusLine] = useState<ComposerStatusData | null>(null);
  /**
   * 正在跑的这一轮：起点 + 数到的工具调用 + **它属于哪个会话**。
   *
   * 为什么带 project：流回调是长生命周期闭包，用户在 A 跑到一半切到 B 再切回来时，
   * 只有认准 project 才不会把 B 的计时/步数算进 A（messagesMirrorRef 同一个道理）。
   */
  const turnRef = useRef<{ project: string; startedAt: number; steps: number } | null>(null);
  
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
  // 输入卡片的容器 —— ComposerBox 不暴露 ref，要聚焦就从这里找它的 textarea（见 focusComposer）
  const composerWrapRef = useRef<HTMLDivElement | null>(null);
  /** 输入框正文的把手：插入引用 chip（「添加到评论」）—— 见 composer-input.tsx */
  const composerRef = useRef<ComposerHandle | null>(null);
  
  // 语音朗读 Hook
  const speechSynthesis = useSpeechSynthesis();
  
  // 版本切换 loading 状态
  const [isSwitchingVersion, setIsSwitchingVersion] = useState(false);

  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // ── 最右侧 userprompt 刻度栏 ────────────────────────────────
  // 插槽由 shell 渲染（永远在最右缘），这里用 portal 挂进去 —— 状态留在本组件，不必抬到 App。
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setRailSlot(document.getElementById("prompt-rail-slot")); }, []);
  const railItems = useMemo<PromptRailItem[]>(() => {
    const out: PromptRailItem[] = [];
    messages.forEach((m, i) => {
      if (m.role !== "user") return;
      const text = String(m.content ?? "");
      // 注入不是「用户输入的位置」（提醒/模式注入都包在 system-reminder 里）—— 刻度只标用户真正说的话
      if (text.trimStart().startsWith("<system-reminder>")) return;
      const reply = messages[i + 1]?.role === "assistant" ? messages[i + 1] : undefined;
      const files = (reply?.turn_files ?? reply?.turn_diff?.files ?? []).slice(0, 3)
        .map((f) => ({ name: f.path.split("/").pop() ?? f.path, path: f.path }));
      out.push({
        messageId: m.id, text,
        replySummary: reply ? String(reply.content ?? "").slice(0, 200) : undefined,
        files: files.length > 0 ? files : undefined,
      });
    });
    return out;
  }, [messages]);
  /**
   * 刻度栏拿滚动容器的方式。
   * **必须是稳定引用**（useCallback 空依赖）—— 以前这里传的是内联箭头，每次渲染都是
   * 新函数，刻度栏里挂着它的 effect 就会连滚动监听和 ResizeObserver 一起重建。
   */
  const getMessagesScrollContainer = useCallback(() => messagesContainerRef.current, []);
  const jumpToMessage = useCallback((id: string) => {
    // 查找口径与刻度栏共用一份（不吃选择器转义，见 lib/message-anchor.ts）
    const el = findMessageElement(messagesContainerRef.current, id);
    if (!el) {
      // 找不到**必须说出来**：切任务的瞬间容器可能还是 null，消息也可能已被回滚 ——
      // 以前是 `el?.` 静默吞掉，用户只会以为「点了没反应」
      toast({ title: "没找到这条消息", description: "它可能已被回滚，或还在加载中", tone: "warning", duration: 2000 });
      return;
    }
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [toast]);
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
      void alignModelWithKernel(savedSettings.model);
    }
  }, []);

  /**
   * 启动时把「面板里的模型」和「内核里的模型」对齐 —— 方向取决于用户有没有选过：
   *
   *   · 这台浏览器选过 → 面板的值推给内核（上一版模型存在 localStorage 里，
   *     升上来不能因为内核默认是 flash 就把人选过的 pro 悄悄改掉）；
   *   · 没选过（第一次用 / 换机器）→ 内核的值拉到面板（内核是权威存储，
   *     它可能是 env 里手写进去的模型）。
   *
   * 内核没起来 / 接口出错就什么都不做 —— 面板照常用 localStorage 那份，
   * 聊天本来也发不出去，这里不该再多冒一个红条。
   */
  const alignModelWithKernel = async (localModel: string) => {
    try {
      const remote = await getModelSettings();
      if (!remote.model || remote.model === localModel) return;
      if (hasSavedModelChoice()) {
        await saveModelSettings({ model: localModel });
      } else {
        setSettings((prev) => ({ ...prev, model: remote.model }));
      }
    } catch { /* 内核不可达：保持本地这份 */ }
  };

  // 加载历史记录的函数（可复用）
  /**
   * @param switchLatest   先切回最新版本再读（回滚/切版本之后的刷新用）
   * @param skipIfLiveSend 这一轮正由**面板自己的 POST 流**画着（见 liveSendRef）时直接放弃 ——
   *                       手里的历史是它开始之前的快照，覆盖上去 = 刚发的消息和正在画的过程
   *                       一起消失。只有「重挂补看」那条路要它（那里的历史一定是权威的旧快照）；
   *                       换会话的首次加载**不能**跳：那是把上一个会话的列表清掉的唯一时机
   *                       （视图在切会话时不会被清空 —— 切走再建新会话会看到两个会话的消息混在
   *                       一起，实测踩过）。
   */
  const loadHistory = async (port: string, switchLatest: boolean = false, skipIfLiveSend: boolean = false) => {
    try {
      if (switchLatest) {
        await switchToLatest(port).catch(() => {
          // 忽略错误，可能已经在最新版本
        });
      }
      
      const data = await getHistory(port);
      if (skipIfLiveSend && liveSendRef.current.has(port)) return;
      /**
       * ⚠️ 等回话来的时候用户可能已经切到别的会话了 —— 这份历史属于**上一个**会话，
       * 落下去就是把它的消息盖到当前会话头上（实测：切回来的那一屏是上一个会话的内容，
       * 标题却是新的）。判据用 lastProjectIdRef：它在切会话的那个 effect 里**同步**写到新值。
       */
      if (port !== lastProjectIdRef.current) return;
      if (data.history && data.history.length > 0) {
        const convertedMessages = convertHistoryToMessages(data.history);
        setMessages(convertedMessages);
        // ⚠️ ref 也**同步**推进：流回调的起点读的是它（见 writeTurnMessages），
        //    而它平时靠 useEffect 追平 —— 差那一拍，起点就是上一个会话的列表。
        messagesRef.current = convertedMessages;
        
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
        messagesRef.current = [];
        onLatestVersionChange?.(0);
        isInitialLoadRef.current = false;
      }
    } catch (error) {
      console.error("Failed to load history from API:", error);
    } finally {
      // 列表就位（读不到也算就位：不然重挂的流永远挂不上）→ 放重挂 effect 过去。
      // ⚠️ 只在「没就位 → 就位」这一跳里推：每次 loadHistory 都推的话，
      //    attach 里那次「刚跑完就重读历史」会和重挂 effect 转成无限循环（挂上 → 重读 → 再挂）。
      if (historyReadyRef.current !== port) {
        historyReadyRef.current = port;
        setAttachTick((n) => n + 1);
      }
    }
  };

  /**
   * 等这个会话的消息列表就位（见 historyReadyRef）—— 最多等 `timeoutMs`。
   *
   * 用轮询而不是 Promise：状态推进在别的执行流里（loadHistory 的 finally / 镜像恢复），
   * 这里只是「等一个已经会发生的事件」，20ms 一拍足够（新会话的历史是本机一次读库）。
   */
  const waitHistoryReady = async (port: string, timeoutMs = 2_000) => {
    if (!port) return;
    const deadline = Date.now() + timeoutMs;
    while (historyReadyRef.current !== port && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  
  // 只更新 skipped_by_restore 标记，不替换整个消息列表（避免闪烁和滚动）
  /**
   * 会话末端的「回滚」成功之后 —— 照 PreviewPanel 里 switchVersion 之后的处理：
   * 刷新预览 + 不再停在历史版本；再把面板自己的历史重读一遍（skipped_by_restore），
   * 被回滚掉的那一轮就会折叠成「已回滚」。延迟 500ms 是学 version_restored 那段：
   * 等内核把历史写完再读，免得读到一半。
   */
  const handleRolledBack = () => {
    onRefreshPreview?.();
    onVersionChange?.(null);
    if (projectId) {
      setTimeout(() => { void updateSkippedMarks(projectId); }, 500);
    }
  };

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
        messagesRef.current = messagesMirrorRef.current.list;   // ref 同步推进（理由见 loadHistory）
        // 镜像恢复是同步的：列表这一刻就位了，重挂的流可以直接挂（见下面的 attach effect）
        if (historyReadyRef.current !== projectId) {
          historyReadyRef.current = projectId;
          setAttachTick((n) => n + 1);
        }
      } else {
        loadHistory(projectId, true);   // 它自己会在 finally 里把「就位」标上
      }
    }
  }, [projectId]);

  /**
   * 当前线程在内核里的线程 id。
   *
   * 面板这一侧的「线程」一直是端口（projectId），而 `/api/stream` 要的是**内核线程 id** ——
   * 内核那个帧缓冲（hub）的键是它，不是端口（见 routes-stream.ts）。内核给项目开的线程
   * id 是 `th_<项目数据库 id>`（core 的 getOrCreateProjectThread），而项目 id 就在面板
   * 已经拿到的项目列表里 —— 不用为此再问一次接口。
   * 拿不到（刚建的任务、列表还没刷新出来）就先不挂：projects 一变这个 effect 会再跑。
   */
  const kernelThreadId = useMemo(() => {
    const project = projects.find((p) => p.port === projectId);
    return project?.id ? `th_${project.id}` : null;
  }, [projects, projectId]);

  /**
   * 重挂补看的那一轮写进哪条 AI 消息（并给出这一轮的 ctx）。
   *
   * 三个判据：
   *   ① 同一条线程**只开一条** —— 切走再切回来时视图是从镜像恢复的，那条消息已经在
   *      列表里；每次重挂都新开一条 = 同一轮的过程在同一屏里画两遍。
   *   ② 列表里还没有它（页面重开 / 这一轮本来是在别处跑的）→ 先立一条空的：
   *      用户至少看得见「AI 正在思考」，而不是一片空白 —— 那正是这个 bug 的表象。
   *   ③ 历史里那条「刚开个头」的 AI 消息（还空着、没工具、没报错）**就是这一轮的落点**：
   *      重开一页/冷启动时它已经在列表里（内核落库的那条），再开一条就是同一轮两个气泡
   *      （实测：上一条「AI 正在思考…」下一条才是真过程）。
   */
  const ensureAttachTurn = (threadKey: string): StreamTurn => {
    const existing = attachTurnRef.current.get(threadKey);
    let aiMessageId = existing ?? null;
    if (!aiMessageId) {
      const list = messagesMirrorRef.current.project === threadKey
        ? messagesMirrorRef.current.list
        : messagesRef.current;
      const tail = list.length > 0 ? list[list.length - 1] : undefined;
      const looksLikeFreshTurn = tail !== undefined && tail.role === "assistant"
        && !tail.content && !tail.error && !tail.askUser && (tail.toolCalls?.length ?? 0) === 0;
      aiMessageId = looksLikeFreshTurn ? tail!.id : `attach_${threadKey}_${Date.now()}`;
      attachTurnRef.current.set(threadKey, aiMessageId);
    }
    const stillViewing = () => attachedThreadRef.current === threadKey && viewedProjectRef.current === threadKey;
    writeTurnMessages(threadKey, stillViewing, (prev) =>
      prev.some((m) => m.id === aiMessageId) ? prev : [
        ...prev,
        { id: aiMessageId, role: "assistant", content: "", timestamp: new Date(), toolCalls: [], events: [] },
      ]
    );
    // 重挂时不知道这一轮的**真起点**（它早过去了），只能从挂上来的这一刻算
    const turn = { project: threadKey, startedAt: Date.now(), steps: 0 };
    return { project: threadKey, aiMessageId, stillViewing, turn, lastToolParams: null };
  };

  /**
   * 挂上「这个线程正在跑的那一轮」。
   *
   * 什么时候需要它：切到别的任务 / 标签页切到后台 / 直接重开页面 —— 那轮的 thinking、
   * delta、工具行**只活在 POST /api/chat 那次连接上**，连接一断就再没有地方能补看
   * （消息历史要等回合结束才落库）。这里挂内核的 /api/stream：
   * attach 帧说这轮在不在跑 → 补 `seq > after` 的帧 → 之后跟着广播走。
   *
   * ⚠️ 防串台的两道保险（A 的 delta 落进 B 的视图）：
   *   ① 清理函数 abort 掉旧流（连接层）；
   *   ② 回调开头比 attachedThreadRef.current 是否还是这条流（状态层）——
   *      abort 到回调真正停下之间有延迟，在途的那几拍照样会跑。
   */
  useEffect(() => {
    const threadKey = projectId;
    if (!threadKey) return;
    // 自己正在跑这一轮：POST 那条流就是权威。再挂一条同一回合的广播 = 每个 delta 落两遍
    // （见 liveSendRef：这里故意不依赖 runningProjects —— 那是 state，挂上就会变，
    //   进依赖会让 effect 自转一圈把自己 abort 掉）。
    if (liveSendRef.current.has(threadKey)) return;
    // 消息列表还没就位就先别挂（见 historyReadyRef）——不然重放会先落进空列表，
    // 随后 loadHistory 的整体覆盖又把它冲掉。
    if (historyReadyRef.current !== threadKey) return;
    if (!kernelThreadId) return;
    const stillViewing = () => attachedThreadRef.current === threadKey && viewedProjectRef.current === threadKey;
    const ac = new AbortController();
    attachedThreadRef.current = threadKey;
    let turn: StreamTurn | null = null;

    /**
     * 这一轮回合**结束**（done 帧 / 切回来发现它已经跑完）：清状态、把落库的最终消息补上。
     *
     * ⚠️ 这里**不收线** —— 订阅是常驻的：同一个线程随时可能开下一轮（新会话的第一条消息
     * 甚至不是这条连接发的，见 App.firePendingKickoff），收掉就再也看不到那一段了。
     *
     * `forceHistory`：这一轮不是这条订阅看着跑完的（面板自己发的 POST / 中途断线）——
     * 视图里那份是过程镜像，可能有它自己都不知道的缺口；而回合结束之后**服务端历史
     * 就是权威**，读它一次把视图对齐（也是「消息发了却什么都没出现」的自愈路径）。
     */
    const finishTurn = (forceHistory = false) => {
      const wasTracking = attachTurnRef.current.delete(threadKey);
      // 帧序号每轮归零（内核 beginTurn）：留着会让下一轮的 after 大得离谱，一帧都补不回来
      seenSeqRef.current.delete(threadKey);
      turn = null;
      if (!wasTracking && !forceHistory) return;   // 本来就没在画、也没什么要对齐的
      setRunningProjects((prev) => {
        const next = new Set(prev);
        next.delete(threadKey);
        return next;
      });
      setIsLoading(false);
      if (turnRef.current?.project === threadKey) turnRef.current = null;
      // 过程留在历史里；重放的那条只是过程的临时载体。
      // skipIfLiveSend：自己那条 POST 流还在画时，这份历史是它开始之前的旧快照（见 loadHistory）。
      void loadHistory(threadKey, false, true);
    };

    /**
     * 挂上来时那一轮**已经跑完**（缓冲区里还有它的帧）：那段重放没有意义 —— 历史才是
     * 它的权威版本，重放一遍只会和 loadHistory 打架（同一段过程画两行）。判据是
     * attach 带的 lastSeq：把指针推到它、重挂一次，服务端就用 after=lastSeq 滤掉整段。
     * 只重挂一次（resynced）：第二次 attach 的 lastSeq == 指针，条件不成立，不会自转。
     */
    let resynced = false;
    const handle = streamFrom(kernelThreadId, seenSeqRef.current.get(threadKey) ?? 0, (event, seq) => {
      if (!stillViewing()) return;                     // ② 当前线程变了：一个字节都不许落
      // 自己那条 POST 流才是权威（见 liveSendRef）：effect 被 setAttachTick 收掉之前
      // 可能又到了一两拍，落到这里就是同一段过程画两行。
      if (liveSendRef.current.has(threadKey)) return;
      /**
       * 挂上来时就知道「那一轮已经跑完」→ 这条连接剩下的帧全是它的**陈年重放**
       * （abort 到真正断流之间还会到几拍），一个都不能落：落了就会给这个线程凭空
       * 开一条只有前几拍内容的载体，还把镜像从「别的线程」手里抢过来 ——
       * 切回来时镜像恢复拿到的就是这条残影，正在跑的那一轮内容反而丢了（实测踩过）。
       * 后续的帧由上一条（after=lastSeq）新连接接。
       */
      if (resynced) return;
      if (seq !== null) seenSeqRef.current.set(threadKey, seq);
      if (event.type === "done") { finishTurn(); return; }
      // 常驻订阅：帧可能比 attach 晚很多才来（新会话的第一轮就是这样）→ 那一刻才建载体
      if (!turn) {
        turn = ensureAttachTurn(threadKey);
        turnRef.current = turn.turn;
        setRunningProjects((prev) => new Set(prev).add(threadKey));
        setIsLoading(true);
      }
      applyStreamEvent(event, turn);
    }, (info) => {
      if (!stillViewing()) return;
      if (!info.running) {
        // 没在跑：订阅**照挂**（下一轮随时可能开始），只把「刚跑完」那一轮的结果补上。
        if (info.lastSeq > 0) {
          const seen = seenSeqRef.current.get(threadKey) ?? 0;
          if (!resynced && seen < info.lastSeq) {
            resynced = true;
            seenSeqRef.current.set(threadKey, info.lastSeq);
            finishTurn(true);              // 没看全它 → 拿权威历史对齐一次
            ac.abort();
            setAttachTick((n) => n + 1);   // 带 after=lastSeq 重挂（见上面 resynced 的说明）
            return;
          }
        }
        // 没有帧可补（内核重启过 / 本来就没跑过）：至少别停在「生成中」
        finishTurn();
        return;
      }
      // 在跑：进入「生成中」——stop 按钮、思考中那套 UI 和真在跑时完全一致
      setRunningProjects((prev) => new Set(prev).add(threadKey));
      setIsLoading(true);
      turn = ensureAttachTurn(threadKey);
      turnRef.current = turn.turn;
    }, ac.signal);
    void handle.done.catch((e: unknown) => {
      // 挂不上不影响能用：历史 + 下一条消息照旧（这条流只是「补看正在跑的那一轮」）。
      // 内核还是旧版本（没有 /api/stream）时也会走到这儿 —— 控制台一行 404 的 warn，
      // 界面上什么都不做（那本来就不是错误路径）。
      // 中途断线（内核重启 / 网络断）留下的「生成中」：下次切任务或回前台会再挂一次，自己就好。
      console.warn("重挂正在跑的那一轮失败（不影响发消息）:", e instanceof Error ? e.message : String(e));
    });
    return () => {
      attachedThreadRef.current = null;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, kernelThreadId, attachTick]);

  // 标签页回到前台：那条流多半已经被浏览器掐了（切后台久了 / 睡过一觉），重挂一次。
  // 已经在跑的那一轮会从 after=<已看过的 seq> 接着补，不会重复应用。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setAttachTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

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

  /**
   * 换模型（chip 和设置对话框里的模型都走这一条）。
   *
   * 两边一起写：localStorage（老行为，**每轮发出去的 model 字段**就是它）+
   * 内核设置（权威存储，下次开机也用它）。内核写失败**不回滚界面** ——
   * 用户已经选了，回滚只会让他以为自己点歪了；发出去的 model 字段本来也是面板说了算。
   */
  const applyModel = (id: string) => {
    updateSettings({ model: id });
    setModelSaving(true);
    saveModelSettings({ model: id })
      .catch((e: unknown) => {
        toast({
          title: "模型没能存进内核",
          description: `${e instanceof Error ? e.message : String(e)}（这一轮仍按 ${id} 发）`,
          tone: "warning",
        });
      })
      .finally(() => setModelSaving(false));
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

  /**
   * 建好任务后，把「空状态里说的那句话」当作第一条消息自动发出。
   *
   * 三件必须做对的事（原来一件都没做）：
   *   ① 认项目：pendingMessage 带着 projectId，只有当前正看着那个任务时才发 ——
   *      否则用户中途切走，这条消息会发进**别的**任务。
   *   ② 一次性：`sentPendingRef` 记下已经接手的那一条。effect 的依赖里 projectId
   *      一变就会再进来一次，没有这个守卫就会发两遍。
   *   ③ 失败不吞内容：handleSend 返回 false（没发出去）时把原文放回输入框 + 提示 ——
   *      绝不能像以前那样静默丢掉（用户的原始投诉）。
   */
  const sentPendingRef = useRef<{ projectId: string | null; text: string } | null>(null);
  /**
   * 已经接手、但**还没进消息列表**的那句话（待发气泡）。
   *
   * 为什么要它：App 那边的 pendingMessage 一被接手就清掉了，而真正的用户气泡要等
   * handleSend 里那次 switchToLatest 回来才画出来 —— 这段空档里以前是「点了发送，
   * 列表里什么都没有」（用户报的「消息没有马上发送出去」）。带 projectId 是为了
   * 中途导航时不把 A 的待发气泡挂到 B 上（和 pendingMessage 同一个道理）。
   */
  const [sendingText, setSendingText] = useState<{ projectId: string; text: string } | null>(null);
  useEffect(() => {
    if (!projectId || !pendingMessage) return;
    // projectId 为 null = 任务还在建（App 会把它绑到端口上再给过来）
    if (pendingMessage.projectId !== projectId) return;   // 还没切到位，或者用户已经走了（App 会兜底发出去）
    if (sentPendingRef.current === pendingMessage) return;
    sentPendingRef.current = pendingMessage;
    // 已经接手 → 告诉 App 别再交给别人（它清了之后，中途导航不会再发第二遍）。
    // ⚠️ 但**占位气泡还不能撤**：真正的用户气泡要等下面 handleSend 里那次 switchToLatest
    //    回来才画出来，中间这段空档由 sendingText 接着盯（见它的注释）。
    onPendingMessageConsumed?.();
    setSendingText({ projectId, text: pendingMessage.text });
    const text = pendingMessage.text;
    void handleSend(text).then((sent) => {
      // sent=false 只在**没发出去**时提前 resolve（成功要等整轮跑完才 resolve，这里不等它）
      if (!sent) {
        setSendingText(null);
        restoreUnsentText(text, "发送失败，已把内容放回输入框 —— 可以直接重试");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pendingMessage]);

  /**
   * App 把「用户离开时被收回来的那条消息」交还到这里（见 App.takeBackPending）：
   * 放回当前输入框 + 提示。只认 token —— 同一个对象重渲染不该重复插入一遍。
   */
  const restoreTokenRef = useRef(0);
  useEffect(() => {
    if (!restoreDraft || restoreDraft.token === restoreTokenRef.current) return;
    restoreTokenRef.current = restoreDraft.token;
    restoreUnsentText(restoreDraft.text, "已放回输入框（还没有发送给任何任务）");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreDraft]);

  /**
   * 上传一组文件 —— **文件选择 / 拖进来 / 粘贴** 三个入口共用这一条路。
   *
   * 逐个上传、逐个报错：一个失败不影响其它（原来是一个 try 包住整个循环，
   * 第一个失败后面的就全不传了，而且只弹一个 alert）。
   * 返回成功传上去的个数，调用方自己决定要不要提示。
   */
  const uploadFilesToTask = async (files: File[], targetProject: string): Promise<number> => {
    if (files.length === 0) return 0;
    setIsUploading(true);
    let ok = 0;
    try {
      for (const file of files) {
        try {
          const uploaded = await uploadFile(file, targetProject);
          setAttachments(prev => [...prev, uploaded]);
          ok++;
        } catch (error) {
          // 每个失败都点名到文件 —— 一次拖 5 个、坏了 1 个时，
          // 用户必须知道是哪个坏了，而不是一句笼统的「上传失败」
          toast({
            title: "文件上传失败",
            description: error instanceof Error ? error.message : String(error),
            tone: "danger",
          });
        }
      }
    } finally {
      setIsUploading(false);
    }
    return ok;
  };

  // 处理文件选择（桌面上的「选文件」入口；可以一次选多个）
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    try {
      if (!files || files.length === 0 || !projectId) return;
      await uploadFilesToTask(Array.from(files), projectId);
    } finally {
      // 清空 input，以便可以重复选择同一文件
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };
  
  // 移除附件
  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  /**
   * 拖进来的文件（全窗口蒙层 → 松手）、以及 Cmd+V 粘贴进来的文件，
   * 都落到这里 —— 和「+」菜单选文件是同一条路。
   * 还没有任务时不能传（没有落点），说清楚而不是静默失败。
   */
  const handleDroppedFiles = (files: File[]) => {
    if (!projectId) {
      toast({
        title: "先建好任务",
        description: "文件要落到任务的 uploads/ 目录里；先在输入框里说一句话建好任务，再拖进来",
        tone: "info",
      });
      return;
    }
    void uploadFilesToTask(files, projectId).then((n) => {
      if (n > 0) toast({ title: `已加入 ${n} 个文件`, description: "会随下一条消息进对话", tone: "success", duration: 2000 });
    });
  };

  /**
   * 把焦点送回输入框（「+」菜单 / 斜杠命令选完之后）。
   *
   * 为什么不只 focus() 一次：Radix 关浮层时 FocusScope 会用一个 setTimeout(0) 把焦点
   * 还给触发按钮（也就是「+」），所以先让过那一拍、再兜一次底 —— 否则光标会停在按钮上。
   *
   * 选择器认 `[data-composer-input]`：输入框正文现在是 contenteditable
   * （textarea 里画不出引用 chip，见 composer-input.tsx 的取舍），找不到才退回 textarea。
   */
  const focusComposer = () => {
    const grab = () => composerWrapRef.current
      ?.querySelector<HTMLElement>("[data-composer-input], textarea")?.focus();
    grab();
    window.setTimeout(grab, 0);
    window.setTimeout(grab, 80);
  };

  /**
   * 把一段「没能发出去」的文字还给用户：还原到**当前**输入框 + 一条能行动的提示。
   *
   * 这是「消息静默消失」这条主诉的统一兜底：任何一条没能发出去的路
   * （建任务失败 / 发送失败 / 中途切走）都必须落到这里 —— 用户至少能看见它、能直接重试。
   * 手快已经在输入框里打了新字的话，原话接在前面（宁可多一段，也不能少一句）。
   */
  const restoreUnsentText = (text: string, reason: string) => {
    const put = (prev: string) => (prev.trim() ? `${text}\n\n${prev}` : text);
    if (projectId) { setInput(put); focusComposer(); } else { setStartDraft(put); }
    toast({ title: "这条消息还没有发出去", description: reason, tone: "warning" });
  };

  /**
   * 消息里选中文字 → 右键「添加到评论」：把那一段作为**引用 chip** 插进输入框
   * （显示成缩写，hover 出原文；发出去的是完整原文，见 composer-input.tsx）。
   * 插到**光标处** —— 用户可能已经写了一半，再回头引用某句话。
   */
  const handleAddToComment = (text: string) => {
    const t = text.trim();
    if (!t) return;
    composerRef.current?.insertReference(t);
    focusComposer();
  };
  // 右键菜单只挂在消息列表那一块（见下面的 onContextMenu），别处照旧走系统菜单
  const { onContextMenu: onMessagesContextMenu, menuNode: quoteMenu } = useSelectionQuoteMenu(
    projectId ? handleAddToComment : undefined,
  );

  /** 「+」菜单 / /file：和原来的回形针同一条路 —— 打开隐藏的文件选择框 */
  const triggerFilePick = () => {
    if (!projectId) {
      // 起始页还没有线程，上传没有落点；说清楚，别让用户对着没反应的入口点
      toast({ title: "先建好任务", description: "文件会随消息进对话；建好任务后再从输入框的 + 上传", tone: "info" });
      return;
    }
    fileInputRef.current?.click();
  };

  /**
   * 「+」菜单 / /capture：框选截屏 → 走**既有**的 uploadFile 通道进附件条。
   * 「评论」就是接下来打的那句话：截屏只负责把图放进这一轮。
   */
  const handleCapture = async () => {
    if (!projectId) {
      toast({ title: "先建好任务", description: "截屏会作为附件进对话；建好任务后再从输入框的 + 截屏", tone: "info" });
      return;
    }
    let shot: CaptureScreenResult;
    try {
      shot = await captureScreen();
    } catch (error) {
      toast({ title: "截屏失败", description: error instanceof Error ? error.message : String(error), tone: "danger" });
      return;
    }
    if (!shot.ok) {
      if (shot.cancelled) return;   // 用户按了 Esc：不是错误，什么都不做（不弹任何东西）
      toast({ title: "截屏失败", description: shot.error, tone: "danger" });
      return;
    }
    setIsUploading(true);
    try {
      // base64 → File：截屏结果顺着既有的上传通道走，先变回一个文件
      const bin = atob(shot.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const uploaded = await uploadFile(new File([bytes], shot.name, { type: shot.mediaType }), projectId);
      setAttachments(prev => [...prev, uploaded]);
      focusComposer();   // 图已经在附件条上了，光标回输入框等着写评论
    } catch (error) {
      console.error("截屏上传失败:", error);
      toast({ title: "截屏上传失败", description: error instanceof Error ? error.message : String(error), tone: "danger" });
    } finally {
      setIsUploading(false);
    }
  };

  /** Swarm 开关（「+」菜单和 /swarm 共用）—— 只动面板旗标，发消息时随 mode 带出去 */
  const toggleSwarm = () => {
    const next = !swarmOn;
    setSwarmOn(next);
    toast(next
      ? { title: "已开启 Swarm 模式", description: "下一轮起用多个子代理并行处理", tone: "info" }
      : { title: "已关闭 Swarm 模式", description: "回到单代理执行", tone: "default" });
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

  /**
   * 把一次流式回合的消息更新写下去 —— **切走也不丢**：
   *   在看这个线程 → 同时写镜像和视图
   *   切走了       → 只写镜像（服务端照跑，切回来能恢复）
   * 实时发送与重挂补看共用它（见 StreamTurn）。
   */
  const writeTurnMessages = (
    project: string,
    stillViewing: () => boolean,
    updater: (prev: Message[]) => Message[],
  ) => {
    const base = messagesMirrorRef.current.project === project
      ? messagesMirrorRef.current.list
      : messagesRef.current;          // 这一轮刚开始：以当前视图为起点
    const next = updater(base);
    messagesMirrorRef.current = { project, list: next };
    if (stillViewing()) setMessages(next);
  };

  /**
   * 一轮 SSE 事件 → 消息列表 / 状态行 / 子代理……
   *
   * **实时发送（handleSend 那次 POST）与重挂补看（streamFrom）共用这一份** ——
   * 函数体就是原来 handleSend 里那个内联回调，一字未改：只是「身份」不再吃闭包，
   * 哪个线程、写进哪条 AI 消息、状态行怎么数全从 ctx 拿（见 StreamTurn）。
   */
  const applyStreamEvent = (event: SSEEvent, ctx: StreamTurn) => {
    // ⚠️ 用户已经切走 → **这个流的事件不再写进当前视图**。
    //
    // 为什么必须挡：流回调是长生命周期闭包，setMessages/setSubagents 都是
    // ChatPanel 的**全局** state。不挡的话，在 A 会话跑着的回合会把
    // 推理过程、工具详情、子代理状态全灌进用户后来打开的 B 会话（实测踩过）。
    // 服务端那一轮照跑、历史照存 —— 切回去 loadHistory 就能看到结果。
    if (!ctx.stillViewing()) return;

    const streamProject = ctx.project;
    const aiMessageId = ctx.aiMessageId;
    /** 这一轮的消息更新都走它（切走也不丢，见 writeTurnMessages） */
    const applyMessages = (updater: (prev: Message[]) => Message[]) =>
      writeTurnMessages(ctx.project, ctx.stillViewing, updater);

    // 处理会话 ID
    if (event.type === "session_id") {
      currentSessionId.current = event.content || null;
      console.log("收到会话 ID:", currentSessionId.current);
    } 
    // 处理 ask_user 事件 - 放到消息流中
    else if (event.type === "ask_user") {
      // 审批类（approval）带上「同意并记住」的形状（remember_rule，如 Bash(rm -rf /tmp/x)）；
      // 普通提问没有这两个字段，AskUserInline 就不会画「记住」选项
      const approval = event.approval === true;
      const rememberRule = typeof event.remember_rule === "string" ? event.remember_rule : undefined;
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
                  approval,
                  remember_rule: rememberRule,
                },
                events: [
                  ...(msg.events || []),
                  { 
                    type: "ask_user" as const, 
                    question: event.question,
                    questionType: event.question_type || "single",
                    suggestions: event.suggestions,
                    approval,
                    remember_rule: rememberRule,
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

      // 状态行的「步」= 一个 tool_start 记一步（这是面板能实时看见的最小单位；
      // 内核 stats 里那个 rounds 要等这一轮跑完才有）。切走再切回来时行可能是空的，
      // 顺手把它立起来 —— 回合还在跑的时候状态行不该整条消失。
      const turn = ctx.turn;
      if (turn && turn.project === streamProject) {
        turn.steps += 1;
        const steps = turn.steps;
        setStatusLine((prev) => ({
          steps,
          rounds: prev?.rounds ?? null,
          outputTokens: prev?.outputTokens ?? null,
          promptTokens: prev?.promptTokens ?? null,
          cacheReadTokens: prev?.cacheReadTokens ?? null,
          durationMs: prev?.durationMs ?? null,
          totalTokens: prev?.totalTokens ?? 0,
        }));
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
      ctx.lastToolParams = { tool: event.tool, params: event.params };
      
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
      // Present 交付物：把这次的参数 + 结果拼成一小段事件流解析出文件清单，
      // 交给 App —— 产出的 .html 要自动在右侧「浏览器」标签打开（非 HTML 不打扰）
      if (isPresentTool(event.tool)) {
        const lastParams = ctx.lastToolParams;
        const params = lastParams && lastParams.tool === event.tool ? lastParams.params : undefined;
        const files = extractPresentedFiles([
          { type: "tool_start", tool: event.tool, params },
          { type: "tool_result", tool: event.tool, result: event.result },
        ]);
        if (files.length > 0) onPresentedFiles?.(files);
      }
      ctx.lastToolParams = null;  // 清除
      
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
      
      /**
       * 状态行落定 —— 这一轮的 rounds / token 到了。
       *
       * token 走 lib/models 的 usageEntries 归一化：**新的 stats 载荷是
       * `usage.breakdown[]`（且没有 sonnet/opus）**，以前这里只加 sonnet+opus
       * 两个桶，结果是全 0。归一化之后两代形状都能算。
       */
      const entries = usageEntries(usage);
      const turn = ctx.turn;
      const startedAt = turn && turn.project === streamProject ? turn.startedAt : null;
      if (entries.length > 0) {
        const sum = (pick: (e: (typeof entries)[number]) => number) =>
          entries.reduce((acc, e) => acc + pick(e), 0);
        // 提示侧 = input + cache_read + cache_creation（缓存命中率与 C% 的分母，见状态行注释）
        const promptTokens = sum((e) => e.input_tokens + e.cache_read_tokens + e.cache_creation_tokens);
        const outputTokens = sum((e) => e.output_tokens);
        setStatusLine((prev) => ({
          steps: turn?.steps ?? prev?.steps ?? 0,
          rounds: event.rounds ?? 0,
          outputTokens,
          promptTokens,
          cacheReadTokens: sum((e) => e.cache_read_tokens),
          durationMs: startedAt != null ? Date.now() - startedAt : null,
          // 跨轮累计：提示侧 + 输出侧（口径见 composer-status-line.tsx）
          totalTokens: (prev?.totalTokens ?? 0) + promptTokens + outputTokens,
        }));
      } else if (event.rounds != null) {
        // 只有 rounds、没有 usage：至少把轮数落上，别让整行空着
        setStatusLine((prev) => (prev ? { ...prev, rounds: event.rounds ?? 0 } : prev));
      }
      
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
    } else if (event.type === "turn_diff") {
      // 这一轮改了什么（内核在回合末发一次）。空 diff（一轮只读）内核不发、
      // 兼容层也不会映射出门 —— 这里再挡一道：没有文件条目就什么都不落，
      // 免得消息里挂一个空块。
      //
      // 同时落两份：`turn_diff`（给已有的 TurnDiffCard，含 diff 正文）与
      // `turn_files`（给每轮文件卡片；刷新后由 /api/history 回填同一份数据）。
      const files = event.files ?? [];
      if (files.length === 0) return;
      const turnDiff = { files, truncated: event.truncated === true, diff: event.diff ?? "" };
      applyMessages((prev) =>
        prev.map((msg) =>
          msg.id === aiMessageId
            ? { ...msg, turn_diff: turnDiff, turn_files: files }
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
  };

  /**
   * 发送一条消息。
   *
   * 返回值 = 「这条消息有没有被接手」，调用方必须看：
   *   true  交给发送流程了（发出 / 排队 / 当作提问的回答）
   *   false 没发出去 —— **内容还在调用方手里**，要负责还给用户
   *         （建完任务自动发第一条、以及「没建成时把原话放回输入框」都靠它）
   *
   * ⚠️ 成功那一支要**等整轮跑完**才 resolve（下面 await 的是整条 SSE 流），
   *    所以调用方只该在 false 上做事，别拿它当「已送达」的即时信号。
   */
  const handleSend = async (messageText?: string, isNewProject: boolean = false): Promise<boolean> => {
    const textToSend = messageText || input;
    // /goal … 是**面板命令**，不发模型。刻意放在 isLoading 检查之前：一轮正在跑的时候
    // 也要能 /goal pause / complete。只拦"手动发送"这条路 —— messageText 是程序自动发的
    // （重试 / 继续 / 建完任务后的第一条），里面以 /goal 开头也只是普通正文。
    if (messageText === undefined && (await runGoalCommand(textToSend))) return true;
    if (!textToSend.trim()) return false;

    /**
     * 运行中发送 = **排队**（不再像以前那样直接丢掉）。
     *
     * 只拦「手动发送」这一条路：messageText 是程序自动发的（重试 / 继续 /
     * 队列自动发下一条），它们不该再进队列 —— 否则自己套自己，永远发不出去。
     */
    // ① 有未回答的提问 → **发送就是回答**（不能排队，也不能插话）
    if (isLoading && pendingQuestion && messageText === undefined) {
      setInput("");
      await handleAskUserSubmit(pendingQuestion.id, textToSend);
      toast({ title: "已作为回答提交", duration: 2000 });
      return true;
    }

    if (isLoading) {
      if (messageText === undefined) {
        setQueued((prev) => enqueueMessage(prev, projectId ?? "", textToSend));
        setInput("");
        toast({ title: "已加入队列", description: "当前回合结束后自动发送", duration: 2200 });
        return true;
      }
      // 程序自动发的（重试 / 建完任务后的第一条）不排队 —— 直接说「没发出去」，
      // 让调用方把内容还回输入框。原来这里是静默 return：那条消息就没了。
      return false;
    }

    // ⚠️ 这个会话在这次 send 里是哪个 —— 流回调靠它判断「事件还该不该写进当前视图」。
    //    必须在这里**捕获**（闭包），不能到回调里再读 projectId（那时可能是别的会话了）。
    const streamProject = projectId ?? "";
    // 立即设置 loading 状态，防止重复发送
    setIsLoading(true);
    setRunningProjects((prev) => new Set(prev).add(streamProject));
    // 自己这条 POST 流从这一刻起是权威 → 重挂的流不许同时挂（见 liveSendRef）
    liveSendRef.current.add(streamProject);
    // 常驻订阅还在挂着的话，现在把它收掉：它和这条 POST 收的是同一批广播，
    // 一起画 = 每个 delta 落两遍。tick 让 attach effect 重跑 —— cleanup 先 abort，
    // 再因为上面那行 liveSendRef 早退（下一次挂回来的时机见 finally）。
    setAttachTick((n) => n + 1);
    /**
     * 状态行：新一轮从零开始数。
     *   · turnRef 记起点（tok/s 要的墙钟时长从这儿算）和步数（每个 tool_start +1）
     *   · statusLine 只把**步数**清零 —— rounds / usage 要等这一轮结束的 stats 事件；
     *     清零之前先留着上一轮那几个数（"最近一轮"的口径，见 composer-status-line.tsx）
     */
    const turn = { project: streamProject, startedAt: Date.now(), steps: 0 };
    turnRef.current = turn;
    // 行本身先立起来（哪怕是第一轮：轮/usage 那几格写 —，步数开始跳）。
    // 上一轮的数字留着不动 —— 状态行是"最近一轮 + 正在跑的步数"，不是"当前这一轮的残影"。
    setStatusLine((prev) => ({
      steps: 0,
      rounds: prev?.rounds ?? null,
      outputTokens: prev?.outputTokens ?? null,
      promptTokens: prev?.promptTokens ?? null,
      cacheReadTokens: prev?.cacheReadTokens ?? null,
      durationMs: prev?.durationMs ?? null,
      totalTokens: prev?.totalTokens ?? 0,
    }));
    /**
     * 用户是不是还停在这个会话上看。
     * 切走之后旧流继续收，但**不再写视图** —— 服务端照跑、历史照存，只是不往别的会话里灌。
     * （判据与写入逻辑在 applyStreamEvent 里，和重挂补看共用同一份。）
     */
    const stillViewing = () => viewedProjectRef.current === streamProject;
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

    /**
     * 等这个会话的列表**就位**（历史拉完 / 镜像恢复完，毫秒级）再往下写气泡。
     *
     * 不等的话：这里读到的「当前列表」还是**上一个会话**那份（切会话时视图不会自己清空），
     * 两个气泡就落在别的会话的消息堆里，紧接着那次历史覆盖又把它们擦掉 ——
     * 「新建会话发消息，对话里什么都没出现」的一半原因就是它（另一半见 writeTurnMessages）。
     */
    await waitHistoryReady(streamProject);

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: textToSend,
      timestamp: new Date(),
    };

    // 创建一个新的 AI 消息用于流式更新
    const aiMessageId = (Date.now() + 1).toString();

    const aiMessage: Message = {
      id: aiMessageId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      toolCalls: [],
      events: [],
    };

    /**
     * 两个气泡**一次**写下去，而且走 writeTurnMessages（视图、镜像、起点一起推进）。
     *
     * ⚠️ 以前是两次裸 setMessages：只写了 state，而**下面每一帧都从
     * messagesMirrorRef / messagesRef 那份起点重建整个列表** —— 第一帧要是赶在
     * React 把 ref 追平之前到（本地内核几十毫秒就到，实测会），它就拿「发送前」的
     * 旧列表重建，这两个气泡连同后面所有帧一起被盖掉：用户看到的就是
     * 「消息发出去了，对话里却什么都没有」（这次实测复现的就是它）。
     */
    writeTurnMessages(streamProject, stillViewing, (prev) => [...prev, userMessage, aiMessage]);
    // 真实气泡已经进列表了 → 撤掉「正在发送…」占位（见 sendingText 的注释；没占位时是空操作）
    setSendingText(null);

    // 发送消息后强制滚动到底部
    setTimeout(() => scrollToBottom(), 50);

    // 清理上次对话的状态
    pendingNewVersionRef.current = null;

    // 构建消息内容（如有附件，追加文件信息）
    let finalMessage = textToSend;
    const currentAttachments = [...attachments];
    
    /**
     * 附件的「可读路径」必须真的写进消息里 —— 否则模型只能知道文件名，找不到文件。
     *
     * 内核把上传的文件原样落在 `<项目>/uploads/`（legacy/routes-project.ts 的
     * POST /api/upload-file），模型的 Read 既认绝对路径、也认工作目录（= 项目根）
     * 的相对路径 —— 这里给**绝对路径**，不指望它去猜 cwd。
     * （原来写的是「你可以使用 save_uploaded_file 工具」—— 内核里没有这个工具，
     *   等于让模型自己满世界找；「+」菜单的文案现在与这条对齐。）
     */
    if (currentAttachments.length > 0) {
      const projectRoot = projects.find((p) => p.port === projectId)?.path;
      const attachmentInfo = currentAttachments.map(a =>
        `- ${a.name}（${a.type || "未知类型"}，${formatBytes(a.size)}）：${projectRoot ? `${projectRoot}/uploads/${a.name}` : `uploads/${a.name}`}`
      ).join("\n");
      finalMessage = `${textToSend}\n\n[用户上传了以下文件，已放在项目目录下，可直接用 Read 读取]\n${attachmentInfo}`;
      // 清空附件列表
      setAttachments([]);
    }

    // 这一轮的写入上下文（reducer 在组件层，见 applyStreamEvent）——
    // 重挂补看时另建一份同样形状的，走的是同一个 reducer。
    const streamTurn: StreamTurn = {
      project: streamProject,
      aiMessageId,
      stillViewing,
      turn,
      lastToolParams: null,
    };

    // 这一次请求有没有失败（失败 = 内容归调用方处置，见函数头的返回值说明）
    let failed = false;
    try {
      // 获取启用的提示词替换规则
      const enabledReplacements = getEnabledReplacements();
      
      await sendChatMessage(
        {
          message: finalMessage,
          route: currentRoute,
          if_history: !isNewProject,
          // ── 原来这里是设置浮层里的四个开关，浮层现在只剩模型选择 ──
          // 值**按「开关开着」的默认值冻结**（不是随手删掉）：内核收到的东西
          // 必须和以前"用户没动过设置"时一致 —— 删 UI 不能顺手变成改行为。
          // （localStorage 里存的老 chat_settings 还留着这些键，但不再被读。）
          if_thinking: true,          // 原 settings.enableThinking（默认开）
          if_new_project: isNewProject,
          model: settings.model,
          continuous_chat: true,      // 原 settings.continuousChat（默认开）
          if_memory: true,            // 原 settings.enableMemory（默认开）
          project_id: projectId || undefined,
          prompt_replacements: enabledReplacements.length > 0 ? enabledReplacements : undefined,
          if_hot_reload: enableHotReload,
          if_recommend_files: true,   // 原 settings.enableRecommendFiles（默认开）
          attachments: currentAttachments.length > 0 ? currentAttachments.map(a => ({
            file_id: a.id,
            filename: a.name,
            mime_type: a.type,
            size: a.size,
          })) : undefined,
          // 关着的时候是 undefined —— JSON.stringify 会整个丢掉，请求体和以前一致
          mode: swarmOn ? "swarm" : undefined,
          ai_style_x: aiStyle.x,
          ai_style_y: aiStyle.y,
        },
        (event, seq) => {
          // 帧序号（内核才带）：记下「这个线程已经处理到哪儿了」——
          // 重挂时用 after=<它>，看过的帧不会再应用一遍（见下面的 attach effect）。
          if (seq !== null) seenSeqRef.current.set(streamProject, seq);
          // 事件全交给**共用**的那份 reducer（重挂补看用的是同一条路，见 applyStreamEvent）
          applyStreamEvent(event, streamTurn);
        }
      );
    } catch (error) {
      console.error("发送消息失败:", error);
      // 错误也要写进**这个会话的**镜像，别糊到用户正在看的别的会话上
      // （这里绕过 reducer：它开头的 stillViewing 闸门是给正常事件用的，
      //   报错必须落到这一轮的消息上，哪怕用户此刻在看别处）
      writeTurnMessages(streamProject, stillViewing, (prev) =>
        prev.map((msg) =>
          msg.id === aiMessageId
            ? { ...msg, content: `发送失败: ${error}`, error: true }
            : msg
        )
      );
      // 没发出去 → 告诉调用方（内容归它处置：放回输入框），别让它以为已经发出了
      failed = true;
    } finally {
      // 这条 POST 流收了 → 重挂的流可以再挂（见 liveSendRef；它不依赖这个时刻，
      // 这个删除是给下一次 projectId / visibilitychange 的重挂留的门）
      liveSendRef.current.delete(streamProject);
      // 帧序号每轮归零（内核 beginTurn）：这一轮看过的最大 seq 留着，
      // 下一轮（seq 又从 1 起）的 after 会大得离谱，重放一帧都补不到
      seenSeqRef.current.delete(streamProject);
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
      // 状态行的计时器退休（numbers 已经在 stats 里落定；这里是兜底 —— 中断/报错
      // 的那一轮没有 stats，停掉计时即可，上一轮的数字留着别动）
      if (turnRef.current?.project === streamProject) {
        turnRef.current = null;
      }
      // 这一轮的帧序号刚删掉（见上）——现在把常驻订阅挂回来：下一轮（可能由别的
      // 窗口/兜底发送开起来，例如新会话的第一条）才有人接。放在最后，保证挂的时候
      // seenSeqRef / liveSendRef 都已经是终态。
      setAttachTick((n) => n + 1);
    }
    return !failed;
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
          /**
           * 内核归一过的状态（见 CONTRACT.md）：running 就是**真的还在跑**（顶栏据此转圈，
           * 卡片页签也据此分「进行中」）。error / canceled 与 stale（重启后的僵尸）
           * 都算「没干成」——显示成失败，别让一条永远不动的记录冒充完成。
           */
          status: s.status === "running" ? "running"
            : s.status === "error" || s.status === "canceled" || s.status === "stale" ? "error"
            : "done",
          steps: [], stepCount: 0,
          // token 用量（路由从任务表带出来的那份）：null = 没记录 / 没上报
          usage: s.usage ?? undefined,
        })));
      })
      .catch(() => { /* 拉不到就算了，不影响实时通道 */ });
    return () => { alive = false; };
  }, [projectId]);

  /** 发新消息前：保留还在跑的子代理，清掉上一轮的已完成项 */
  const pruneSubagents = () => {
    setSubagents((prev) => (prev.length === 0 ? prev : prev.filter((a) => a.status === "running")));
  };

  /**
   * 把实时的子代理状态交给右侧面板（「后台 Agent」那一页）—— 见 lib/subagent-feed.ts。
   *
   * 面板和这里都是 App 下的兄弟组件，而 App.tsx 不归这次改动，所以走那条模块级的线。
   * 传的是**展示派生**（状态 + 实时时间线）：真相源仍是内核（SSE / 落盘的子线程），
   * 面板的列表与详情都是自己再去拉那两条接口。
   */
  useEffect(() => {
    publishSubagents(projectId ?? null, subagents.map((a) => ({
      id: a.id, label: a.label, background: a.background, status: a.status,
      steps: a.steps, stepCount: a.stepCount, usage: a.usage ?? null,
    })));
  }, [projectId, subagents]);

  const handleActionClick = (action: string) => {
    if (settings.suggestionAutoSend) {
      // 自动发送
      handleSend(action);
    } else {
      // 填入输入框
      setInput(action);
    }
  };

  /**
   * 回答提问 / 确认审批。
   *
   * remember 只有**审批**这条路会带（「同意并记住这个形状」，见 MessageList 的
   * AskUserInline）：内核据此把这次调用的形状落成会话规则。回答普通提问时不传。
   */
  const handleAskUserSubmit = async (messageId: string, answer: string | string[], remember?: boolean) => {
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
        await submitUserInput(currentSessionId.current, answerToSubmit, remember);
        console.log("用户输入已提交:", answerToSubmit, remember ? "（并记住）" : "");
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

  /** 队列：删除一条（只从队列拿掉，什么都不发） */
  const handleQueueRemove = (id: string) => {
    setQueued((prev) => removeQueuedMessage(prev, id));
  };

  /**
   * 队列：插话 —— 走 /api/steer，内核在**下一个 step 边界**折进当前回合
   * （不打断正在生成的那一步）。成功后这条出队；失败留在队列里，用户还能删或等它自动发。
   */
  const handleQueueSteer = async (item: QueuedMessage) => {
    if (!projectId) return;
    setSteeringId(item.id);
    try {
      await steerMessage(projectId, item.text);
      setQueued((prev) => removeQueuedMessage(prev, item.id));
      toast({ title: "已插话：下个 step 生效", description: item.text, tone: "success" });
    } catch (e) {
      toast({ title: "插话失败", description: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally {
      setSteeringId(null);
    }
  };

  /**
   * 草稿页排队搬家：第一条消息把项目建出来之后，挂在 "" 上的队列要迁到真实 id 上。
   * （不迁的话它们既不会显示、也永远不会被发出去。）
   */
  useEffect(() => {
    const prev = prevQueueKeyRef.current;
    prevQueueKeyRef.current = queueKey;
    if (prev === "" && queueKey !== "") {
      setQueued((q) => rekeyQueuedProject(q, prev, queueKey));
    }
  }, [queueKey]);

  /**
   * 回合结束（isLoading 从 true 变 false）且**本会话**队列非空 →
   * 取队首按正常发送路径发出，其余保留（别的会话排的原样不动）。
   *
   * 两条守卫：
   *   · isLoading —— 只在真正停下来的时候发；
   *   · drainGuard —— setQueued 摘队首 + handleSend 里同步 setIsLoading(true)
   *     本该在同一批里落地，这里再兜一层，绝不把第二条顺手发出去。
   *     isLoading 变 true 时把闸打开，供下一轮用。
   * 停止（stop）也会走到这里：停完队列不清空，下一条照发（见 handleStop）。
   */
  const drainGuardRef = useRef(false);
  useEffect(() => {
    if (isLoading) { drainGuardRef.current = false; return; }
    if (drainGuardRef.current) return;
    // 有提问在等就先别自动发：那会把消息当插话推进当前回合，问题依然没被回答
    if (pendingQuestion) return;
    const { head, rest } = takeQueueHead(queued, queueKey);
    if (!head) return;
    drainGuardRef.current = true;
    setQueued(rest);
    void handleSend(head.text);
  }, [isLoading, queued, queueKey, pendingQuestion]);

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

  /**
   * 「正在发送…」待发气泡的正文（Bug B）——有句话要去**这个**线程、但还没进消息列表。
   *
   * 两个来源，缺一不可：
   *   · pendingMessage（App 的）：任务还在建（projectId 为 null），或刚绑上端口、还没被接手；
   *   · sendingText（本组件的）：已经接手，但 handleSend 还在那次 switchToLatest 上等着 ——
   *     App 那边此时已经清掉了，没有它就又是「点了发送，列表里什么都没有」。
   * 带线程判据的原因和 pendingMessage 一样：中途导航时 A 的待发气泡不许挂在 B 上。
   */
  const pendingBubbleText = projectId
    ? sendingText && sendingText.projectId === projectId
      ? sendingText.text
      : pendingMessage && (pendingMessage.projectId === null || pendingMessage.projectId === projectId)
        ? pendingMessage.text
        : null
    : null;

  // ── 斜杠命令：/plan 开关 + /goal + 「+」菜单那三条 ──────
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
    // 下面三条和「+」菜单是同一批能力 —— 斜杠是**全集**，从哪儿都得能唤醒。
    // 都没有 insert（选中即清空输入框），动作由 handleSlashCommand 按 name 分派。
    { name: "file", title: "上传文件", description: "任意格式，落到任务的 uploads/，模型可直接读", hint: "Enter 执行", keywords: ["file", "upload", "wenjian", "上传", "附件"] },
    { name: "capture", title: "框选截屏", description: "框选屏幕，截图作为附件进这一轮", hint: "Enter 执行", keywords: ["capture", "screen", "截图", "jietu", "screenshot"] },
    { name: "swarm", title: "Swarm 模式", description: "用多个子代理并行处理", hint: "Enter 执行", keywords: ["swarm", "parallel", "并行", "bingxing"] },
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
    // 和项目页同名的三条（斜杠是全集）；这里还没有线程，文件 / 截屏点了会先提示"先建好任务"
    { name: "file", title: "上传文件", description: "任意格式，落到任务的 uploads/，模型可直接读", hint: "Enter 执行", keywords: ["file", "upload", "wenjian", "上传", "附件"] },
    { name: "capture", title: "框选截屏", description: "框选屏幕，截图作为附件进这一轮", hint: "Enter 执行", keywords: ["capture", "screen", "截图", "jietu", "screenshot"] },
    { name: "swarm", title: "Swarm 模式", description: "用多个子代理并行处理", hint: "Enter 执行", keywords: ["swarm", "parallel", "并行", "bingxing"] },
  ], [draftPlan]);

  const handleStartSlashCommand = (cmd: SlashCommand) => {
    if (cmd.name === "plan") { toggleDraftPlan(); return; }
    // 这三条和「+」菜单共用同一批 handler；Swarm / 计划一样是粘在本地的（建好任务后接着生效）
    if (cmd.name === "file") { triggerFilePick(); return; }
    if (cmd.name === "capture") { void handleCapture(); return; }
    if (cmd.name === "swarm") { toggleSwarm(); return; }
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
    // 「+」菜单那三条 —— 斜杠是全集，走的是同一批 handler
    if (cmd.name === "file") { triggerFilePick(); return; }
    if (cmd.name === "capture") { void handleCapture(); return; }
    if (cmd.name === "swarm") { toggleSwarm(); return; }
  };

  /** 左下角 chip 的「点击退出」和斜杠命令走同一条路 */
  const exitPlanMode = () => applyPlanMode(false);

  // ── 「+」菜单的条目 ─────────────────────────────────────
  // 两个页面同一批、同一顺序（/ 是全集，+ 是精选）。勾不勾**一律从真实状态派生**：
  // 计划看 planMode / draftPlan，目标看有没有目标，Swarm 看本地旗标 —— 不另开一份
  // 本地变量，否则会出现"模型已经退出计划模式、勾还亮着"那样的假象。
  // 数组每轮重建即可：条目就这几条、没有重计算，写成 useMemo 反而容易吃到旧闭包。
  const plusItems: PlusMenuItem[] = [
    { key: "file", label: "文件", hint: "任意格式（≤20MB），落到任务的 uploads/，模型可直接读", icon: <Paperclip className="size-4" />, onSelect: triggerFilePick },
    { key: "capture", label: "截屏", hint: "框选屏幕并评论", icon: <Scan className="size-4" />, onSelect: () => void handleCapture() },
    {
      key: "goal", label: "目标", hint: "设定目标并持续推进", icon: <Target className="size-4" />,
      on: !!goal,
      // 不在这里造目标：把输入框置成 /goal，交给既有的命令流程（和 /goal 菜单项同一条路）
      onSelect: () => { setInput("/goal "); focusComposer(); },
    },
    { key: "plan", label: "计划", hint: "先计划再动手", icon: <ClipboardList className="size-4" />, on: planMode, onSelect: () => applyPlanMode(!planMode) },
    { key: "swarm", label: "Swarm", hint: "用多个子代理并行处理", icon: <Network className="size-4" />, on: swarmOn, onSelect: toggleSwarm },
  ];

  /** 起始页的同名菜单：还没有线程，目标 / 计划落在草稿上（建好任务后由 App 落地） */
  const startPlusItems: PlusMenuItem[] = [
    { key: "file", label: "文件", hint: "任意格式（≤20MB），落到任务的 uploads/，模型可直接读", icon: <Paperclip className="size-4" />, onSelect: triggerFilePick },
    { key: "capture", label: "截屏", hint: "框选屏幕并评论", icon: <Scan className="size-4" />, onSelect: () => void handleCapture() },
    {
      key: "goal", label: "目标", hint: "设定目标并持续推进", icon: <Target className="size-4" />,
      on: !!draftGoal,
      onSelect: () => { setStartDraft("/goal "); focusComposer(); },
    },
    { key: "plan", label: "计划", hint: "先计划再动手", icon: <ClipboardList className="size-4" />, on: draftPlan, onSelect: toggleDraftPlan },
    { key: "swarm", label: "Swarm", hint: "用多个子代理并行处理", icon: <Network className="size-4" />, on: swarmOn, onSelect: toggleSwarm },
  ];

  // ── 左下角的模式药丸 ───────────────────────────────────
  // 已经装备上的模式摊成药丸（见 mode-chip.tsx），点了就关。
  // **和「+」菜单写的是同一份状态**：Swarm 就是上面那个 swarmOn / toggleSwarm，
  // 不另开一份本地变量（两份状态的下场就是药丸和菜单对不上）。
  // 计划模式**不在这里**：它有自己的 chip（在内核那条 permission 轴上，走 leftActions），
  // 再画一个就是第二颗了。以后要加模式：往这张表里追一条即可。
  const modeChips: ModeChipSpec[] = swarmOn
    ? [{
        key: "swarm",
        label: "Swarm",
        title: "Swarm 模式（点击取消）",
        icon: <Network className="size-3" />,
        onClear: toggleSwarm,
      }]
    : [];

  /**
   * 模型设置对话框 —— **一个状态、两份实例**（起始页 / 项目页各在自己的返回树里渲染一份）。
   * 两个 composer 都可以有，但同一时刻只会挂一个（两棵返回树是互斥的），
   * 所以这里只是一段可复用的 JSX，不需要为它开 portal。
   */
  const modelSettingsDialog = (
    <ModelSettingsDialog
      open={modelDialogOpen}
      onOpenChange={setModelDialogOpen}
      model={settings.model}
      onModelChange={applyModel}
    />
  );

  /**
   * 全窗口拖拽蒙层 —— 和上面那个对话框一样，**一份 JSX、两棵返回树各渲染一次**
   * （起始页 / 项目页互斥，同一时刻只会挂一个）。
   * 蒙层文案要说清「传到哪个项目」：拖进来的人最怕的就是不知道文件去哪了。
   */
  const dropOverlay = (
    <DropFilesOverlay
      targetLabel={
        projectId
          ? (projects.find((p) => p.port === projectId)?.display_name
            || projects.find((p) => p.port === projectId)?.name_text
            || `任务 ${projectId}`)
          : null
      }
      onFiles={handleDroppedFiles}
    />
  );

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
          {/* 建任务的整条链期间（建目录 → 落权限/计划/目标 → 选中）：这时还没有线程、
              消息列表也不存在，把那句话立在这儿 —— 用户至少看得见它没丢（Bug B）。
              建好任务后它会自动发出去（见 App.handleQuickCreateTask / ChatPanel 的 pendingMessage effect）。 */}
          {pendingMessage && pendingMessage.projectId === null && (
            <div className="mx-auto mb-2 flex w-full max-w-[860px] items-center gap-2 rounded-xl bg-surface-inset px-3 py-2 text-xs text-text-secondary">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span className="shrink-0">正在创建任务…</span>
              <span className="min-w-0 flex-1 truncate text-text-primary">{pendingMessage.text}</span>
            </div>
          )}
          {/* 宽度：860 = mnemo 起始页那张卡片的宽度（原来 640 太瘦，长句一眼就折行） */}
          <div ref={composerWrapRef} className="mx-auto w-full max-w-[860px]">
            {/* 卡片外观由 ComposerBox 统一提供（和项目页同一份实现，不再手搓第二张卡片）；
                左上角的项目 / 文件夹选择器改走 topLeft 插槽。 */}
            <ComposerBox
              autoFocus
              topLeft={
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
              }
                value={startDraft}
                onChange={setStartDraft}
                onSubmit={submitStartDraft}
                onPasteFiles={handleDroppedFiles}
                sendDisabled={!startDraft.trim()}
                sendTitle="创建任务并开始"
                placeholder={NEW_TASK_PLACEHOLDER}
                hint="Enter 开始 · Shift+Enter 换行"
                commands={startCommands}
                onSlashCommand={handleStartSlashCommand}
                // 已装备的模式（和「+」菜单写的是同一份状态，见 modeChips）
                chips={<ModeChips chips={modeChips} />}
                // 右下角：模型 chip（挨着发送按钮）。起始页也要有 —— 模型不是「项目设置」，
                // 是这一轮发给内核的字段之一。
                rightActions={<ModelChip value={settings.model} onChange={applyModel} saving={modelSaving} />}
                leftActions={
                  <>
                    {/* 「+」菜单在最前（文件 / 截屏 / 目标 / 计划 / Swarm）—— 和项目页同一份组件、同一批条目 */}
                    <ComposerPlusMenu items={startPlusItems} />
                    {/* 模型设置（API Key / Base URL / 模型）。**全局的一份**，和项目无关，
                        所以起始页也留入口 —— 第一次用的人通常先在这里说话。 */}
                    <ModelSettingsButton onOpen={() => setModelDialogOpen(true)} />
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
              />


          </div>
        </div>

        {/* 模型设置对话框（起始页这份实例；项目页另有一份，同一个状态） */}
        {modelSettingsDialog}
        {/* 拖进来就上传的蒙层（起始页没有任务可落，蒙层会把话说清） */}
        {dropOverlay}
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
        onContextMenu={onMessagesContextMenu}
      >
        {!isCompactMode && (
          <div className={`transition-all duration-300 ${shouldCenterContent ? 'max-w-2xl mx-auto' : ''}`}>
            <div className="mx-auto flex min-h-0 w-full max-w-[880px] flex-1 flex-col px-6">
              <MessageList
                messages={messages}
                pendingText={pendingBubbleText}
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
                projectId={projectId}
                onRolledBack={handleRolledBack}
              />
            </div>
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* 选中文字 → 右键「添加到评论」的菜单（只在上面这块消息区里出现） */}
      {quoteMenu}

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
        
        <div ref={composerWrapRef} className={`relative ${isCompactMode ? 'flex flex-1 flex-col' : ''}`}>
          {/* 隐藏的文件输入（入口在 ComposerBox 的「+」菜单里，见 leftActions 插槽） */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* 后台 Agent 那一排按钮 —— 输入框**上方**（对齐 Kimi Code）。
              没有子代理时组件自己返回 null，不占位置；点了在右侧面板开「后台 Agent」页。
              紧凑模式（那块 9/4 的小窗）里不显示：那里寸土寸金（与状态行同一个判据）。 */}
          {!isCompactMode && (
            <SubagentButtons
              agents={subagents}
              onOpen={requestOpenSubagentList}
              className="mx-auto mb-1 w-full max-w-[1000px]"
            />
          )}

          {/* 运行中的待发送队列 —— 输入框**上方**（空队列时组件自己返回 null，不占位置）。
              每行：删除 / 插话；插话只在真的有回合在跑时才可点。 */}
          <SteerQueueBar
            items={queueForProject(queued, queueKey)}
            onRemove={handleQueueRemove}
            onSteer={(item) => void handleQueueSteer(item)}
            canSteer={isLoading && !pendingQuestion}
            steeringId={steeringId}
            className="mx-auto w-full max-w-[880px]"
          />

          {/* 输入卡片 —— 和起始页**同一个 ComposerBox**（结构 / 发送按钮 / 斜杠菜单只有一份）。
              项目页多出来的东西（「+」菜单 / 权限 / 计划模式 / 设置 / 朗读）全走 leftActions 插槽，
              长期目标状态条走 topLeft 插槽 —— 没有目标时 GoalBar 自己返回 null，不占位置。
              模型 chip 走 rightActions（右下角，发送按钮左边）—— 起始页也一样。 */}
          <ComposerBox
            ref={composerRef}
            autoFocus
            value={input}
            onChange={setInput}
            onSubmit={() => handleSend()}
            onPasteFiles={handleDroppedFiles}
            placeholder={COMPOSER_PLACEHOLDER}
            hint="Enter 发送 · Shift+Enter 换行"
            sending={isLoading}
            onStop={handleStop}
            commands={slashCommands}
            onSlashCommand={handleSlashCommand}
            topLeft={goal ? <GoalBar goal={goal} pending={goalPending} onAction={runGoalBarAction} /> : undefined}
            className="mx-auto w-full max-w-[1000px]"
            // 已装备的模式（和「+」菜单写的是同一份状态，见 modeChips）
            chips={<ModeChips chips={modeChips} />}
            // 右下角：模型 chip（挨着发送按钮）
            rightActions={<ModelChip value={settings.model} onChange={applyModel} saving={modelSaving} />}
            textareaClassName={isCompactMode ? 'min-h-0 flex-1' : undefined}
            leftActions={
              <>
                {/* 「+」菜单在最前（文件 / 截屏 / 目标 / 计划 / Swarm）—— 和起始页同一份组件、同一批条目。
                    原来那个回形针按钮收进菜单的「文件」里：附件只剩这一个入口。上传中禁用，避免重复传。 */}
                <ComposerPlusMenu items={plusItems} disabled={isUploading} />
                {/* 模型设置（API Key / Base URL / 模型）—— 齿轮紧挨着「+」，和起始页同一份组件 */}
                <ModelSettingsButton onOpen={() => setModelDialogOpen(true)} />
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


            {/* 权限模式 —— 和新会话页**同一个组件** */}
            <PermissionSelect
              surface="session"
              value={permission}
              onChange={(m) => void changePermission(m)}
              disabled={!projectId}
              projectKey={projectId}
            />

            {/* 原来这里挂着一个「设置」浮层（里面只剩一张模型表）。现在：
                · 模型 → 右下角的 chip（见 model-chip.tsx）
                · 齿轮 → 上面那排 leftActions 里的「模型设置」对话框入口（API Key / Base URL / 模型）
                浮层里那四个开关（Think / Continuous Chat / Memory / Recommend Files）和朗读
                更早以前就撤了，值冻结在发消息的地方（见 handleSend）；朗读的 hook 和
                朗读中的暂停/停止按钮留着，之前已经开着的人不受影响，只是不再有入口去改。 */}
            
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

          {/* 状态行 —— 卡片**下面**那一行小字（轮/步/tok/s · 累计/缓存 · 上下文）。
              数据自己攒（见 statusLine / turnRef）：没数据时整条不渲染，跑着的时候步数是活的。
              宽度和卡片对齐（同一档 max-w），左右各缩进 8px 让数字别贴死卡片边。
              紧凑模式（那块 9/4 的小窗）里不显示：那里寸土寸金。 */}
          {!isCompactMode && (
            <ComposerStatusLine
              data={statusLine}
              model={settings.model}
              className="mx-auto mt-1.5 w-full max-w-[1000px] px-2"
            />
          )}
        </div>
        </div>{/* shouldCenterContent 内部容器闭合 */}
      </div>

      {/* 模型设置对话框（项目页这份实例；起始页另有一份，同一个状态） */}
      {modelSettingsDialog}

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

      {/* 拖进来就上传的蒙层（文案里写着会传到哪个任务） */}
      {railSlot && railItems.length >= 2 && createPortal(
        <PromptRail items={railItems} onJump={jumpToMessage} getScrollContainer={getMessagesScrollContainer} />,
        railSlot,
      )}

      {dropOverlay}
      </div>{/* 紧凑模式内部容器闭合 */}
    </div>
  );
}
