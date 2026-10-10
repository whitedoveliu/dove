"use client";

import { createContext, useContext, useMemo, useState, useRef, useEffect } from "react";
import { 
  MessageCircle, 
  Bot, 
  Wrench, 
  Eye, 
  FilePlus, 
  Pencil, 
  Trash2, 
  RefreshCw, 
  Search, 
  Hammer, 
  Palette, 
  BookOpen, 
  Image, 
  HelpCircle,
  Terminal,
  Database,
  Cloud,
  Key,
  ListTodo,
  Camera,
  History,
  FileText,
  Globe,
  Phone,
  Brain,
  CheckCircle,
  CheckCircle2,
  Sparkles,
  SearchCode,
  LucideIcon,
  Send,
  MessageSquareMore,
  Speech,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Lightbulb,
  Loader2,
  Circle,
  XCircle,
  CircleArrowRight,
  Upload,
  Clipboard,
  X
} from "lucide-react";
import { ToolActivityTrack, displayName, type ToolItem } from "@/components/tool-activity";
import { Input } from "@/components/ui/input";
import { Message } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sanitizeLogContent } from "@/lib/logs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import TodoPanel from "./TodoPanel";
import { PresentedFiles } from "@/components/presented-files";
import { PlanCard } from "@/components/plan-card";
import {
  extractPresentedFiles,
  matchPresentedPath,
  type PresentedFile,
} from "@/lib/presented-files";

/**
 * 交付物上下文：`Present` 声明过的文件路径 —— 正文里 inline-code 写的同一个路径
 * 也能点开预览（见 MarkdownContent 的 code 渲染器）。
 * 默认 null：这条消息没有交付物，一切渲染保持原样。
 */
const PresentedFileContext = createContext<{
  files: PresentedFile[];
  open?: (path: string) => void;
} | null>(null);

interface MessageListProps {
  messages: Message[];
  onActionClick?: (action: string) => void;
  isLoading?: boolean;
  isSwitchingVersion?: boolean;  // 是否正在切换版本
  showLogs?: boolean;
  onAskUserSubmit?: (messageId: string, answer: string | string[]) => void;
  onVersionClick?: (commitHash: string, versionNumber: number) => void;
  onRestoreConfirm?: (messageId: string) => void;
  onRestoreCancel?: (messageId: string) => void;
  onScreenshotSubmit?: (messageId: string, sessionId: string, screenshot: string) => void;
  onScreenshotCancel?: (sessionId: string) => void;
  onRetry?: () => void;  // 重试
  /** 打开项目内文件（交付物卡片 / 正文路径点击）——接到右侧预览面板 */
  onOpenFile?: (path: string) => void;
}

// Restore Confirm 内联组件
function RestoreConfirmInline({
  confirmData,
  onConfirm,
  onCancel,
  confirmed,
  userChoice
}: {
  confirmData: {
    target_version: number;
    target_timestamp: string;
    target_message: string;
    current_version: number;
  };
  onConfirm: () => void;
  onCancel: () => void;
  confirmed?: boolean;
  userChoice?: "confirm" | "cancel";
}) {
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [choice, setChoice] = useState<"confirm" | "cancel" | null>(null);

  const handleConfirm = () => {
    if (isSubmitted) return;
    setIsSubmitted(true);
    setChoice("confirm");
    onConfirm();
  };

  const handleCancel = () => {
    if (isSubmitted) return;
    setIsSubmitted(true);
    setChoice("cancel");
    onCancel();
  };

  // 已确认状态（来自 props 或本地状态）
  const showConfirmed = confirmed || isSubmitted;
  const displayChoice = userChoice || choice;

  if (showConfirmed) {
    return (
      <div className="mt-3 space-y-2 pb-3 border-b border-dashed border-muted-foreground/30">
        <div className="flex items-start gap-2">
          <History className="w-4 h-4 text-muted-foreground/50 mt-0.5 shrink-0" />
          <div className="text-sm text-muted-foreground/70">
            从版本 {confirmData.target_version} 继续
          </div>
        </div>
        <div className="flex items-start gap-2">
          <CheckCircle className="w-4 h-4 text-muted-foreground/50 mt-0.5 shrink-0" />
          <p className="text-sm text-muted-foreground/70">
            {displayChoice === "confirm" ? `已从版本 ${confirmData.target_version} 继续` : "已取消"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {/* 恢复信息 */}
      <div className="p-3 rounded-lg bg-muted/50 border border-border/50">
        <div className="flex items-center gap-2 mb-2">
          <History className="w-4 h-4 text-primary/70" />
          <span className="text-sm font-medium">从版本 {confirmData.target_version} 继续</span>
          <span className="text-xs text-muted-foreground/60">{confirmData.target_timestamp}</span>
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          <p>接下来将基于版本 {confirmData.target_version} 进行修改，并创建为新版本 {confirmData.current_version + 1}。</p>
          <p>中间的版本会被收起，但不会丢失，随时可以查看。</p>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex gap-2">
        <Button
          onClick={handleCancel}
          variant="outline"
          size="sm"
          className="text-xs h-8"
        >
          取消
        </Button>
        <Button
          onClick={handleConfirm}
          size="sm"
          className="text-xs h-8"
        >
          确认
        </Button>
      </div>
    </div>
  );
}

// Ask User 内联组件
function AskUserInline({
  question,
  questionType = "single",
  suggestions,
  onSubmit,
  answered,
  userAnswer
}: {
  question: string;
  questionType?: "single" | "multiple";
  suggestions?: string[];
  onSubmit: (answer: string | string[]) => void;
  answered?: boolean;
  userAnswer?: string | string[];
}) {
  const [inputValue, setInputValue] = useState("");
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submittedAnswer, setSubmittedAnswer] = useState<string | string[]>("");

  // 单选提交
  const handleSingleSubmit = (value: string) => {
    if (!value.trim() || isSubmitted) return;
    setIsSubmitted(true);
    setSubmittedAnswer(value);
    onSubmit(value);
  };

  // 多选切换
  const toggleSelection = (item: string) => {
    if (isSubmitted) return;
    setSelectedItems(prev => 
      prev.includes(item) 
        ? prev.filter(i => i !== item)
        : [...prev, item]
    );
  };

  // 多选提交
  const handleMultipleSubmit = () => {
    // 合并选中的预设选项和自定义输入
    const finalAnswers = [...selectedItems];
    if (inputValue.trim()) {
      finalAnswers.push(inputValue.trim());
    }
    
    if (finalAnswers.length === 0 || isSubmitted) return;
    setIsSubmitted(true);
    setSubmittedAnswer(finalAnswers);
    onSubmit(finalAnswers);
  };

  // 已回复状态（来自 props 或本地状态）
  const showAnswered = answered || isSubmitted;
  const displayAnswer = userAnswer || submittedAnswer;

  // 格式化显示答案
  const formatAnswer = (answer: string | string[]) => {
    if (Array.isArray(answer)) {
      return answer.join("、");
    }
    return answer;
  };

  if (showAnswered) {
    return (
      <div className="mt-3 space-y-2 pb-3 border-b border-dashed border-muted-foreground/30">
        {/* 问题 */}
        <div className="flex items-start gap-2">
          <MessageSquareMore className="w-4 h-4 text-muted-foreground/50 mt-0.5 shrink-0" />
          <p className="text-sm text-muted-foreground/70">{question}</p>
        </div>
        {/* 回复 */}
        <div className="flex items-start gap-2">
          <Speech className="w-4 h-4 text-muted-foreground/50 mt-0.5 shrink-0" />
          <p className="text-sm text-muted-foreground/70">{formatAnswer(displayAnswer)}</p>
        </div>
      </div>
    );
  }

  // 多选模式
  if (questionType === "multiple") {
    return (
      <div className="mt-3 space-y-2.5">
        {/* 问题 */}
        <div className="flex items-start gap-2">
          <MessageSquareMore className="w-4 h-4 text-primary/70 mt-0.5 shrink-0" />
          <p className="text-sm">{question}</p>
          <span className="text-xs text-muted-foreground/60 ml-1">(可多选)</span>
        </div>

        {/* 多选选项 */}
        {suggestions && Array.isArray(suggestions) && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((suggestion, idx) => {
              const isSelected = selectedItems.includes(suggestion);
              return (
                <Button
                  key={idx}
                  onClick={() => toggleSelection(suggestion)}
                  variant={isSelected ? "default" : "outline"}
                  size="sm"
                  className={cn(
                    "text-xs h-7 font-normal transition-all",
                    isSelected 
                      ? "bg-primary text-primary-foreground" 
                      : "text-foreground/80 hover:bg-muted"
                  )}
                >
                  {isSelected && <CheckCircle2 className="w-3 h-3 mr-1" />}
                  {suggestion}
                </Button>
              );
            })}
          </div>
        )}

        {/* 自定义输入（其他选项） */}
        <div className="flex gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleMultipleSubmit();
              }
            }}
            placeholder="或输入其他选项..."
            className="flex-1 h-8 text-sm"
          />
        </div>

        {/* 已选择提示和提交按钮 */}
        <div className="flex items-center gap-2">
          {(selectedItems.length > 0 || inputValue.trim()) && (
            <span className="text-xs text-muted-foreground">
              {selectedItems.length > 0 && `已选择 ${selectedItems.length} 项`}
              {selectedItems.length > 0 && inputValue.trim() && " + "}
              {inputValue.trim() && "自定义内容"}
            </span>
          )}
          <Button
            onClick={handleMultipleSubmit}
            disabled={selectedItems.length === 0 && !inputValue.trim()}
            size="sm"
            className="h-8 px-4 ml-auto"
          >
            <Send className="w-3.5 h-3.5 mr-1" />
            确认
          </Button>
        </div>
      </div>
    );
  }

  // 单选模式（默认）
  return (
    <div className="mt-3 space-y-2.5">
      {/* 问题 */}
      <div className="flex items-start gap-2">
        <MessageSquareMore className="w-4 h-4 text-primary/70 mt-0.5 shrink-0" />
        <p className="text-sm">{question}</p>
      </div>

      {/* 建议选项 */}
      {suggestions && Array.isArray(suggestions) && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((suggestion, idx) => (
            <Button
              key={idx}
              onClick={() => handleSingleSubmit(suggestion)}
              variant="outline"
              size="sm"
              className="text-xs h-7 font-normal text-foreground/80"
            >
              {suggestion}
            </Button>
          ))}
        </div>
      )}

      {/* 自定义输入 */}
      <div className="flex gap-2">
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSingleSubmit(inputValue);
            }
          }}
          placeholder="输入回复..."
          className="flex-1 h-8 text-sm"
        />
        <Button
          onClick={() => handleSingleSubmit(inputValue)}
          disabled={!inputValue.trim()}
          size="sm"
          className="h-8 px-3"
        >
          <Send className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// 截图请求内嵌组件
