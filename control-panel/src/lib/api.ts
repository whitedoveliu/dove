/**
 * API 客户端 - 与后端 FastAPI 服务通信
 * 支持 Server-Sent Events (SSE) 流式响应
 */

// 动态获取 API 地址，支持局域网访问
const getApiBaseUrl = () => {
  if (typeof window !== "undefined") {
    // 浏览器环境：使用当前访问的主机名
    return `http://${window.location.hostname}:8008`;
  }
  return "http://localhost:8008";
};

const API_BASE_URL = typeof window !== "undefined" 
  ? `http://${window.location.hostname}:8008` 
  : "http://localhost:8008";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  toolCalls?: {
    tool: string;
    info: string;
  }[];
  thinking?: string;  // 实时流式输出的 thinking 内容
  error?: boolean;
  interrupted?: boolean;  // 用户终止生成
  // 新增：按顺序记录所有事件
  events?: Array<{
    type: "text" | "log" | "tool_start" | "tool_info" | "tool_params" | "tool_result" | "ask_user" | "restore_confirm" | "thinking" | "todo_update" | "screenshot_request" | "subagent";
    /** subagent 事件专用 */
    action?: "start" | "text" | "reasoning" | "tool" | "done" | "injected";
    subagentId?: string;
    content?: string;
    tool?: string;
    info?: string;
    params?: Record<string, unknown>;  // 完整的工具参数
    result?: string;  // 工具执行结果
    question?: string;
    questionType?: "single" | "multiple";  // 问题类型：单选或多选
    suggestions?: string[];
    userAnswer?: string | string[];  // ask_user 的用户回答（单选为字符串，多选为数组）
    // restore_confirm 相关
    confirmData?: {
      target_version: number;
      target_timestamp: string;
      target_message: string;
      current_version: number;
    };
    confirmed?: boolean;  // 是否已确认
    userChoice?: "confirm" | "cancel";  // 用户的选择
    // todo_update 相关
    todos?: TodoItem[];
    merge?: boolean;
    isFirstTodo?: boolean;  // 是否是第一次创建 todo（显示完整面板）
    // screenshot_request 相关
    instruction?: string;  // 截图指示
    sessionId?: string;  // 会话 ID
    fullPage?: boolean;  // 是否全页截图
    screenshot?: string;  // 用户提交的截图（base64）
    submitted?: boolean;  // 是否已提交
    cancelled?: boolean;  // 是否已取消
  }>;
  // ask_user 相关
  askUser?: {
    question: string;
    questionType?: "single" | "multiple";  // 问题类型
    suggestions?: string[];
    answered?: boolean;
    userAnswer?: string | string[];  // 单选为字符串，多选为数组
  };
  // 费用统计（按模型分别统计）
  usage?: {
    model: string;  // 模型 id；多模型混用为 "mixed"
    models?: string[];  // 本次实际用到的模型 id
    model_escalated?: boolean;  // 是否升级过模型
    pricing_found?: boolean;  // 是否所有模型都有收录价格
    total_cost: number;
    // 按真实模型计费的明细（新）
    breakdown?: Array<{
      model: string;
      raw_model?: string;
      display: string;
      provider?: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost: number;
      pricing_found?: boolean;
    }>;
    sonnet: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost: number;
    };
    opus: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost: number;
    };
  };
  // 版本号（只有修改了代码才有）
  version_number?: number;
  // Git commit hash（用于切换版本）
  commit_hash?: string;
  // 是否被恢复操作跳过（用于折叠显示）
  skipped_by_restore?: boolean;
  // Todo 列表（嵌入消息气泡中显示）
  todos?: TodoItem[];
}

// Todo 项目类型
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

// 提示词替换规则
export interface PromptReplacement {
  id: string;
  original: string;
  replacement: string;
  enabled: boolean;
}

export interface ChatRequest {
  message: string;
  route?: string;
  selector?: string;
  if_history?: boolean;
  if_memory?: boolean;
  if_thinking?: boolean;
  if_new_project?: boolean;
  model?: string;
  project_id?: string;  // 项目ID（端口号）
  continuous_chat?: boolean;  // 连续对话模式
  prompt_replacements?: PromptReplacement[];  // 提示词替换规则
  if_hot_reload?: boolean;  // 热更新开关
  if_recommend_files?: boolean;  // 推荐文件开关（仅普通模式生效）
  attachments?: Array<{  // 附件列表（只传文件信息，不传内容）
    file_id: string;
    filename: string;
    mime_type: string;
    size: number;
  }>;
  // AI 风格配置
  ai_style_x?: number;  // 主动性 (0-100)，0=被动，100=主动
  ai_style_y?: number;  // 专业性 (0-100)，0=轻松，100=专业
}