function ScreenshotRequestInline({
  instruction,
  onSubmit,
  onCancel,
  submitted,
  cancelled,
  screenshotPreview
}: {
  instruction: string;
  onSubmit: (screenshot: string) => void;
  onCancel: () => void;
  submitted?: boolean;
  cancelled?: boolean;
  screenshotPreview?: string;
}) {
  const [previewImage, setPreviewImage] = useState<string | null>(screenshotPreview || null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 监听全局粘贴事件（组件挂载时）
  useEffect(() => {
    if (submitted || cancelled) return;

    const handleGlobalPaste = (e: ClipboardEvent) => {
      // 只在组件可见时处理
      if (!containerRef.current) return;
      
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault(); // 阻止默认粘贴行为
          const file = item.getAsFile();
          if (file) {
            handleImageFile(file);
          }
          break;
        }
      }
    };

    window.addEventListener("paste", handleGlobalPaste);
    return () => window.removeEventListener("paste", handleGlobalPaste);
  }, [submitted, cancelled]);

  // 已取消状态
  if (cancelled) {
    return (
      <div className="mt-3 space-y-2 pb-3 border-b border-dashed border-border/40">
        {/* 指示 */}
        <div className="flex items-start gap-2">
          <Camera className="w-4 h-4 text-muted-foreground/50 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-muted-foreground line-through opacity-60">{instruction}</p>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <XCircle className="w-3 h-3" />
              已取消
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 处理图片文件
  const handleImageFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      alert("请选择图片文件");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setPreviewImage(result);
    };
    reader.readAsDataURL(file);
  };

  // 处理文件选择
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await handleImageFile(file);
    }
  };

  // 处理拖拽
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file) {
      await handleImageFile(file);
    }
  };

  // 提交截图
  const handleSubmitScreenshot = () => {
    if (previewImage) {
      // 提取纯 base64 数据（去掉 data:image/xxx;base64, 前缀）用于提交
      let base64Data = previewImage;
      if (previewImage.includes(',')) {
        base64Data = previewImage.split(',')[1];
      }
      // 提交纯 base64 数据
      onSubmit(base64Data);
    }
  };

  // 已提交状态
  if (submitted) {
    // 如果 screenshotPreview 是纯 base64（不含前缀），加上前缀
    const imageUrl = screenshotPreview && !screenshotPreview.startsWith('data:')
      ? `data:image/png;base64,${screenshotPreview}`
      : screenshotPreview;
    
    return (
      <div className="mt-3 space-y-2 pb-3 border-b border-dashed border-border/40">
        {/* 指示 */}
        <div className="flex items-start gap-2">
          <Camera className="w-4 h-4 text-success mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-muted-foreground">{instruction}</p>
            <p className="text-xs text-success flex items-center gap-1 mt-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-success"></span>
              已提交
            </p>
          </div>
        </div>
        {/* 截图预览 */}
        {imageUrl && (
          <div className="ml-6">
            <img
              src={imageUrl}
              alt="用户提供的截图"
              className="max-w-full h-auto rounded-md border border-border/50 shadow-sm"
              style={{ maxHeight: "200px" }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="mt-3 space-y-3 rounded-lg border border-primary/30 bg-gradient-to-br from-primary/5 to-primary/10 p-4 shadow-sm"
    >
      {/* 指示 */}
      <div className="flex items-start gap-2">
        <Camera className="w-4 h-4 text-primary mt-0.5 shrink-0" />
        <p className="text-sm font-medium text-foreground leading-relaxed">{instruction}</p>
      </div>

      {/* 截图预览 */}
      {previewImage ? (
        <div className="space-y-3">
          <div className="relative group rounded-lg overflow-hidden border border-border shadow-md">
            <img
              src={previewImage}
              alt="截图预览"
              className="w-full h-auto"
              style={{ maxHeight: "320px", objectFit: "contain" }}
            />
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute top-2 right-2 w-7 h-7 rounded-md bg-danger/90 text-white flex items-center justify-center hover:bg-danger-hover transition-all shadow-lg opacity-0 group-hover:opacity-100"
              title="删除截图"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleSubmitScreenshot}
              size="sm"
              className="flex-1 h-9 gap-1.5 shadow-sm"
            >
              <Send className="w-3.5 h-3.5" />
              提交截图
            </Button>
            <Button
              onClick={onCancel}
              variant="outline"
              size="sm"
              className="h-9 px-4"
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {/* 拖拽上传区域 */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn(
              "relative rounded-lg border-2 border-dashed transition-all cursor-pointer",
              isDragging 
                ? "border-primary bg-primary/10 scale-[0.99]" 
                : "border-primary/40 hover:border-primary/60 hover:bg-accent/50"
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="py-8 px-4 text-center">
              <Upload className="w-8 h-8 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground mb-1">
                {isDragging ? "释放以上传" : "点击或拖拽上传"}
              </p>
              <p className="text-xs text-muted-foreground mb-2">
                支持 PNG、JPG、GIF 等格式
              </p>
              <p className="text-xs text-primary/70 flex items-center justify-center gap-1.5">
                <span className="inline-block w-1 h-1 rounded-full bg-primary animate-pulse"></span>
                按 Cmd/Ctrl + V 可直接粘贴图片
              </p>
            </div>
          </div>

          {/* 取消按钮 */}
          <div className="flex justify-end">
            <Button
              onClick={onCancel}
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-muted-foreground hover:text-foreground"
            >
              取消
            </Button>
          </div>

          {/* 隐藏的文件输入 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>
      )}
    </div>
  );
}

// Text Shimmer 组件 - 工具执行中的闪烁效果
function TextShimmer({ 
  children, 
  className = "" 
}: { 
  children: React.ReactNode; 
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex animate-shimmer bg-clip-text text-transparent",
        "bg-[length:200%_100%]",
        "bg-[linear-gradient(110deg,hsl(var(--muted-foreground)/0.5),45%,hsl(var(--foreground)),55%,hsl(var(--muted-foreground)/0.5))]",
        className
      )}
    >
      {children}
    </span>
  );
}

// Thinking 展示组件 - 生成中显示内容，完成后可展开查看
function ThinkingDisplay({
  content,
  isGenerating,
}: {
  content?: string;
  isGenerating: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  // 生成完成后（或历史消息），显示可展开的标识
  if (!isGenerating) {
    return (
      <div className="text-xs font-mono">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 text-muted-foreground/70 hover:text-muted-foreground transition-colors"
        >
          <Brain className="w-3 h-3 flex-shrink-0" />
          <span>Thinking</span>
          <ChevronDown className={cn(
            "w-3 h-3 transition-transform",
            isExpanded ? "rotate-0" : "-rotate-90"
          )} />
        </button>
        {isExpanded && content && (
          <div className="mt-2 ml-5 p-2 rounded bg-muted/50 text-muted-foreground/70 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
            {content}
          </div>
        )}
      </div>
    );
  }

  // 生成中：显示最后 3 行内容
  const lines = (content || '').split('\n').filter(line => line.trim());
  const displayLines = lines.slice(-3);
  const displayText = displayLines.join('\n');

  return (
    <div className="flex items-start gap-2 text-xs font-mono">
      <Brain className="w-3 h-3 text-muted-foreground mt-0.5 flex-shrink-0 animate-pulse" />
      <div className="flex-1 min-w-0">
        <TextShimmer>
          <span>Thinking...</span>
        </TextShimmer>
        {displayText && (
          <div className="mt-1 text-muted-foreground/70 line-clamp-3 whitespace-pre-wrap break-words">
            {displayText}
          </div>
        )}
      </div>
    </div>
  );
}

function LogEventDisplay({
  content,
  isLive,
}: {
  content?: string;
  isLive: boolean;
}) {
  const logText = sanitizeLogContent(content);
  if (!logText) return null;

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-mono uppercase tracking-wide text-muted-foreground/80">
        <Terminal className={cn("h-3 w-3", isLive && "animate-pulse")} />
        <span>运行日志</span>
        {isLive && <span className="text-primary">Live</span>}
      </div>
      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground/90">
        {logText}
      </pre>
    </div>
  );
}

// Todo 更新展示组件 - 可折叠，默认收起
function TodoUpdateDisplay({
  todos,
}: {
  todos: Array<{ id: string; content?: string; status?: string }>;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (todos.length === 0) return null;

  const getStatusIcon = (status?: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="w-3 h-3 flex-shrink-0 text-success" />;
      case 'in_progress':
        return <CircleArrowRight className="w-3 h-3 flex-shrink-0 text-info" />;
      case 'cancelled':
        return <XCircle className="w-3 h-3 flex-shrink-0 text-muted-foreground/50" />;
      default: // pending
        return <Circle className="w-3 h-3 flex-shrink-0 text-muted-foreground/30" />;
    }
  };

  const getTextClass = (status?: string) => {
    switch (status) {
      case 'completed':
        return "text-muted-foreground/70";
      case 'in_progress':
        return "text-muted-foreground";
      case 'cancelled':
        return "text-muted-foreground/50 line-through";
      default:
        return "text-muted-foreground/70";
    }
  };

  return (
    <div className="text-xs font-mono">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-muted-foreground/70 hover:text-muted-foreground transition-colors"
      >
        <ListTodo className="w-3 h-3 flex-shrink-0" />
        <span>Update Todo</span>
        <ChevronDown className={cn(
          "w-3 h-3 transition-transform",
          isExpanded ? "rotate-0" : "-rotate-90"
        )} />
      </button>
      {isExpanded && (
        <div className="mt-2 ml-5 p-2 rounded bg-muted/50 space-y-1">
          {todos.map((todo, i) => (
            <div key={todo.id || i} className="flex items-center gap-2">
              {getStatusIcon(todo.status)}
              <span className={getTextClass(todo.status)}>{todo.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 工具图标映射
function getToolIcon(toolName: string): LucideIcon {
  const iconMap: Record<string, LucideIcon> = {
    // 文件操作
    "read_files": Eye,
    "new_file": FilePlus,
    "edit_file": Pencil,
    "delete_file": Trash2,
    "rename_file": RefreshCw,
    "search_in_files": Search,
    "str_replace_based_edit_tool": Pencil,
    "quick_edit_page": Pencil,
    
    // 构建和设计
    "build_project_check": Hammer,
    "design_layout": Palette,
    "design_system_planning": Palette,
    
    // React Bits
    "get_react_bits_list": Search,
    "get_react_bits_documentation": BookOpen,
    "install_react_bits": Wrench,
    
    // 图片相关
    "generate_images": Image,
    "edit_image_ai": Image,
    "get_url_screenshot": Camera,
    
    // 用户交互
    "ask_user": HelpCircle,
    "ask_user_for_secret": Key,
    
    // 搜索和文档
    "search_help_docs": Search,
    "search_library_docs": Search,
    "get_library_documentation": BookOpen,
    "web_search": Globe,
    "code_search": SearchCode,  // AI 代码搜索
    
    // 数据库和部署 (Dove Cloud)
    "connect_dove_cloud": Cloud,
    "execute_sql": Database,
    "deploy_edge_function": Cloud,
    "get_supabase_secret_list": Key,
    
    // 命令和历史
    "run_command": Terminal,
    "get_history_version_code": History,
    "read_console_logs": FileText,
    "read_network_requests": Globe,
    
    // 其他
    "save_todo": ListTodo,
    "get_form_url": Globe,
    "add_dove_call": Phone,
    "memory": Brain,
    "sub_agent": Sparkles,
    "finish": CheckCircle,
    "todo_write": ListTodo,
  };
  
  return iconMap[toolName] || Wrench;
}

// 格式化工具信息，提取简洁的参数显示
function formatToolInfo(toolName: string, info?: string): string {
  if (!info) return "";
  
  // 根据工具类型提取关键参数
  // 常见格式: "file_path: xxx", "path: xxx", "query: xxx" 等
  const keyMappings: Record<string, string[]> = {
    // 文件操作工具 - 提取路径
    "edit_file": ["file_path", "path"],
    "new_file": ["file_path", "path"],
    "read_files": ["file_paths", "file_path", "path"],
    "delete_file": ["file_path", "path"],
    "rename_file": ["old_path", "new_path"],
    "str_replace_based_edit_tool": ["path"],
    "quick_edit_page": ["file_path", "path"],
    // 搜索工具 - 提取查询
    "search_in_files": ["query", "search", "keyword"],
    "search_context7": ["query"],
    "get_docs_context7": ["query"],
    "code_search": ["query"],  // AI 代码搜索
    // URL 工具 - 提取 URL
    "get_url_screenshot": ["url"],
    "get_form_url": ["url"],
    // 命令工具 - 提取命令
    "run_command": ["command"],
    // 数据库工具 - 提取描述
    "execute_sql": ["description"],
    "deploy_edge_function": ["function_name", "function_slug"],
  };
  
  const keys = keyMappings[toolName] || ["file_path", "path", "query", "url", "command"];
  
  // 尝试从 info 中提取值
  for (const key of keys) {
    // 匹配 "key: value" 格式
    const regex = new RegExp(`${key}:\\s*([^,\\n]+)`, 'i');
    const match = info.match(regex);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  // 如果 info 本身就是简单路径（没有 key: 前缀），直接返回
  if (info.includes('/') && !info.includes(':')) {
    return info;
  }
  
  // 返回截断的 info
  return info.length > 60 ? info.substring(0, 60) + '...' : info;
}

// 解析消息中的 next-step-action 标签
function parseNextStepActions(content: string): { actions: string[]; cleanContent: string } {
  const actionRegex = /<next-step-action>(.*?)<\/next-step-action>/g;
  const actions: string[] = [];
  let match;
  
  while ((match = actionRegex.exec(content)) !== null) {
    actions.push(match[1].trim());
  }
  
  const cleanContent = content.replace(actionRegex, '').trim();
  
  return { actions, cleanContent };
}

// Markdown 组件配置
function MarkdownContent({ content }: { content: string }) {
  // 交付物上下文：命中时 inline-code 渲染成可点开的预览入口
  const presented = useContext(PresentedFileContext);
  return (
    <div className="text-sm leading-relaxed prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
        // 代码块配置
        code({ node, inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '');
          const isBlock = !inline && !!match;
          // 正文里写成 inline-code 的交付物路径 → 可点击，点开右侧预览面板。
          // 只认「已在这条消息里被 Present 声明过」的路径，其余 inline-code 原样渲染。
          if (!isBlock && presented?.open) {
            // 用**原始** children 判多行：围栏代码块即使没写语言也会带换行，不能当成 inline
            const rawText = String(children ?? "");
            const text = rawText.trim();
            const hit = text && !rawText.includes("\n") ? matchPresentedPath(text, presented.files) : null;
            if (hit) {
              return (
                <button
                  type="button"
                  title={`预览 ${hit.path}`}
                  onClick={() => presented.open?.(hit.path)}
                  className={cn(
                    "px-1.5 py-0.5 rounded bg-surface-inset text-text-primary text-[0.875em] font-mono",
                    "cursor-pointer underline decoration-dotted underline-offset-2 transition-colors duration-fast hover:bg-surface-hover",
                    className
                  )}
                >
                  {children}
                </button>
              );
            }
          }
          return isBlock ? (
            <SyntaxHighlighter
              style={vscDarkPlus}
              language={match[1]}
              PreTag="div"
              customStyle={{
                margin: '0.5rem 0',
                borderRadius: '0.375rem',
                fontSize: '0.875rem',
              }}
              {...props}
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          ) : (
            <code className={cn("px-1.5 py-0.5 rounded bg-surface-inset text-text-primary text-[0.875em] font-mono", className)} {...props}>
              {children}
            </code>
          );
        },
        // 链接样式
        a({ node, children, ...props }: any) {
          return (
            <a
              className="text-primary hover:underline"
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            >
              {children}
            </a>
          );
        },
        // 列表样式
        ul({ node, children, ...props }: any) {
          return <ul className="list-disc my-2 space-y-1 pl-5" {...props}>{children}</ul>;
        },
        ol({ node, children, ...props }: any) {
          return <ol className="list-decimal my-2 space-y-1 pl-5" {...props}>{children}</ol>;
        },
        // 引用块样式
        blockquote({ node, children, ...props }: any) {
          return (
            <blockquote className="border-l-4 border-muted-foreground/30 pl-4 py-2 my-2 italic text-muted-foreground" {...props}>
              {children}
            </blockquote>
          );
        },
        // 标题样式
        h1({ node, children, ...props }: any) {
          return <h1 className="text-lg font-bold mt-4 mb-2" {...props}>{children}</h1>;
        },
        h2({ node, children, ...props }: any) {
          return <h2 className="text-base font-bold mt-3 mb-2" {...props}>{children}</h2>;
        },
        h3({ node, children, ...props }: any) {
          return <h3 className="text-sm font-bold mt-2 mb-1" {...props}>{children}</h3>;
        },
        // 段落样式
        p({ node, children, ...props }: any) {
          return <p className="my-2" {...props}>{children}</p>;
        },
        // 表格样式
        table({ node, children, ...props }: any) {
          return (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full border-collapse border border-muted" {...props}>
                {children}
              </table>
            </div>
          );
        },
        th({ node, children, ...props }: any) {
          return <th className="border border-muted px-3 py-2 bg-muted/50 font-semibold text-left" {...props}>{children}</th>;
        },
        td({ node, children, ...props }: any) {
          return <td className="border border-muted px-3 py-2" {...props}>{children}</td>;
        },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// 折叠状态的按钮（未展开时显示）
function SkippedMessagesCollapsed({
  messages,
  onExpand,
}: {
  messages: Message[];
  onExpand: () => void;
}) {
  const count = messages.length;
  const versionCount = messages.filter(m => m.version_number).length;
  
  return (
    <div className="my-2">
      <button
        onClick={onExpand}
        className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-muted/30 hover:bg-muted/50 border border-dashed border-muted-foreground/20 transition-colors group"
      >
        <History className="w-3.5 h-3.5 text-muted-foreground/50" />
        <span className="text-xs text-muted-foreground/70">
          已跳过 {count} 条消息{versionCount > 0 ? `（${versionCount} 个版本）` : ""}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/50" />
      </button>
    </div>
  );
}

// 展开状态的收起按钮（sticky 粘在顶部）
function StickyCollapseButton({
  onCollapse,
}: {
  onCollapse: () => void;
}) {
  return (
    <div className="sticky top-0 z-10 py-2 bg-background/95">
      <button
        onClick={onCollapse}
        className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-muted/50 hover:bg-muted/70 border border-dashed border-muted-foreground/30 transition-colors"
      >
        <History className="w-3.5 h-3.5 text-muted-foreground/70" />
        <span className="text-xs text-muted-foreground">
          收起跳过的消息
        </span>
        <ChevronUp className="w-3.5 h-3.5 text-muted-foreground/70" />
      </button>
    </div>
  );
}

export default function MessageList({
  messages,
  onActionClick,
  isLoading,
  isSwitchingVersion,
  showLogs = true,
  onAskUserSubmit,
  onVersionClick,
  onRestoreConfirm,
  onRestoreCancel,
  onScreenshotSubmit,
  onScreenshotCancel,
  onRetry,
  onOpenFile,
}: MessageListProps) {
  // 跟踪哪些折叠区域被展开了
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  
  // 找到最新的用户消息 ID（不包括被跳过的）
  const latestUserMessageId = [...messages].reverse().find(m => m.role === "user" && !m.skipped_by_restore)?.id;
  
  const toggleGroup = (groupIndex: number) => {
    setExpandedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(groupIndex)) {
        newSet.delete(groupIndex);
      } else {
        newSet.add(groupIndex);
      }
      return newSet;
    });
  };
  
  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <img 
              src="/logo.png" 
              alt="Logo" 
              className="w-16 h-16 object-contain"
            />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">开始与 AI Agent 对话</p>
            <p className="text-xs text-muted-foreground mt-1">输入消息并按 Enter 发送</p>
          </div>
        </div>
      </div>
    );
  }

  // 将消息分组：连续的 skipped 消息放在一起
  const messageGroups: Array<{ type: 'normal' | 'skipped'; messages: Message[]; groupIndex: number }> = [];
  let currentGroup: Message[] = [];
  let currentType: 'normal' | 'skipped' = 'normal';
  let groupIndex = 0;
  
  for (const message of messages) {
    const isSkipped = message.skipped_by_restore === true;
    const messageType = isSkipped ? 'skipped' : 'normal';
    
    if (messageType !== currentType && currentGroup.length > 0) {
      messageGroups.push({ type: currentType, messages: currentGroup, groupIndex: groupIndex++ });
      currentGroup = [];
    }
    
    currentType = messageType;
    currentGroup.push(message);
  }
  
  if (currentGroup.length > 0) {
    messageGroups.push({ type: currentType, messages: currentGroup, groupIndex: groupIndex });
  }

  return (
    <div className="p-4 space-y-3">
      {messageGroups.map((group) => {
        if (group.type === 'skipped') {
          const isExpanded = expandedGroups.has(group.groupIndex);
          
          if (!isExpanded) {
            // 折叠状态：显示折叠按钮
            return (
              <SkippedMessagesCollapsed
                key={`group-${group.groupIndex}`}
                messages={group.messages}
                onExpand={() => toggleGroup(group.groupIndex)}
              />
            );
          }
          
          // 展开状态：显示 sticky 收起按钮 + 消息列表
          return (
            <div key={`group-${group.groupIndex}`}>
              <StickyCollapseButton onCollapse={() => toggleGroup(group.groupIndex)} />
              {group.messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  messages={messages}
                  isLoading={isLoading}
                  isSwitchingVersion={isSwitchingVersion}
                  showLogs={showLogs}
                  onActionClick={onActionClick}
                  onAskUserSubmit={onAskUserSubmit}
                  onVersionClick={onVersionClick}
                  onRestoreConfirm={onRestoreConfirm}
                  onRestoreCancel={onRestoreCancel}
                  onScreenshotSubmit={onScreenshotSubmit}
                  onScreenshotCancel={onScreenshotCancel}
                  onRetry={onRetry}
                  onOpenFile={onOpenFile}
                  isSkipped={true}
                  isLatestUserMessage={message.id === latestUserMessageId}
                />
              ))}
            </div>
          );
        }
        
        return group.messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            messages={messages}
            isLoading={isLoading}
            isSwitchingVersion={isSwitchingVersion}
            showLogs={showLogs}
            onActionClick={onActionClick}
            onAskUserSubmit={onAskUserSubmit}
            onVersionClick={onVersionClick}
            onRestoreConfirm={onRestoreConfirm}
            onRestoreCancel={onRestoreCancel}
            onScreenshotSubmit={onScreenshotSubmit}
            onScreenshotCancel={onScreenshotCancel}
            onRetry={onRetry}
            onOpenFile={onOpenFile}
            isSkipped={false}
            isLatestUserMessage={message.id === latestUserMessageId}
          />
        ));
      })}
    </div>
  );
}

// 单个消息项组件
function MessageItem({
  message,
  messages,
  isLoading,
  isSwitchingVersion,
  showLogs,
  onActionClick,
  onAskUserSubmit,
  onVersionClick,
  onRestoreConfirm,
  onRestoreCancel,
  onScreenshotSubmit,
  onScreenshotCancel,
  onRetry,
  onOpenFile,
  isSkipped,
  isLatestUserMessage,
}: {
  message: Message;
  messages: Message[];
  isLoading?: boolean;
  isSwitchingVersion?: boolean;
  showLogs?: boolean;
  onActionClick?: (action: string) => void;
  onAskUserSubmit?: (messageId: string, answer: string | string[]) => void;
  onVersionClick?: (commitHash: string, versionNumber: number) => void;
  onRestoreConfirm?: (messageId: string) => void;
  onRestoreCancel?: (messageId: string) => void;
  onScreenshotSubmit?: (messageId: string, sessionId: string, screenshot: string) => void;
  onScreenshotCancel?: (sessionId: string) => void;
  onRetry?: () => void;
  /** 打开项目内文件预览（交付物卡片 / 正文路径） */
  onOpenFile?: (path: string) => void;
  isSkipped: boolean;
  isLatestUserMessage?: boolean;
}) {
  // 判断是否是最后一条消息且正在加载
  const isLastMessage = message.id === messages[messages.length - 1]?.id;
  const isGenerating = isLoading && isLastMessage && message.role === "assistant";

  // 本轮 Present 声明的交付物：卡片与正文 inline-code 点击共用同一份解析结果
  const presentedFiles = useMemo(() => extractPresentedFiles(message.events), [message.events]);
  const presentedContext = useMemo(
    () => (presentedFiles.length > 0 ? { files: presentedFiles, open: onOpenFile } : null),
    [presentedFiles, onOpenFile]
  );

  // 用户消息
  if (message.role === "user") {
    return (
      <div
        key={message.id}
        className={cn(
          "flex flex-col gap-1 my-1 items-end py-2",
          isSkipped && "opacity-60"
        )}
      >
        <div className="max-w-[85%] rounded-2xl bg-[rgb(var(--bubble))] px-3.5 py-2">
          <div className="whitespace-pre-wrap break-words text-sm text-text-primary">
            {message.content}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-1 font-mono text-2xs text-text-tertiary">
          <span>{message.timestamp.toLocaleTimeString()}</span>
        </div>
      </div>
    );
  }
  
  // AI 消息正常渲染
  return (
    <div
      key={message.id}
      className={cn(
        "flex flex-col gap-1 my-1",
        "items-start",
        isSkipped && "opacity-60"
      )}
    >
      {/* AI 标识 - 气泡上方 */}
      <div className="mb-1 flex items-center gap-1.5 px-0.5 text-2xs text-text-tertiary">
        <Bot className="size-3" />
        <span>AI Agent</span>
      </div>
          
      {/* 交付物上下文：正文 inline-code 命中已交付文件时渲染成可点开的入口 */}
      <PresentedFileContext.Provider value={presentedContext}>
      <div className={cn("w-full max-w-[92%] py-0.5", message.error && "text-danger-fg")}>
        {/* AI 消息 */}
        {(() => {
              const { actions, cleanContent } = parseNextStepActions(message.content);
              
              return (
                <div className="space-y-3">

                  {/* 按顺序渲染所有事件（包括 thinking） */}
                  {message.events && message.events.length > 0 ? (
                    <div className="space-y-2">
                      {(() => {
                        const elements: React.JSX.Element[] = [];
                        let textBuffer = "";
                        const shownToolInfos = new Set<string>();
                        // 已经并进折叠组的工具事件下标 —— 循环走到它们时直接跳过。
                        // （forEach 没法 break/continue 到指定位置，只能靠这个集合）
                        const consumedToolIdx = new Set<number>();

                        /**
                         * 收集从 startIdx 开始的一串连续工具事件。
                         *
                         * 实时流是 tool_start（+紧跟的 tool_info），历史是 tool_info ——
                         * 两种都要收，否则刷新页面折叠就失效了。
                         * 中间夹着的 tool_params 不算断（前端拿它派生文件树）。
                         * 遇到 text / thinking / log 才算这一串结束。
                         */
                        // 元工具：只做内部声明（「我干完了」），不是用户关心的动作。
                        // 它们在**日志**里保留，但不占聊天区的工具轨道 —— 否则每轮
                        // 末尾都挂一个 AttemptCompletion，用户会问「这是什么、为什么每次都有」。
                        const META_TOOLS = new Set(["AttemptCompletion"]);

                        const collectToolRun = (startIdx: number) => {
                          const evs = message.events || [];
                          const run: Array<{ idx: number; item: ToolItem }> = [];
                          // 已经收进本次 run 的 tool_params / tool_result，避免重复归并
                          const usedIdx = new Set<number>();

                          /** 往后找属于同一个工具的 params / result（遇到下一个 tool_start 就停） */
                          /**
                           * 取这个工具后面的 params / result。
                           *
                           * ⚠️ 兼容层每个工具发 3 个事件，顺序是：
                           *     tool_start{tool} → tool_info{info} → tool_params{params} → tool_result{result}
                           *   而这里是从 tool_start 的**下一格**开始找 —— 那格正是 tool_info。
                           *   原来对 tool_info 是 break，于是**第一次迭代就退出**，
                           *   params 和 result 永远是空的 → 展开工具只看得到「没有可用详情」。
                           *   实测踩过。
                           */
                          const pickFollow = (from: number) => {
                            let params: string | undefined;
                            let result: string | undefined;
                            let ok: boolean | undefined;
                            for (let k = from; k < evs.length; k++) {
                              const nx = evs[k];
                              if (!nx) break;
                              if (nx.type === "tool_start") break;   // 下一个工具了
                              // tool_info 是**本工具**的说明行（紧跟在 tool_start 后），跳过而不是断
                              if (nx.type === "tool_info") continue;
                              if (nx.type === "tool_params" && !usedIdx.has(k)) {
                                usedIdx.add(k);
                                try { params = JSON.stringify(nx.params ?? {}); } catch { /* ignore */ }
                                continue;
                              }
                              if (nx.type === "tool_result" && !usedIdx.has(k)) {
                                usedIdx.add(k);
                                result = String(nx.result ?? "").slice(0, 4000);
                                ok = true;
                                continue;
                              }
                              // 别的类型（text/thinking/log）→ 这一串结束
                              if (nx.type !== "tool_params" && nx.type !== "tool_result") break;
                            }
                            return { params, result, ok };
                          };

                          for (let i = startIdx; i < evs.length; i++) {
                            const ev = evs[i];
                            const t = ev?.type;
                            if (t === "tool_start" && ev.tool) {
                              if (META_TOOLS.has(ev.tool)) { consumedToolIdx.add(i); continue; }
                              // 这一行的说明 = 紧随其后的第一个 tool_info
                              let info: string | undefined;
                              for (let k = i + 1; k < evs.length; k++) {
                                const nx = evs[k];
                                if (!nx) break;
                                if (nx.type === "tool_start") break;
                                if (nx.type === "tool_info") { if (nx.info) info = nx.info; break; }
                                if (nx.type !== "tool_params") break;
                              }
                              const follow = pickFollow(i + 1);
                              run.push({ idx: i, item: { tool: ev.tool, info, ...follow } });
                              continue;
                            }
                            if (t === "tool_info") {
                              // ⚠️ 兼容层发的 tool_info **不带 tool 字段**（它只是上一行 tool_start 的说明）：
                              //     每个工具实际发 3 个事件：tool_start{tool} → tool_info{info} → tool_params{...}
                              //     原来这里要求 ev.tool，没有就掉到 break → **每个工具后面都断一次链**
                              //     → run.length 永远是 1 → 退化成一列平铺的单行，折叠轨道从来没生效过。
                              if (!ev.tool) { consumedToolIdx.add(i); continue; }   // 属于上一个工具，并进去
                              if (consumedToolIdx.has(i)) continue;
                              if (META_TOOLS.has(ev.tool)) { consumedToolIdx.add(i); continue; }
                              const follow = pickFollow(i + 1);
                              run.push({ idx: i, item: { tool: ev.tool, info: ev.info, ...follow } });
                              continue;
                            }
                            if (t === "tool_params") continue;
                            break;
                          }
                          return run;
                        };
                        
                        message.events.forEach((event, idx) => {
                          if (event.type === "text" && event.content) {
                            textBuffer += event.content;
                          } else if (event.type === "log") {
                            if (!showLogs) {
                              return;
                            }
                            if (textBuffer) {
                              const cleanText = textBuffer.replace(/<next-step-action>.*?<\/next-step-action>/g, '').trim();
                              if (cleanText) {
                                elements.push(
                                  <div key={`text-before-log-${idx}`}>
                                    <MarkdownContent content={cleanText} />
                                  </div>
                                );
                              }
                              textBuffer = "";
                            }

                            const isLastMessage = message.id === messages[messages.length - 1]?.id;
                            const isLastEvent = idx === (message.events?.length || 0) - 1;
                            const isLive = !!(isLoading && isLastMessage && isLastEvent);

                            elements.push(
                              <LogEventDisplay
                                key={`log-${idx}`}
                                content={event.content}
                                isLive={isLive}
                              />
                            );
                          } else if (event.type === "thinking") {
                            // 先输出之前累积的文本
                            if (textBuffer) {
                              const cleanText = textBuffer.replace(/<next-step-action>.*?<\/next-step-action>/g, '').trim();
                              if (cleanText) {
                                elements.push(
                                  <div key={`text-before-thinking-${idx}`}>
                                    <MarkdownContent content={cleanText} />
                                  </div>
                                );
                              }
                              textBuffer = "";
                            }
                            
                            // 判断这个 thinking 是否是"正在进行中"
                            // 条件：正在加载 + 是最后一条消息 + 后面没有其他事件了
                            const isLastMessage = message.id === messages[messages.length - 1]?.id;
                            const isLastEvent = idx === (message.events?.length || 0) - 1;
                            const isThinkingInProgress = isLoading && isLastMessage && isLastEvent;
                            
                            // 渲染 thinking
                            elements.push(
                              <ThinkingDisplay
                                key={`thinking-${idx}`}
                                content={event.content}
                                isGenerating={isThinkingInProgress ?? false}
                              />
                            );
                          } else if (event.type === "tool_start" && event.tool) {
                            if (consumedToolIdx.has(idx)) return;   // 已经并进前面的折叠组了

                            // 先输出之前累积的文本
                            if (textBuffer) {
                              const cleanText = textBuffer.replace(/<next-step-action>.*?<\/next-step-action>/g, '').trim();
                              if (cleanText) {
                                elements.push(
                                  <div key={`text-${idx}`}>
                                    <MarkdownContent content={cleanText} />
                                  </div>
                                );
                              }
                              textBuffer = "";
                            }

                            // ── 连续工具 → 折叠组 ──────────────────
                            // 用户要的是「默认收起成一行，点开能看到每个工具在跑什么」。
                            // 单个工具不折叠（本来就是一行，折了反而多点一次）。
                            const run = collectToolRun(idx);
                            // 全被过滤掉（比如只有 AttemptCompletion 这种元工具）
                            // → **连回退的单行渲染也不能走**，否则它还是会出现
                            if (run.length === 0) return;
                            if (run.length > 1) {
                              for (const g of run) consumedToolIdx.add(g.idx);
                              const isLastMessage = message.id === messages[messages.length - 1]?.id;
                              const lastIdx = run[run.length - 1]!.idx;
                              const stillRunning = isLoading && isLastMessage
                                && !(message.events || []).slice(lastIdx + 1).some((e) => e.type === "tool_start");
                              elements.push(
                                <ToolActivityTrack
                                  key={`toolgroup-${idx}`}
                                    persistKey={`${message.id}:g${idx}`}
                                  items={run.map((g) => g.item)}
                                  running={!!stillRunning}
                                />
                              );
                              return;
                            }
                            
                            // 如果是 todo_write 且后续有 merge=true 的 todo_update，跳过显示工具名称
                            if (event.tool === "todo_write") {
                              let hasTodoUpdateMerge = false;
                              for (let i = idx + 1; i < (message.events?.length || 0); i++) {
                                const nextEvt = message.events?.[i];
                                if (nextEvt?.type === "tool_start") {
                                  break;
                                }
                                if (nextEvt?.type === "todo_update" && nextEvt.merge === true) {
                                  hasTodoUpdateMerge = true;
                                  break;
                                }
                              }
                              if (hasTodoUpdateMerge) {
                                return;
                              }
                            }
                            
                            // 显示工具开始 - 收集后续的 tool_info
                            shownToolInfos.clear();
                            // 找到紧跟着当前工具的 tool_info（在下一个 tool_start 之前）
                            let toolInfo: string | undefined;
                            for (let i = idx + 1; i < (message.events?.length || 0); i++) {
                              const nextEvent = message.events?.[i];
                              if (nextEvent?.type === "tool_start") {
                                // 遇到下一个工具，停止查找
                                break;
                              }
                              if (nextEvent?.type === "tool_info" && nextEvent.info) {
                                toolInfo = nextEvent.info;
                                shownToolInfos.add(toolInfo);
                                break;
                              }
                            }
                            const ToolIcon = getToolIcon(event.tool);
                            
                            // 判断是否是最后一个工具且正在加载中
                            const isLastMessage = message.id === messages[messages.length - 1]?.id;
                            const isLastTool = !message.events?.slice(idx + 1).some(e => e.type === "tool_start");
                            const isToolRunning = isLoading && isLastMessage && isLastTool;
                            
                            elements.push(
                              <div key={`tool-${idx}`} className="flex items-center gap-2 text-xs font-mono">
                                <ToolIcon className={cn(
                                  "w-3 h-3 flex-shrink-0",
                                  isToolRunning ? "text-muted-foreground animate-pulse" : "text-muted-foreground/70"
                                )} />
                                {isToolRunning ? (
                                  <TextShimmer>
                                    <span>{displayName(event.tool)}</span>
                                    {toolInfo && <span className="ml-4">{toolInfo}</span>}
                                  </TextShimmer>
                                ) : (
                                  <>
                                    <span className="text-muted-foreground/70">{displayName(event.tool)}</span>
                                    {toolInfo && <span className="ml-4 truncate text-muted-foreground/70">{toolInfo}</span>}
                                  </>
                                )}
                              </div>
                            );
                          } else if (event.type === "tool_info" && event.tool) {
                            if (consumedToolIdx.has(idx)) return;   // 已并进折叠组

                            // ── 连续工具 → 折叠组（历史走这条分支，别只改 tool_start 那边）──
                            // 实测踩过：只在 tool_start 分支加折叠，实时流生效了，
                            // **但刷新页面/切任务时历史走的是 tool_info，又变回一屏工具行**。
                            const histRun = collectToolRun(idx);
                            if (histRun.length === 0) return;
                            if (histRun.length > 1) {
                              for (const g of histRun) consumedToolIdx.add(g.idx);
                              elements.push(
                                <ToolActivityTrack
                                  key={`toolgroup-h-${idx}`}
                                    persistKey={`${message.id}:gh${idx}`}
                                  items={histRun.map((g) => g.item)}
                                  running={false}
                                />
                              );
                              return;
                            }

                            // 单个 tool_info：显示为完整的工具行（icon + 工具名 + 参数）
                            // 跳过已显示的（避免重复）
                            const infoKey = `${event.tool}-${event.info || ''}`;
                            if (shownToolInfos.has(infoKey)) {
                              return;
                            }
                            shownToolInfos.add(infoKey);
                            
                            // 先输出之前累积的文本
                            if (textBuffer) {
                              const cleanText = textBuffer.replace(/<next-step-action>.*?<\/next-step-action>/g, '').trim();
                              if (cleanText) {
                                elements.push(
                                  <div key={`text-before-tool-info-${idx}`}>
                                    <MarkdownContent content={cleanText} />
                                  </div>
                                );
                              }
                              textBuffer = "";
                            }
                            
                            const ToolIcon = getToolIcon(event.tool);
                            // 从 info 中提取简洁的参数显示
                            const displayInfo = formatToolInfo(event.tool, event.info);
                            
                            elements.push(
                              <div key={`tool-info-${idx}`} className="flex items-center gap-2 text-xs font-mono">
                                <ToolIcon className="w-3 h-3 flex-shrink-0 text-muted-foreground/70" />
                                <span className="text-muted-foreground/70">{displayName(event.tool)}</span>
                                {displayInfo && <span className="ml-2 truncate text-muted-foreground/50">{displayInfo}</span>}
                              </div>
                            );
                          } else if (event.type === "ask_user" && event.question) {
                            // 先输出之前累积的文本
                            if (textBuffer) {
                              const cleanText = textBuffer.replace(/<next-step-action>.*?<\/next-step-action>/g, '').trim();
                              if (cleanText) {
                                elements.push(
                                  <div key={`text-before-ask-${idx}`}>
                                    <MarkdownContent content={cleanText} />
                                  </div>
                                );
                              }
                              textBuffer = "";
                            }
                            // 在正确的位置渲染 ask_user
                            // 使用 event 自己的 userAnswer（从历史加载的）或 message.askUser（实时交互的）
                            const isAnswered = !!event.userAnswer || (message.askUser?.question === event.question && message.askUser?.answered);
                            const answerText = event.userAnswer || (message.askUser?.question === event.question ? message.askUser?.userAnswer : undefined);
                            
                            elements.push(
                              <AskUserInline
                                key={`ask-user-${idx}`}
                                question={event.question}
                                questionType={event.questionType || "single"}
                                suggestions={event.suggestions}
                                onSubmit={(answer) => onAskUserSubmit?.(message.id, answer)}
                                answered={isAnswered}
                                userAnswer={answerText}
                              />
                            );
                          } else if (event.type === "restore_confirm" && event.confirmData) {
                            // 先输出之前累积的文本
                            if (textBuffer) {
                              const cleanText = textBuffer.replace(/<next-step-action>.*?<\/next-step-action>/g, '').trim();
                              if (cleanText) {
                                elements.push(
                                  <div key={`text-before-restore-${idx}`}>
                                    <MarkdownContent content={cleanText} />
                                  </div>
                                );
                              }
                              textBuffer = "";
                            }
                            // 渲染 restore_confirm 内联组件
                            elements.push(
                              <RestoreConfirmInline
                                key={`restore-confirm-${idx}`}
                                confirmData={event.confirmData}
                                onConfirm={() => onRestoreConfirm?.(message.id)}
                                onCancel={() => onRestoreCancel?.(message.id)}
                                confirmed={event.confirmed}
                                userChoice={event.userChoice}
                              />
                            );
                          } else if (event.type === "screenshot_request" && event.instruction) {
                            // 先输出之前累积的文本
                            if (textBuffer) {
                              const cleanText = textBuffer.replace(/<next-step-action>.*?<\/next-step-action>/g, '').trim();
                              if (cleanText) {
                                elements.push(
                                  <div key={`text-before-screenshot-${idx}`}>
                                    <MarkdownContent content={cleanText} />
                                  </div>
                                );
                              }
                              textBuffer = "";
                            }
                            // 渲染 screenshot_request 内联组件
                            elements.push(
                              <ScreenshotRequestInline
                                key={`screenshot-request-${idx}`}
                                instruction={event.instruction}
                                onSubmit={(screenshot) => {
                                  if (onScreenshotSubmit) {
                                    onScreenshotSubmit(message.id, event.sessionId || "", screenshot);
                                  } else {
                                    console.error("onScreenshotSubmit is not defined");
                                  }
                                }}
                                onCancel={() => {
                                  if (onScreenshotCancel) {
                                    onScreenshotCancel(event.sessionId || "");
                                  } else {
                                    console.error("onScreenshotCancel is not defined");
                                  }
                                }}
                                submitted={event.submitted}
                                cancelled={event.cancelled}
                                screenshotPreview={event.screenshot}
                              />
                            );
                          } else if (event.type === "todo_update" && event.todos) {
                            // 先输出之前累积的文本
                            if (textBuffer) {
                              const cleanText = textBuffer.replace(/<next-step-action>.*?<\/next-step-action>/g, '').trim();
                              if (cleanText) {
                                elements.push(
                                  <div key={`text-before-todo-${idx}`}>
                                    <MarkdownContent content={cleanText} />
                                  </div>
                                );
                              }
                              textBuffer = "";
                            }
                            
                            if (event.isFirstTodo) {
                              // 新建时（merge=false）：显示完整的 TodoPanel
                              elements.push(
                                <div key={`todo-panel-${idx}`} className="my-2">
                                  <TodoPanel todos={message.todos || event.todos} />
                                </div>
                              );
                            } else {
                              // 更新时（merge=true）：使用可折叠的 TodoUpdateDisplay 组件
                              if (event.todos.length > 0) {
                                elements.push(
                                  <TodoUpdateDisplay
                                    key={`todo-update-${idx}`}
                                    todos={event.todos}
                                  />
                                );
                              }
                            }
                          }
                        });
                        
                        // 输出最后累积的文本
                        if (textBuffer) {
                          const cleanText = textBuffer.replace(/<next-step-action>.*?<\/next-step-action>/g, '').trim();
                          if (cleanText) {
                            elements.push(
                              <div key="text-final">
                                <MarkdownContent content={cleanText} />
                              </div>
                            );
                          }
                        }
                        
                        return elements;
                      })()}
                    </div>
                  ) : (
                    cleanContent && (
                      <MarkdownContent content={cleanContent} />
                    )
                  )}

                  {/* 交付物卡片：本轮 Present 声明过的文件（点一下 → 右侧预览面板）。
                      放在工具活动块之后、正文之后 —— 解析不到文件时组件自己返回 null。 */}
                  <PresentedFiles events={message.events} onOpenFile={onOpenFile} />

                  {/* 计划卡片：本轮 ExitPlanMode 提交的计划（计划模式下模型只能交计划，
                      批准后内核才开始动手）。和交付物卡片同一个位置、同一套样式。 */}
                  <PlanCard events={message.events} />

                  {/* Ask User 内联交互 - 如果没有 events 但有 askUser，单独渲染 */}
                  {message.askUser && (!message.events || message.events.length === 0) && (
                    <AskUserInline
                      question={message.askUser.question}
                      questionType={message.askUser.questionType || "single"}
                      suggestions={message.askUser.suggestions}
                      onSubmit={(answer) => onAskUserSubmit?.(message.id, answer)}
                      answered={message.askUser.answered}
                      userAnswer={message.askUser.userAnswer}
                    />
                  )}

                  {/*
                    版本条已删除 —— 它的编号是**错的**。

                    原来「版本 N」= 前端数的「第 N 个改过文件的对话回合」，
                    再拿这个序号去查 git commit —— 两份独立数据靠序号对齐。
                    只要回滚一次就错位（回滚也会产生 commit），而且越拉越大：
                      聊天显示「版本 2」→ git 的 version 2 → 实际是「恢复到版本 1」那个提交
                    → 点它会切到回滚的内容，不是那次对话的改动。

                    回滚入口保留在右侧面板的「版本历史」—— 它直接读 git 列表
                    （version_number = list.length - i），不会错位。
                  */}
                  {false && message.version_number && (
                    <button
                      onClick={() => message.commit_hash && !isLoading && !isSwitchingVersion && onVersionClick?.(message.commit_hash, message.version_number!)}
                      disabled={!message.commit_hash || isLoading || isSwitchingVersion}
                      className={`mt-3 w-full flex items-center justify-center py-1.5 px-3 rounded-md bg-muted/50 border border-border/50 transition-colors ${
                        message.commit_hash && !isLoading && !isSwitchingVersion
                          ? 'hover:bg-muted hover:border-primary/30 cursor-pointer group' 
                          : 'opacity-50 cursor-not-allowed'
                      }`}
                    >
                      {isSwitchingVersion ? (
                        <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                      ) : (
                      <span className={`text-xs font-medium text-muted-foreground ${message.commit_hash && !isLoading ? 'group-hover:text-primary' : ''} transition-colors`}>
                        版本 {message.version_number}
                      </span>
                      )}
                    </button>
                  )}

                  {/* 下一步操作按钮 */}
                  {actions.length > 0 && onActionClick && (
                    <div className="pt-3 border-t">
                      <div className="flex flex-wrap gap-2">
                        {actions.map((action, idx) => (
                          <Button
                            key={idx}
                            onClick={() => onActionClick(action)}
                            variant="secondary"
                            size="sm"
                            className="text-xs"
                          >
                            {action}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 加载中指示器
                      ⚠️ 三个条件缺一不可（实测各踩过一次）：
                      · isLoading   —— 不看它的话，**历史里未完成的消息**会永远转
                                       （重启后 interrupted 状态就丢了，只剩空消息）
                      · interrupted —— 点暂停时消息既没内容也没 error，只设了
                                       interrupted:true，不排它就永远转
                      · content/error —— 有内容或明确报错就不该再转 */}
                  {isLoading && !message.content && !message.error && !message.interrupted && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                      <span className="text-xs">AI 正在思考...</span>
                    </div>
                  )}

                  {/* 中断提示：让用户明确知道是「停了」而不是「卡住了」 */}
                  {message.interrupted && !message.content && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
                      <span>已暂停</span>
                    </div>
                  )}

                  {/* 错误/中断消息的重试按钮 */}
                  {(message.error || message.interrupted) && isLastMessage && !isLoading && (
                    <div className={`flex items-center gap-2 pt-3 border-t ${message.error ? 'border-destructive/20' : 'border-warning/20'}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => onRetry?.()}
                      >
                        重试
                      </Button>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
      </PresentedFileContext.Provider>

      {/* 时间戳和费用 - 气泡外部，生成中不显示 */}
      {!(isGenerating) && (
        <div className="text-[10px] text-muted-foreground/60 px-1 flex items-center gap-2 justify-start">
          <span>{message.timestamp.toLocaleTimeString()}</span>
            </div>
          )}
      </div>
  );
}