export interface SSEEvent {
  type: string;
  content?: string;
  tool?: string;
  info?: string;
  message?: string;
  round?: number;
  rounds?: number;
  log?: string;
  // ask_user 相关字段
  question?: string;
  question_type?: "single" | "multiple";  // 问题类型
  suggestions?: string[];
  session_id?: string;
  // browser_action 相关字段
  action?: string;
  search?: string;
  // stats 相关字段
  is_modified?: boolean;
  model_escalated?: boolean;  // 是否升级过模型
  usage?: {
    model: string;
    models?: string[];
    pricing_found?: boolean;
    total_cost: number;
    breakdown?: Array<{
      model: string;
      display: string;
      provider?: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost: number;
      pricing_found?: boolean;
    }>;
    sonnet: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost: number;
    };
    opus: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost: number;
    };
  };
  // commit 相关字段
  commit_hash?: string;
  // restore_confirm 相关字段
  version?: number;
  confirm_data?: {
    target_version: number;
    target_timestamp: string;
    target_message: string;
    current_version: number;
    warning: string;
  };
  // build_error 相关字段
  error?: string;
  // tool_params/tool_result 相关字段（用于继续生成）
  params?: Record<string, unknown>;
  result?: string;
  // model_upgrade 相关字段
  from_model?: string;
  to_model?: string;
  reason?: string;
  // todo_update 相关字段
  todos?: TodoItem[];
  merge?: boolean;
}

/**
 * 发送聊天消息并处理 SSE 流式响应
 */
export async function sendChatMessage(
  request: ChatRequest,
  onEvent: (event: SSEEvent) => void
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader) {
    throw new Error("Response body is null");
  }

  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // 将新数据添加到缓冲区
      buffer += decoder.decode(value, { stream: true });

      // 处理缓冲区中的所有完整事件
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留最后一个不完整的行

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);

          if (data.trim()) {
            try {
              const event: SSEEvent = JSON.parse(data);
              
              // 添加时间戳，证明是流式接收
              const timestamp = new Date().toISOString().split('T')[1].slice(0, -1); // HH:MM:SS.mmm
              // 对于特殊事件，打印完整信息
              if (event.type === "browser_action" || event.type === "restore_confirm" || event.type === "todo_update") {
                console.log(`[${timestamp}] ${event.type}:`, event);
              } else {
                console.log(`[${timestamp}] ${event.type}:`, event.content?.substring(0, 30) || event.tool || '');
              }
              
              onEvent(event);

              // 如果收到 done 事件，停止处理
              if (event.type === "done") {
                return;
              }
            } catch (e) {
              console.error("Failed to parse SSE event:", data, e);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 健康检查
 */
export async function checkHealth(): Promise<{ status: string; message: string }> {
  const response = await fetch(`${API_BASE_URL}/api/health`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 获取项目信息
 */
export async function getProjectInfo(projectId: string): Promise<{
  file_count: number;
  current_version: number;
  react_app_path: string;
  project_id: string;
}> {
  const response = await fetch(`${API_BASE_URL}/api/project-info?project_id=${projectId}`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 重置项目
 */
export async function resetProject(projectId: string): Promise<{
  success: boolean;
  message: string;
  project_path: string;
}> {
  const response = await fetch(`${API_BASE_URL}/api/reset-project`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

// ==================== 多项目管理 API ====================

export interface Project {
  port: string;
  name: string;
  display_name?: string;  // 小模型总结的项目名（可能为空）
  /** 任务名（目录名，来自 .dove.json） */
  name_text?: string;
  /** 所属项目（可空） */
  project?: string | null;
  /** 目录名 */
  dir_name?: string;
  /**
   * 真实项目 id（数据库主键）。
   *
   * ⚠️ 删除等操作要用**这个**，不要用 port ——
   * 导入/接入的项目没有端口（port 是 "0"），dir_name 又只是目录名、
   * 和 id 不一定相同（实测 /tmp/noport-test 的 dir_name 是 noport-test，
   * id 却是 pmuwyou7r）。用 port 或 dir_name 定位这类项目会 404。
   */
  id?: string;
  /** 是否是外部接入的本地文件夹 */
  attached?: boolean;
  /** 任务标题（该任务第一条用户消息） */
  title?: string | null;
  /** 最近一次对话时间（毫秒时间戳） */
  updated_at?: number | null;
  /** 对话轮次 */
  messages?: number;
  /** 最近一条用户消息 */
  last_user?: string | null;
  path: string;
  exists: boolean;
  running: boolean;  // 服务器是否在运行
  actual_port?: string | null;  // 实际监听端口（可能与项目端口不同）
}

/**
 * 用小模型根据项目内容总结一个简短项目名（结果缓存在项目目录）
 */
export async function generateProjectName(
  port: string,
  force = false
): Promise<{ success: boolean; name: string; source: string }> {
  const response = await fetch(
    `${API_BASE_URL}/api/projects/${port}/name${force ? "?force=true" : ""}`,
    { method: "POST" }
  );
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 获取所有项目列表
 */
export async function getProjects(): Promise<{ projects: Project[] }> {
  const response = await fetch(`${API_BASE_URL}/api/projects`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 创建新项目
 */
export async function createProject(port: string): Promise<{
  success: boolean;
  message: string;
  project?: { port: string; path: string };
}> {
  const response = await fetch(`${API_BASE_URL}/api/projects/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 按「任务名（+ 可选项目名）」创建任务。
 * 端口由后端自动分配，目录名就是任务名；不再让用户选端口。
 */
export async function createTask(input: {
  name: string;
  project?: string;
}): Promise<{
  success: boolean;
  message: string;
  project?: { port: string; path: string; name: string; project?: string | null };
}> {
  const response = await fetch(`${getApiBaseUrl()}/api/projects/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: input.name, project: input.project || undefined }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "创建失败" }));
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/** 唤起系统原生的「选择文件夹」对话框 */
export async function chooseFolder(): Promise<{ success: boolean; path?: string; cancelled?: boolean; message?: string }> {
  // 桌面端优先用 Tauri 的原生对话框（弹在应用窗口上、无需额外权限）
  const tauri = (window as unknown as { __TAURI__?: { dialog?: { open?: (o: unknown) => Promise<string | string[] | null> } } }).__TAURI__;
  if (tauri?.dialog?.open) {
    try {
      const picked = await tauri.dialog.open({ directory: true, multiple: false, title: "选择项目文件夹" });
      if (!picked || Array.isArray(picked)) return { success: false, cancelled: true };
      return { success: true, path: picked };
    } catch {
      /* 落到后端兜底 */
    }
  }
  const response = await fetch(`${getApiBaseUrl()}/api/dialog/choose-folder`, { method: "POST" });
  return response.json().catch(() => ({ success: false, message: "打开选择框失败" }));
}

/**
 * 把一个本地已存在的文件夹接入成任务工作目录（Codex 的 open folder）。
 * 后端只登记端口 + 写 .dove.json，不复制模板、不启动服务器。
 */
export async function attachFolder(input: {
  path: string;
  name?: string;
  project?: string;
}): Promise<{
  success: boolean;
  message: string;
  project?: { port: string; path: string; name: string; project?: string | null };
}> {
  const response = await fetch(`${getApiBaseUrl()}/api/projects/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({ success: false, message: "接入失败" }));
  if (!response.ok || !data.success) {
    throw new Error(data.message || `HTTP ${response.status}`);
  }
  return data;
}

/**
 * 检查项目是否存在
 */
export async function checkProjectExists(port: string): Promise<{
  exists: boolean;
  port: string;
  running: boolean;
  actual_port?: string | null;
  requested_port_in_use?: boolean;
  requested_port_owned?: boolean;
}> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${port}/exists`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 启动项目的 Vite 开发服务器（用于最新版本热更新预览）
 */
export async function startProjectServer(port: string): Promise<{
  success: boolean;
  message: string;
  actual_port?: string | null;
  requested_port_conflict?: boolean;
}> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${port}/start`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 停止项目的 Vite 开发服务器（空闲时自动调用，节省资源）
 */
/** 子代理（A3）：存成子线程，可点进去看它的过程 */
export interface SubagentInfo {
  id: string;
  label: string;
  status: string;
  background: boolean;
  taskId: string | null;
  parentId: string;
  startedAt: number;
  finishedAt: number | null;
  parts: number;
}

/** 列出某个项目派出去的所有子代理 */
export async function listSubagents(projectKey: string): Promise<SubagentInfo[]> {
  const r = await fetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(projectKey)}/subagents`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { subagents?: SubagentInfo[] };
  return d.subagents ?? [];
}

/**
 * 拉某个线程的消息（子代理过程）。
 * 返回的 events 和主对话**同一形状** —— 所以能直接喂给 MessageList，不用另写渲染。
 */
export async function readThreadMessages(threadId: string): Promise<{
  messages: { id: string; role: string; createdAt: number; events: Record<string, unknown>[] }[];
  title: string;
  metadata: Record<string, unknown>;
}> {
  const r = await fetch(`${getApiBaseUrl()}/api/threads/${encodeURIComponent(threadId)}/messages`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  return r.json();
}

/**
 * 权限模式（对齐 Codex 的 SandboxMode 三档）。
 *
 *   full       完全访问 —— 任何操作都不审批
 *   workspace  工作区内修改 —— 默认；工作区内放行，越界才问
 *   readonly   仅可查看 —— 写类工具直接从工具表里裁掉
 */
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access" | "auto";

/** 权限预设（B4）—— 主机下发，前端只渲染 */
export interface PermissionPreset {
  value: PermissionMode;
  label: string;
  description: string;
  requiresConfirm: boolean;
  experimental: boolean;
}

export async function getPermissionPresets(): Promise<PermissionPreset[]> {
  const r = await fetch(`${getApiBaseUrl()}/api/permission-presets`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { presets?: PermissionPreset[] };
  return d.presets ?? [];
}

export async function getPermissionMode(port: string): Promise<PermissionMode> {
  const r = await fetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/permission`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { mode?: PermissionMode };
  return d.mode ?? "workspace-write";
}

export async function setPermissionMode(port: string, mode: PermissionMode): Promise<PermissionMode> {
  const r = await fetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { mode?: PermissionMode };
  return d.mode ?? mode;
}

/**
 * 彻底删除一个任务：项目目录 + 数据库记录。**不可恢复。**
 *
 * @param key 优先传项目的 **id**（Project.id）。传 port 只在有端口的项目上有效 ——
 *            导入/接入的项目 port 是 "0"，用它会 404。
 *
 * 内核侧有两道保护：路径不在工作区内时只清数据库、不碰文件；
 * 返回里的 warning 会说明这种情况，调用方应该把它显示给用户。
 */
export async function deleteProject(port: string): Promise<{
  success: boolean;
  message: string;
  port?: string;
  files_deleted?: boolean;
  threads_deleted?: number;
  warning?: string;
}> {
  const response = await fetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/delete`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

export async function stopProjectServer(port: string): Promise<{
  success: boolean;
  message: string;
  actual_port?: string | null;
}> {
  const response = await fetch(`${getApiBaseUrl()}/api/projects/${port}/stop`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 停止项目服务器（使用 sendBeacon，用于页面卸载时）
 * sendBeacon 可以确保请求在页面关闭时也能发送成功
 */
export function stopProjectServerBeacon(port: string): boolean {
  const url = `${getApiBaseUrl()}/api/projects/${port}/stop`;
  // sendBeacon 只支持 POST，且需要发送数据才能触发
  return navigator.sendBeacon(url, JSON.stringify({}));
}

/**
 * 重启项目的 Vite 开发服务器（清理缓存后重新启动）
 */
export async function restartProjectServer(port: string): Promise<{
  success: boolean;
  message: string;
  actual_port?: string | null;
}> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${port}/restart`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 获取项目的 project_plan.md 内容
 */
export async function getProjectPlan(port: string): Promise<{
  success: boolean;
  content: string | null;
  exists: boolean;
}> {
  const response = await fetch(`${getApiBaseUrl()}/api/projects/${port}/plan`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 提交用户输入的答案
 */
export async function submitUserInput(
  sessionId: string,
  answer: string
): Promise<{
  success: boolean;
  message: string;
}> {
  const response = await fetch(`${API_BASE_URL}/api/user-input`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id: sessionId,
      answer: answer,
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 终止当前请求
 */
/**
 * 停止生成。
 *
 * ⚠️ 传 projectId 就**只停这个会话**；不传则保持老行为（停掉所有会话）。
 * 支持多会话并行之后，"在 B 点停止把 A 也停了"是个真问题。
 */
export async function stopGeneration(projectId?: string | null): Promise<{
  success: boolean;
  message: string;
}> {
  const response = await fetch(`${API_BASE_URL}/api/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId ?? "" }),
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 重试：丢弃临时分支上的修改，切回主分支
 */
export async function retryGeneration(projectId: string): Promise<{
  success: boolean;
  message?: string;
  error?: string;
}> {
  const response = await fetch(`${API_BASE_URL}/api/retry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!response.ok) {
    const error = await response.json();
    return { success: false, error: error.error || `HTTP error! status: ${response.status}` };
  }
  return response.json();
}

/**
 * 后端历史记录格式
 */
export interface HistoryRecord {
  id: string;
  start_time: string;
  end_time: string;
  user: string;
  events: Array<{
    type: "text" | "log" | "tool_info" | "thinking" | "todo_update";
    content?: string;
    tool?: string;
    info?: string;
    questionType?: "single" | "multiple";  // ask_user 问题类型
    suggestions?: string[];
    userAnswer?: string | string[];  // 单选为字符串，多选为数组
    // todo_update 相关
    todos?: TodoItem[];
    merge?: boolean;
  }>;
  commit_hash?: string;
  is_modified?: boolean;  // 是否有代码变化
  skipped_by_restore?: boolean;  // 是否被恢复操作跳过
  usage?: {
    model: string;
    models?: string[];
    pricing_found?: boolean;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_cost: number;  // 美元
    sonnet?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost: number;
    };
    opus?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost: number;
    };
    breakdown?: Array<{
      model: string;
      display: string;
      provider?: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost: number;
      pricing_found?: boolean;
    }>;
  };
}

/**
 * 获取对话历史记录
 */
export async function getHistory(projectId: string): Promise<{
  history: HistoryRecord[];
}> {
  const response = await fetch(`${API_BASE_URL}/api/history?project_id=${projectId}`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 提交浏览器操作结果（console logs / network requests）
 */
export async function submitBrowserResult(
  sessionId: string,
  action: string,
  result: unknown
): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE_URL}/api/browser_result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id: sessionId,
      action,
      result,
    }),
  });
  
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 切换到指定版本
 */
export async function switchVersion(commitHash: string, projectId: string): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_BASE_URL}/api/switch-version`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      commit_hash: commitHash,
      project_id: projectId,
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 切换到最新版本
 */
export async function switchToLatest(projectId: string): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_BASE_URL}/api/switch-to-latest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      project_id: projectId,
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 版本信息
 */
export interface VersionInfo {
  version_number: number;
  commit_hash: string;
  timestamp: string;
  summary: string;
  skipped: boolean;
}

/**
 * 获取版本列表
 */
export async function getVersionList(projectId: string, limit: number = 20): Promise<{
  success: boolean;
  versions: VersionInfo[];
  total_count: number;
  current_version: number;
}> {
  const response = await fetch(`${API_BASE_URL}/api/versions?project_id=${projectId}&limit=${limit}`);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 获取项目状态（是否正在生成等）
 */
export async function getProjectStatus(projectId: string): Promise<{
  success: boolean;
  is_generating: boolean;
  project_id: string;
}> {
  const response = await fetch(`${API_BASE_URL}/api/project-status?project_id=${projectId}`);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 设置预览版本（用于切换历史版本预览）
 */
export async function setPreviewVersion(projectId: string, version: number | null): Promise<{
  success: boolean;
  message: string;
  version: number | null;
  error?: string;
}> {
  const response = await fetch(`${API_BASE_URL}/api/set-preview-version?project_id=${projectId}${version !== null ? `&version=${version}` : ''}`, {
    method: "POST",
  });
  
  if (!response.ok) {
    const errorData = await response.json();
    // 返回带有详细错误信息的对象，而不是抛出异常
    return {
      success: false,
      message: errorData.error || `HTTP error! status: ${response.status}`,
      version: null,
      error: errorData.error,
    };
  }
  return response.json();
}

// ==================== 文件上传 ====================
export interface UploadedFile {
  id: string;           // 唯一标识
  name: string;         // 文件名
  size: number;         // 文件大小（字节）
  type: string;         // MIME 类型
  uploadedAt: Date;     // 上传时间
}

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * 上传文件到服务器（临时存储）
 */
export async function uploadFile(file: File, projectId: string): Promise<UploadedFile> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`文件大小超过限制（最大 20MB），当前文件 ${(file.size / 1024 / 1024).toFixed(2)}MB`);
  }
  
  const formData = new FormData();
  formData.append("file", file);
  formData.append("project_id", projectId);
  
  const response = await fetch(`${getApiBaseUrl()}/api/upload-file`, {
    method: "POST",
    body: formData,
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `上传失败: ${response.status}`);
  }
  
  const result = await response.json();
  return {
    id: result.file_id,
    name: result.filename,
    size: result.size,
    type: result.mime_type,
    uploadedAt: new Date(),
  };
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 导入远程项目版本
 * 从远程服务器下载 zip 并解压到项目目录
 */
export async function importProject(projectId: string, versionId: string): Promise<{
  success: boolean;
  message: string;
  project_path?: string;
  version_id?: string;
}> {
  const response = await fetch(`${getApiBaseUrl()}/api/import-project`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project_id: projectId, version_id: versionId }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * Clear all Dove Cloud data (tables and Edge Functions)
 * WARNING: This is a destructive operation!
 */
export async function clearDoveCloud(): Promise<{
  success: boolean;
  message: string;
  tables_deleted?: string[];
  tables_failed?: string[];
  functions_deleted?: string[];
  functions_failed?: string[];
}> {
  const response = await fetch(`${getApiBaseUrl()}/api/clear-dove-cloud`, {
    method: "POST",
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/* ======================= 项目目录树（左侧目录面板） ======================= */

export interface ProjectFileEntry {
  name: string;
  /** 相对项目根目录的 POSIX 风格路径 */
  path: string;
  type: "dir" | "file";
  /** 仅目录：是否还有可见子项 */
  has_children?: boolean;
  /** 仅文件 */
  size?: number;
  modified?: number;
  language?: string | null;
}

/**
 * 列出项目内某个目录的直接子项（懒加载，逐层展开）
 */
export async function getProjectFiles(
  port: string,
  path: string = ""
): Promise<{ success: boolean; port: string; path: string; entries: ProjectFileEntry[] }> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const response = await fetch(`${getApiBaseUrl()}/api/projects/${port}/files${query}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "读取目录失败" }));
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 读取项目内单个文件内容（用于目录树的文件预览）
 */
export async function readProjectFile(
  port: string,
  path: string
): Promise<{
  success: boolean;
  path: string;
  name: string;
  size: number;
  language?: string | null;
  content: string;
}> {
  const response = await fetch(
    `${getApiBaseUrl()}/api/projects/${port}/file?path=${encodeURIComponent(path)}`
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "读取文件失败" }));
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/** 人类可读的文件体积 */
export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/* ========================= 会话日志（执行轨迹） ========================= */

export interface SessionSummary {
  id: string;
  file: string;
  size: number;
  modified: number;
  turns: number;
  last_type?: string;
  last_ts?: string;
  last_run?: string;
}

/** 一条会话日志记录（NDJSON 的一行） */
export interface SessionLogRecord {
  v: number;
  seq: number;
  ts: string;
  session: string;
  run: string;
  project: string;
  turn: number;
  step: number;
  type: string;
  data?: Record<string, unknown>;
}

export interface SessionLogPage {
  success: boolean;
  port: string;
  session: string | null;
  path?: string;
  records: SessionLogRecord[];
  offset: number;
  eof: boolean;
  size: number;
}

/** 列出项目的会话日志（时间倒序） */
export async function getSessions(
  port: string,
  limit = 50
): Promise<{
  success: boolean;
  dir: string;
  today: string;
  latest: string;
  active_sessions: string[];
  sessions: SessionSummary[];
}> {
  const response = await fetch(`${getApiBaseUrl()}/api/projects/${port}/sessions?limit=${limit}`);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

/** 按字节偏移增量读取会话日志（断线续传用） */
export async function readSessionLog(
  port: string,
  session: string,
  offset = 0,
  limit = 500
): Promise<SessionLogPage> {
  const query = new URLSearchParams({ session, offset: String(offset), limit: String(limit) });
  const response = await fetch(`${getApiBaseUrl()}/api/projects/${port}/session-log?${query}`);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

/** 会话日志的实时推送地址（SSE：先补历史再持续 tail） */
export function sessionLogStreamUrl(port: string, session = "", offset = 0): string {
  const query = new URLSearchParams({ offset: String(offset) });
  if (session) query.set("session", session);
  return `${getApiBaseUrl()}/api/projects/${port}/session-log/stream?${query}`;
}


