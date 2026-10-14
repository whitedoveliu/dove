/**
 * API 客户端 - 与后端 FastAPI 服务通信
 * 支持 Server-Sent Events (SSE) 流式响应
 */

// 动态获取 API 地址，支持局域网访问
export const getApiBaseUrl = () => {
  if (typeof window !== "undefined") {
    // 浏览器环境：使用当前访问的主机名
    return `http://${window.location.hostname}:8008`;
  }
  return "http://localhost:8008";
};

/**
 * 面板**自己所在的 origin**（面板由内核托管时，就是内核的 8790）。
 *
 * 两种 origin 别混（混过就是 401 / 读不到响应体）：
 *   · `getApiBaseUrl()` = 兼容层 8008 —— 跨源，靠 CORS 头 + `X-Dove-Token` 头；
 *   · 本函数 = 面板同源 —— 只有它才能：① 让 HTML 里的**相对子资源**解析得回来；
 *     ② 同源 `fetch` 读得到响应体（下载）；③ 免令牌的 `/api/preview/*`。
 * dev 形态（vite 3006）下面板不由内核托管，与内核不同源 —— 那几条同源路由用不了（见 README 的开发步骤）。
 */
export const getPanelOrigin = () => {
  if (typeof window !== "undefined") return window.location.origin;
  return "http://127.0.0.1:8790";
};

const API_BASE_URL = typeof window !== "undefined" 
  ? `http://${window.location.hostname}:8008` 
  : "http://localhost:8008";

/* ==================== 本地令牌（8008 的准入证）==================== */

/**
 * 兼容层（8008）除 /api/health 外都要求令牌 —— 为什么、威胁是什么，见
 * `harness/packages/server/src/local-token.ts` 的顶部注释。
 *
 * 面板只能问**内核自己**要（GET /api/local-token）：面板就是内核托管的，同源；
 * 别的网页拿不到那条响应（内核只对同源与白名单里的面板源回 CORS 头，见 panel-origin.ts）。
 *
 * 取令牌**只做一次**：拿到或失败都记住，失败后不再自动重试 ——
 * 重试由用户点提示条上的「重试」触发（retryLocalToken），免得失败时变成打点式的死循环。
 */
const TOKEN_PATHS = typeof window === "undefined"
  ? ["http://127.0.0.1:8790/api/local-token"]
  : [
      // ① 同源：产品形态（面板由内核托管在 8790）
      `${window.location.origin}/api/local-token`,
      // ② 开发形态（vite 3006）：面板不是内核托管的，但 vite 自己把这条路径代理到内核
      //    （control-panel/vite.config.ts 的 server.proxy）—— 对浏览器仍然是**同源**请求，
      //    不经过 CORS，所以内核的白名单里**没有** 3006（那是项目 dev server 的区间）。
      //    ③ 兜底：静态服务直接按主机名 + 内核默认端口找它；这条要跨源，只有白名单里的源能过
      //    （harness/packages/server/src/panel-origin.ts）。
      `http://${window.location.hostname}:8790/api/local-token`,
    ];

export type LocalTokenState = "pending" | "ready" | "missing";

let localTokenState: LocalTokenState = "pending";
let localTokenPromise: Promise<string> | null = null;
/** ensureLocalToken() 落地后缓存下来的令牌本体（同步取用，见 getLocalTokenCached） */
let cachedToken = "";

async function fetchLocalToken(): Promise<string> {
  for (const url of TOKEN_PATHS) {
    // 用 AbortController 而不是 AbortSignal.timeout：老 WebKit 没有后者，
    // 而它抛出来的样子和「内核不在」一模一样，会变成一条看不懂的提示条。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ac.signal });
      if (!r.ok) continue;
      const data = (await r.json()) as { token?: unknown };
      const token = typeof data?.token === "string" ? data.token.trim() : "";
      if (token) return token;
    } catch { /* 下一个候选 */ } finally { clearTimeout(timer); }
  }
  return "";
}

/** 取令牌（并发调用共用同一个请求；失败也是一次性的，不会自动重试） */
export function ensureLocalToken(): Promise<string> {
  if (!localTokenPromise) {
    localTokenPromise = fetchLocalToken().then((t) => {
      cachedToken = t;
      localTokenState = t ? "ready" : "missing";
      return t;
    });
  }
  return localTokenPromise;
}

/**
 * 已拿到的令牌（**同步**）—— 给「必须在同步路径里拼 URL」的调用方用。
 *
 * 谁需要：`<img>/<video>/<audio>` 的 src 与 `window.open` 的目标 URL ——
 * 前者是渲染函数（发请求就会在渲染里产生副作用，见 App 的令牌提示条那套机制），
 * 后者要保住用户手势（`await` 一下弹窗许可就没了）。这些地方只能在拼 URL 的那一刻取值。
 *
 * 取不到（还没取到 / 取失败）返回空串：URL 里干脆不带令牌 —— 那条请求会 401，
 * 而用户已经能从 App 的提示条上看到「没取到令牌」+「重试」，不是静默失败。
 * 失效策略只有一条：用户点「重试」（retryLocalToken 清缓存重取）；没有第二种自动失效。
 */
export function getLocalTokenCached(): string {
  return cachedToken;
}

/** 面板渲染用：现在手上有没有令牌（失败时 App 会显示提示条，不是白屏） */
export function getLocalTokenState(): LocalTokenState {
  return localTokenState;
}

/** 提示条上「重试」用：清缓存重新取一次（用户触发，不是定时重试） */
export function retryLocalToken(): Promise<string> {
  localTokenState = "pending";
  localTokenPromise = null;
  return ensureLocalToken();
}

/**
 * **所有** 8008 请求的唯一出口：自动补 `X-Dove-Token` 头。
 * 别在这个文件里直接写 `fetch(...)` 打兼容层 —— 漏了令牌就是 401。
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await ensureLocalToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Dove-Token", token);
  return fetch(url, { ...init, headers });
}

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
    /** 审批类 ask_user（不是普通提问）——「同意并记住」只画在它上面 */
    approval?: boolean;
    /** 「同意并记住」将落下的规则形状；缺省 = 不给该选项（见 SSEEvent.remember_rule） */
    remember_rule?: string;
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
    /** 审批类提问（带「允许/拒绝」）——只有它有「同意并记住」 */
    approval?: boolean;
    /** 「同意并记住」将落下的规则形状（工具自报的参数模式） */
    remember_rule?: string;
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
  /**
   * 本轮净 diff（内核 turn_diff 事件）——「这一轮改了什么」。
   * 只覆盖 Write/Edit 自报的改动。
   * 实时来自 SSE；刷新后由 /api/history 的 `turn_diff` / `turn_files` 回填（兼容层落盘，
   * 见 harness/.../legacy/turn-files-store.ts）。
   * 空 diff（一轮只读）**不留任何东西**：连字段都不设，渲染端自然没有空块。
   */
  turn_diff?: TurnDiff;
  /**
   * 本轮的**文件清单**（每轮文件卡片用）：优先读它，没有再退回 `turn_diff.files`。
   * 两者内容相同，分开存是为了让「持久化回填」与「实时事件」两个来源各自可辨
   * （见 ChatPanel 的 turn_files 赋值与 turn-files-card 的取值顺序）。
   */
  turn_files?: TurnDiffFile[];
}

// Todo 项目类型
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/** 本轮净 diff 里一个文件的增删统计（内核 turn_diff 事件） */
export interface TurnDiffFile {
  path: string;
  added: number;
  removed: number;
  created?: boolean;
  deleted?: boolean;
}

/**
 * 本轮净 diff ——「这一轮改了什么」。
 * ⚠️ 只覆盖工具**自报**的写操作（Write/Edit），Bash 里的 `> f` / `sed -i` 不在内
 * （见内核 tools/turn-diff.ts 的边界说明）；且内核不落盘 → **刷新后没有**（实时限定）。
 */
export interface TurnDiff {
  files: TurnDiffFile[];
  /** true = 结果不完整（文件条目或正文被截断） */
  truncated?: boolean;
  /** 近似统一 diff 文本（最多 20k 字符）——放在可展开处，别默认铺满 */
  diff?: string;
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
  /**
   * 这一轮的模式（「+」菜单 / 斜杠命令选出来的）。kernel 只认 swarm：
   * 用多个子代理并行处理这一轮。**不传就是老行为** —— JSON.stringify 会整个丢掉
   * undefined 字段，所以关着的时候请求体和以前逐字节一致。
   */
  mode?: "plan" | "goal" | "swarm";
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
  /**
   * 这是**工具审批**（不是普通提问）——「同意并记住」只画在它上面。
   * 面板按它区分「允许/拒绝」的确认框和真正的提问（见 MessageList 的 AskUserInline）。
   */
  approval?: boolean;
  /**
   * 「同意并记住」将落下的**规则形状**（工具自报的参数模式，如 `Bash(rm -rf /tmp/x)`）。
   * 缺省 = 算不出来 → 不给「记住」选项（点了其实没记住，比不给更糟）。
   */
  remember_rule?: string;
  // turn_diff 相关字段（本轮净 diff）
  files?: TurnDiffFile[];
  truncated?: boolean;
  diff?: string;
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
  // attach 帧相关字段（只有 `GET /api/stream` 会发，见 streamFrom）
  threadId?: string;
  running?: boolean;
  lastSeq?: number;
}

/**
 * 逐帧读一条 SSE 响应体 —— `POST /api/chat` 和 `GET /api/stream` **共用这一份**。
 *
 * 两种帧都要认：
 *   · `data: {…}`                 —— 老契约（8008 的 /api/chat）只有这个；
 *   · `id: <seq>` + `data: {…}`   —— 内核的帧带帧序号（重挂时要拿它算 after，见 streamFrom）。
 *
 * `id` **用完即清**：SSE 规范里它是粘的（后面的帧继承上一个 id），而 attach 那帧故意不带 seq ——
 * 粘住就等于把 attach 当成「有编号的一帧」，客户端的「已看到哪」被它往前带（内核 sse.ts 记着同一个坑）。
 */
async function readSseFrames(
  response: Response,
  onFrame: (event: SSEEvent, seq: number | null) => void
): Promise<void> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader) {
    throw new Error("Response body is null");
  }

  let buffer = "";
  let frameId: number | null = null;

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
        if (line.startsWith("id: ")) {
          const n = Number(line.slice(4));
          frameId = Number.isFinite(n) ? n : null;
          continue;
        }
        // 心跳（`: ping`）与空行走到这儿就被跳过了
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6);
        if (!data.trim()) continue;

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

          onFrame(event, frameId);
          frameId = null;

          // 收到 done 事件，停止处理。**要主动收线**：/api/stream 是常驻广播
          // （回合跑完连接还开着），不 cancel 它就一直挂着不放。
          if (event.type === "done") {
            await reader.cancel().catch(() => { /* 已经关了 */ });
            return;
          }
        } catch (e) {
          console.error("Failed to parse SSE event:", data, e);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 发送聊天消息并处理 SSE 流式响应。
 *
 * `seq` 是内核给这一帧分配的帧序号（只有内核才带，见 readSseFrames）——
 * 调用方拿它记「这个线程已经处理到哪儿了」，重挂时不重复应用（见 streamFrom）。
 */
export async function sendChatMessage(
  request: ChatRequest,
  onEvent: (event: SSEEvent, seq: number | null) => void
): Promise<void> {
  const response = await apiFetch(`${API_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  await readSseFrames(response, onEvent);
}

/** `GET /api/stream` 的第一帧（内核 routes-stream.ts）：这一轮在不在跑、缓冲里最后一帧的序号 */
export interface StreamAttachInfo {
  threadId: string;
  /** 这轮还在跑吗 */
  running: boolean;
  /** 帧缓冲里最后一帧的 seq（0 = 这轮没跑过 / 什么都没留） */
  lastSeq: number;
}

/**
 * 重新挂上某个线程「正在跑的那一轮」：`GET /api/stream?threadId=<id>&after=<seq>`（SSE）。
 *
 * 为什么要它：`POST /api/chat` 的 SSE 只活在**那次连接**上 —— 切走（换任务 / 标签页切后台 /
 * 页面重开）之后回来，那轮的 thinking / 工具行在面板里没有任何地方可以补看
 * （消息历史要等回合结束才落库）。契约（内核 routes-stream.ts）：
 *   ① 先来一帧 attach（**不带 seq**）告诉你这轮在不在跑；
 *   ② 再补 `seq > after` 的最近一回合的帧；
 *   ③ 之后跟着广播走，直到 done。帧序号每线程、每轮从 1 起（内核 beginTurn 会归零）。
 *
 * ⚠️ 只有**内核（8790）**有这条路由，而且只有内核起的回合会进它的帧缓冲。
 *    走 `getPanelOrigin()`（产品形态 = 面板同源的内核）；dev（vite 3006）不在内核的 CORS
 *    白名单里，那里靠 vite 的 proxy 转发（见 vite.config.ts）。
 *
 * 返回 `abort()`：切线程 / 卸载**必须**调 —— 旧流的回调还会继续跑，不 abort 就是
 * 「A 的 delta 落进 B 的视图」。`done` 是这条流的收尾（失败会 reject，调用方自己决定要不要吭声）。
 */
export function streamFrom(
  threadId: string,
  after: number,
  onEvent: (event: SSEEvent, seq: number | null) => void,
  onAttach?: (info: StreamAttachInfo) => void,
  signal?: AbortSignal
): { abort: () => void; done: Promise<void> } {
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const query = `threadId=${encodeURIComponent(threadId)}&after=${Math.max(0, Math.floor(after) || 0)}`;
  // 两个候选（照 settings-dialog.tsx 那套）：先面板同源，再按主机名 + 内核默认端口。
  // 产品形态下这两个是同一个地址 —— 去重，别白打一遍。
  const bases = [...new Set(
    typeof window === "undefined"
      ? [getPanelOrigin()]
      : [getPanelOrigin(), `http://${window.location.hostname}:8790`]
  )];

  const done = (async () => {
    let lastError = "";
    for (const base of bases) {
      try {
        const res = await apiFetch(`${base}/api/stream?${query}`, { signal: ac.signal, cache: "no-store" });
        if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
        await readSseFrames(res, (event, seq) => {
          if (event.type === "attach") {
            onAttach?.({
              threadId: typeof event.threadId === "string" ? event.threadId : threadId,
              running: event.running === true,
              lastSeq: typeof event.lastSeq === "number" ? event.lastSeq : 0,
            });
            return;
          }
          onEvent(event, seq);
        });
        return;
      } catch (e) {
        if (ac.signal.aborted) return;   // 自己 abort 的：不是错误
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(`挂不上 ${threadId} 的流：${lastError || "没有可用的内核地址"}`);
  })();

  return { abort: () => ac.abort(), done };
}

/**
 * 健康检查
 */
export async function checkHealth(): Promise<{ status: string; message: string }> {
  const response = await apiFetch(`${API_BASE_URL}/api/health`);
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
  const response = await apiFetch(`${API_BASE_URL}/api/project-info?project_id=${projectId}`);
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
  const response = await apiFetch(`${API_BASE_URL}/api/reset-project`, {
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
  const response = await apiFetch(
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
  const response = await apiFetch(`${API_BASE_URL}/api/projects`);
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
  const response = await apiFetch(`${API_BASE_URL}/api/projects/create`, {
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
  const response = await apiFetch(`${getApiBaseUrl()}/api/projects/create`, {
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

/**
 * 唤起系统原生的「选择文件夹」对话框。
 *
 * 三层，顺序有理由：
 *   ① 桌面壳的 Tauri 原生对话框（**窗口模态**，体验最好）。用 `core.invoke` 而不是插件全局：
 *      `withGlobalTauri` 一定注入 core，插件的 `__TAURI__.dialog` 反而不保证有。
 *      面板是内核托管的**远程源**，这条命令能不能过取决于 `capabilities/default.json` 的
 *      `remote.urls`（不声明时 ACL 会拒绝一切 Tauri 命令）；被拒就往下走 —— 绝不静默。
 *   ② 内核的 `/api/dialog/choose-folder`：由内核进程弹系统的 choose folder
 *      （浏览器形态唯一可行的一条；桌面壳里 ① 被拒时也走它）。
 *   ③ 都没有就返回**可读的失败原因**，由调用方显示（以前这里静默返回，用户看到的是「点了没反应」）。
 */
export async function chooseFolder(): Promise<{ success: boolean; path?: string; cancelled?: boolean; message?: string }> {
  const tauri = (window as unknown as {
    __TAURI__?: {
      core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
      dialog?: { open?: (o: unknown) => Promise<string | string[] | null> };
    };
  }).__TAURI__;
  const options = { directory: true, multiple: false, title: "选择项目文件夹" };
  const first = (v: unknown): string | null | undefined =>
    Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : undefined) : (typeof v === "string" ? v : v === null ? null : undefined);

  if (tauri?.core?.invoke || tauri?.dialog?.open) {
    try {
      const picked = tauri.core?.invoke
        ? await tauri.core.invoke("plugin:dialog|open", { options })
        : await tauri.dialog!.open!(options);
      const path = first(picked);
      if (typeof path === "string" && path) return { success: true, path };
      // null / undefined 都可能表示「用户取消」，但空数组不是 —— 空数组按失败处理，别把取消当成静默成功
      if (path === null) return { success: false, cancelled: true, message: "已取消选择" };
    } catch {
      /* 没被授权 / 插件不可用 → 退到内核那条，不吞掉（下面的兜底会给出可读结果） */
    }
  }

  const response = await apiFetch(`${getApiBaseUrl()}/api/dialog/choose-folder`, { method: "POST" });
  return response.json().catch(() => ({ success: false, message: `打开选择框失败：后端返回了读不懂的结果（HTTP ${response.status}）` }));
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
  const response = await apiFetch(`${getApiBaseUrl()}/api/projects/attach`, {
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
  const response = await apiFetch(`${API_BASE_URL}/api/projects/${port}/exists`);
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
  const response = await apiFetch(`${API_BASE_URL}/api/projects/${port}/start`, {
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
  /** running | done | error | canceled | unknown（内核归一过，见 CONTRACT.md） */
  status: string;
  background: boolean;
  taskId: string | null;
  parentId: string;
  projectId?: string | null;
  /**
   * 它跑的时候用的模型。**null = 内核没记过**（记录模型之前的老子代理）——
   * 界面显示「未记录」，**不要**退回任何默认值（见 CONTRACT.md 的说明）。
   */
  model?: string | null;
  roleId?: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** 开始到结束的毫秒；还在跑 = null（界面拿 startedAt 自己走表） */
  durationMs?: number | null;
  parts: number;
  endReason?: string | null;
  /** 项目根路径（卡片上那行仓库路径） */
  projectPath?: string | null;
  /**
   * token 用量（后台子代理才有：记录在任务表里，见内核 agents/task-registry.ts）。
   * null = 没有记录 / provider 没报 → 界面显示「未上报」，**不是 0**。
   */
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** 「后台 Agent」列表的状态页签（与内核 `?status=` 一一对应） */
export type SubagentStatusFilter = "recent" | "running" | "done" | "failed" | "all";

/**
 * 列出某个项目派出去的子代理。
 *
 * 不带参数 = 内核的 `all`（升序、全量）—— 老的调用方（ChatPanel 的顶栏补历史）走这条。
 * 「后台 Agent」页带着 status 走，拿到的就是那个页签该显示的那批。
 */
export async function listSubagents(
  projectKey: string,
  opts: { status?: SubagentStatusFilter } = {},
): Promise<SubagentInfo[]> {
  const q = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
  const r = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(projectKey)}/subagents${q}`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { subagents?: SubagentInfo[] };
  return d.subagents ?? [];
}

/**
 * 一个子代理的运行过程条目（「点进去看它干了什么」）。
 *
 * 形状对齐内核（见 legacy/CONTRACT.md）：思考 / 正文 / 工具调用 + 结果，顺序 = 发生顺序。
 * `result` **只有它结束落盘之后才有** —— 运行中那段走 SSE 的实时时间线（面板自己拼）。
 */
export interface SubagentEntry {
  kind: "reasoning" | "text" | "tool";
  text?: string;
  tool?: string;
  /** 参数摘要（内核用实时流同一个 toolInfoLine 抽的） */
  info?: string;
  args?: Record<string, unknown>;
  result?: string;
  /** true 成功 / false 失败 / 缺省 = 只记了调用、没有结论 */
  ok?: boolean;
  at?: number;
}

export interface SubagentDetail {
  subagent: SubagentInfo;
  entries: SubagentEntry[];
  /** 它还在跑：过程要等结束才落盘，所以上面的 entries 多半是空的（实时走 SSE） */
  running: boolean;
}

/** 取单个子代理的元信息 + 过程条目 */
export async function readSubagent(projectKey: string, id: string): Promise<SubagentDetail> {
  const url = `${getApiBaseUrl()}/api/projects/${encodeURIComponent(projectKey)}/subagents/${encodeURIComponent(id)}`;
  const r = await apiFetch(url);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as Partial<SubagentDetail>;
  if (!d.subagent) throw new Error("响应里没有 subagent");
  return { subagent: d.subagent, entries: d.entries ?? [], running: d.running === true };
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
  const r = await apiFetch(`${getApiBaseUrl()}/api/threads/${encodeURIComponent(threadId)}/messages`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  return r.json();
}

/**
 * 权限：**两轴**（sandbox × approval），见内核 `tools/permission.ts`。
 *
 *   sandbox   能碰到什么：read-only | workspace-write | danger-full-access
 *   approval  要不要问：  never | risky（启发式+分类器）| review（实验：每条带命令的调用都过分类器）
 *   writableRoots  工作区之外**额外**允许写的目录（绝对路径）
 *
 * UI 上那四个档位（见 PermissionPreset.value）只是给这两根轴取个名字；
 * 新代码想知道「这一档到底会怎样」就读 profile，别再从 value 反推。
 */
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access" | "auto";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "never" | "risky" | "review";

export interface PermissionProfile {
  sandbox: SandboxMode;
  approval: ApprovalPolicy;
  writableRoots: string[];
}

/** 权限预设（B4）—— 主机下发，前端只渲染 */
export interface PermissionPreset {
  value: PermissionMode;
  label: string;
  description: string;
  requiresConfirm: boolean;
  experimental: boolean;
  /** 这一档真正生效的两根轴（主机下发；老主机没有这个字段时按 value 兜底） */
  profile?: PermissionProfile;
}

export async function getPermissionPresets(): Promise<PermissionPreset[]> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/permission-presets`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { presets?: PermissionPreset[] };
  return d.presets ?? [];
}

export async function getPermissionMode(port: string): Promise<PermissionMode> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/permission`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { mode?: PermissionMode };
  return d.mode ?? "workspace-write";
}

/** 读整份 profile（两轴 + 可写目录）。读不到时返回 undefined —— 调用方保留现值，别编默认值 */
export async function getPermissionProfile(port: string): Promise<PermissionProfile | undefined> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/permission`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { profile?: PermissionProfile };
  return d.profile;
}

/**
 * 改「额外可写目录」（整份替换）。
 * 只收绝对路径 —— 相对路径内核会丢掉（它相对哪个 cwd 都是歧义）。
 */
export async function setWritableRoots(port: string, writableRoots: string[]): Promise<PermissionProfile | undefined> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ writableRoots }),
  });
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { profile?: PermissionProfile };
  return d.profile;
}

export async function setPermissionMode(port: string, mode: PermissionMode): Promise<PermissionMode> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { mode?: PermissionMode };
  return d.mode ?? mode;
}

/**
 * 计划模式（B5）—— 和权限档**同一个接口、同一份线程 metadata**，但它是独立的一位：
 * 开关计划模式不改权限档，只让内核把写类工具从工具表里裁掉（硬只读）。模型调研完
 * 用 ExitPlanMode 提交计划、走审批；批准后内核自己把这一位关掉 —— 所以面板要能重读。
 *
 * key 可以是端口 / 项目 id / 目录名（后端三键查找）。
 */
export async function getPlanMode(port: string): Promise<boolean> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/permission`);
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { planMode?: boolean };
  return d.planMode === true;
}

/** 打开 / 关闭计划模式，返回后端确认后的值 */
export async function setPlanMode(port: string, planMode: boolean): Promise<boolean> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planMode }),
  });
  if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
  const d = (await r.json()) as { planMode?: boolean };
  return d.planMode === true;
}

/* ============================ 长期目标（Goal） ============================ */

/**
 * 长期目标 —— 每个线程至多一个，存在内核里。目标 active 时**内核会在每轮结束后
 * 自动再开一轮**（受 max_rounds 限制），所以面板只负责展示 + 人类操作入口：
 * 建 / 暂停 / 继续 / 完成 / 标阻塞 / 清除。模型侧走的是 CreateGoal / GetGoal /
 * UpdateGoal 三个工具，两边共用同一个 GoalStore。
 *
 * key 可以是端口 / 项目 id / 目录名（后端三键查找，和权限接口完全一致）。
 */
export type GoalPhase = "active" | "paused" | "blocked" | "complete";

/** 内核 goalView 的形状（字段名就是线上的下划线命名，别改成驼峰） */
export interface Goal {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  rounds_started: number;
  max_rounds: number;
  /** 只有 blocked 才有 */
  blocked_reason?: string;
}

/** 面板能发的动作（内核 ACTIONS 全集） */
export type GoalAction = "create" | "pause" | "resume" | "complete" | "blocked" | "clear";

export interface GoalPostBody {
  action: GoalAction;
  /** create 必填 */
  objective?: string;
  max_rounds?: number;
  /** blocked 必填 */
  blocked_reason?: string;
}

export interface GoalPayload {
  goal: Goal | null;
  /** 内核附的一句话说明（为什么没有 / 现在什么状态） */
  note?: string;
}

/**
 * 目标接口的错误 —— **带上内核的 code**，调用方要按它分支：
 *   404 GOAL_NOT_FOUND       还没有目标（pause/resume/complete/blocked 时）
 *   409 GOAL_ALREADY_EXISTS  已有未完成的目标（create 时）→ 提示"先 /goal clear"
 * 只抛 `HTTP error! status: 409` 的话，这些提示一句都写不出来。
 */
export class GoalApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "GoalApiError";
    this.status = status;
    this.code = code;
  }
}

async function readGoalPayload(r: Response): Promise<GoalPayload> {
  const d = (await r.json().catch(() => ({}))) as {
    goal?: Goal | null; note?: string; code?: string; message?: string;
  };
  if (!r.ok) throw new GoalApiError(d.message || `HTTP error! status: ${r.status}`, r.status, d.code);
  return { goal: d.goal ?? null, note: d.note };
}

/** 读当前目标。没有目标不是错误：内核返回 { goal: null, note } */
export async function getGoal(key: string): Promise<GoalPayload> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(key)}/goal`);
  return readGoalPayload(r);
}

/** 建 / 暂停 / 继续 / 完成 / 标阻塞 / 清除，返回内核确认后的状态（权威） */
export async function postGoal(key: string, body: GoalPostBody): Promise<GoalPayload> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(key)}/goal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readGoalPayload(r);
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
  const response = await apiFetch(`${getApiBaseUrl()}/api/projects/${encodeURIComponent(port)}/delete`, {
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
  const response = await apiFetch(`${getApiBaseUrl()}/api/projects/${port}/stop`, {
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
  const response = await apiFetch(`${API_BASE_URL}/api/projects/${port}/restart`, {
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
  const response = await apiFetch(`${getApiBaseUrl()}/api/projects/${port}/plan`);
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
  answer: string,
  /**
   * 「同意并记住」——**只对工具审批有意义**（回答提问时不要传）：
   * 内核会按这次调用的形状写一条会话规则，之后同形状直接放行
   * （见内核 legacy/routes-chat.ts 与 core 的 tools/rule-pattern.ts）。
   * 不传时字段整个丢掉 —— 请求体和以前逐字节一致。
   */
  remember?: boolean
): Promise<{
  success: boolean;
  message: string;
}> {
  const response = await apiFetch(`${API_BASE_URL}/api/user-input`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id: sessionId,
      answer: answer,
      ...(remember === true ? { remember: true } : {}),
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
  const response = await apiFetch(`${API_BASE_URL}/api/stop`, {
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
 * 运行中插话（steering）。
 *
 * 语义要说清楚：它**不打断**正在生成的那一步 —— 内核只在**下一个 step 边界**
 * 把它折进当前回合（core/src/loop/turn.ts 的 drainSteering），所以成功 ≠ 已经生效。
 * 这正是它和「排队等下一轮」的区别：排队要等整个回合跑完，插话只要等这一步跑完。
 *
 * key 可以是端口 / 项目 id / 目录名（后端三键查找，和权限接口完全一致）。
 * 没有在跑的回合时不该调它：消息会一直躺在内核的 steering 队列里没人读。
 */
export async function steerMessage(key: string, text: string): Promise<{
  success: boolean;
  queued: boolean;
  message?: string;
}> {
  const r = await apiFetch(`${getApiBaseUrl()}/api/steer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: key, message: text }),
  });
  const d = (await r.json().catch(() => ({}))) as { success?: boolean; queued?: boolean; message?: string };
  if (!r.ok || d.success === false) {
    throw new Error(d.message || `HTTP error! status: ${r.status}`);
  }
  return { success: true, queued: d.queued !== false, message: d.message };
}

/**
 * 重试：丢弃临时分支上的修改，切回主分支
 */
export async function retryGeneration(projectId: string): Promise<{
  success: boolean;
  message?: string;
  error?: string;
}> {
  const response = await apiFetch(`${API_BASE_URL}/api/retry`, {
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
  /**
   * 这一轮改了哪些文件（兼容层按消息 id 落盘后回填，见 legacy/turn-files-store.ts）。
   * 与实时 SSE 的 turn_diff 同源；刷新页面后靠它重建「每轮文件卡片」。
   */
  turn_files?: TurnDiffFile[];
  /** 这一轮的近似统一 diff 正文（≤20k 字符）——「展开 diff」用，刷新后不丢 */
  turn_diff?: string;
  /** 文件条目或 diff 正文被截断 */
  turn_files_truncated?: boolean;
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
  const response = await apiFetch(`${API_BASE_URL}/api/history?project_id=${projectId}`);
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
  const response = await apiFetch(`${API_BASE_URL}/api/browser_result`, {
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
  const response = await apiFetch(`${API_BASE_URL}/api/switch-version`, {
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
  const response = await apiFetch(`${API_BASE_URL}/api/switch-to-latest`, {
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
  const response = await apiFetch(`${API_BASE_URL}/api/versions?project_id=${projectId}&limit=${limit}`);
  
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
  const response = await apiFetch(`${API_BASE_URL}/api/project-status?project_id=${projectId}`);
  
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
  const response = await apiFetch(`${API_BASE_URL}/api/set-preview-version?project_id=${projectId}${version !== null ? `&version=${version}` : ''}`, {
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

/** Blob → base64（分块，避免 String.fromCharCode 参数过多爆栈） */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 上传文件到当前任务（落盘到 `<项目>/uploads/`），返回文件在服务端的样子。
 *
 * ⚠️ 请求体是 **JSON + base64**，不是 multipart —— 这不是随便选的：
 * 内核兼容层的 /api/upload-file 用 readBody() 读请求体，它只 JSON.parse，
 * 拿到 multipart 会解析成空对象，于是连 project_id 都读不到 →
 * 404「项目不存在」（**实测**：multipart 必 404）。所以按它真正认的形状发：
 *   { project_id, filename, mime_type, content_base64 }
 *
 * 格式不设限（内核按字节原样写盘），只有 20MB 这一条上限，客户端先挡一道，
 * 内核侧还有一道（超了返回 400，这里会原样抛出来）。
 */
export async function uploadFile(file: File, projectId: string): Promise<UploadedFile> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`「${file.name}」太大（${formatBytes(file.size)}）—— 单个文件上限 20MB`);
  }

  const response = await apiFetch(`${getApiBaseUrl()}/api/upload-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      filename: file.name,
      // 内核会把名字里的特殊字符换成 "_"，所以下面一律用**返回的** filename，
      // 不拿用户给的名字去拼路径（拼不上就找不到文件）
      mime_type: file.type || "application/octet-stream",
      content_base64: await blobToBase64(file),
    }),
  });

  if (!response.ok) {
    let detail = `上传失败: ${response.status}`;
    try {
      const error = await response.json();
      if (error?.error) detail = String(error.error);
    } catch { /* 响应体不是 JSON：保留状态码那句话 */ }
    throw new Error(`「${file.name}」${detail}`);
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

// ==================== 截屏 ====================

/**
 * 框选截屏的返回 —— **三种形状都算正常返回**，所以 ok:false 不当异常抛：
 *   ok:true               截到了，data 是 PNG 的 base64
 *   ok:false + cancelled  用户按了 Esc（不是错误，面板什么都不做）
 *   ok:false + error      真出错：501 非 macOS / 500 空截图 / 413 太大
 */
export type CaptureScreenResult =
  | { ok: true; name: string; mediaType: string; data: string }
  | { ok: false; cancelled: true; error?: undefined }
  | { ok: false; cancelled?: false; error: string };

/**
 * 让用户框选屏幕截一张图（内核侧的 macOS 原生实现）。没有请求体；
 * 出错那几个状态码也带着 { ok:false, error } 的正文回来，照常解析。
 */
export async function captureScreen(): Promise<CaptureScreenResult> {
  const response = await apiFetch(`${API_BASE_URL}/api/capture`, { method: "POST" });
  const data = await response.json() as { ok?: unknown };
  if (typeof data?.ok !== "boolean") {
    throw new Error(`截屏接口返回异常（HTTP ${response.status}）`);
  }
  return data as CaptureScreenResult;
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
  const response = await apiFetch(`${getApiBaseUrl()}/api/import-project`, {
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
  const response = await apiFetch(`${getApiBaseUrl()}/api/projects/${port}/files${query}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "读取目录失败" }));
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 读取项目内单个文件内容（用于目录树的文件预览）
 *
 * `limit`（字节，可选）：只看前 N 字节 —— 超大文本走这条，别让 413 把预览打死。
 * 响应 `truncated: true` 时 `size` 仍是**完整**大小，界面据此提示「共多大」。
 */
export async function readProjectFile(
  port: string,
  path: string,
  options: { limit?: number } = {}
): Promise<{
  success: boolean;
  path: string;
  name: string;
  size: number;
  language?: string | null;
  content: string;
  truncated?: boolean;
}> {
  const query = `path=${encodeURIComponent(path)}${options.limit ? `&limit=${Math.floor(options.limit)}` : ""}`;
  const response = await apiFetch(`${getApiBaseUrl()}/api/projects/${port}/file?${query}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "读取文件失败" }));
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 单文件元信息（大小 / 修改时间）—— 不读正文。
 *
 * 为什么先 stat 再决定怎么读：图片 / 音视频 / office 根本不用读正文；
 * 文本要先知道多大，才能决定「整读」还是「只读前 256KB」（见 file-viewer.tsx）。
 */
export async function statProjectFile(
  port: string,
  path: string
): Promise<{
  success: boolean;
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
  /** 秒（与目录树的 modified 同口径） */
  modified: number;
  language?: string | null;
}> {
  const response = await apiFetch(
    `${getApiBaseUrl()}/api/projects/${port}/stat?path=${encodeURIComponent(path)}`
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "读取文件信息失败" }));
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 「打开方式」菜单的后端：用系统默认应用打开 / 在文件管理器里显示。
 *
 * 路径必须落在项目工作区内 —— 越界是**硬拒**（403），不是提示词约束，见
 * harness/packages/server/src/legacy/routes-open-path.ts 顶部的三道闸。
 */
export async function openProjectPath(input: {
  /** 项目端口 / id / 目录名（三键查找）；不传 = 以工作区根为边界 */
  projectId?: string | null;
  path: string;
  action: "default" | "reveal";
}): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await apiFetch(`${getApiBaseUrl()}/api/open-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: input.path,
        action: input.action,
        ...(input.projectId ? { project_id: input.projectId } : {}),
      }),
    });
    const data = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
    if (data && typeof data.message === "string") return { ok: data.ok === true, message: data.message };
    return { ok: false, message: `打开失败：HTTP ${response.status}` };
  } catch (e) {
    return { ok: false, message: `打开失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 「用哪个 App 打开」（分体按钮）的后端三件套：清单 / 用指定 App 打开 / App 图标。
 *
 * 为什么清单必须问内核而不是面板自己写死：探测（在 Applications 目录里找 bundle）只有内核做得到，
 * 面板自己写死就会列出一堆本机没装的 App。清单是**数据表**
 * （harness/packages/server/src/legacy/open-in-app.ts），面板只渲染内核回的 `{id,name}`。
 *
 * 与 openProjectPath 的分工：那个是「用系统默认应用打开」（交给 OS 的文件关联），
 * 这里是指定 App（同一个路径守卫，见 routes-open-in-app.ts 顶部的安全边界）。
 */
export interface OpenInAppEntry {
  id: string;
  name: string;
  /** 这个 App 的动作：`open` = 打开这个文件；`reveal` = 显示它所在的位置（访达那行） */
  action: "open" | "reveal";
}

/** 已装 App 清单。失败**抛**（不是回空清单）：调用方要能区分「探测失败」与「一个都没装」。 */
export async function listOpenInApps(): Promise<{ apps: OpenInAppEntry[]; platform: string }> {
  const response = await apiFetch(`${getApiBaseUrl()}/api/open-in-app/apps`, { cache: "no-store" });
  if (!response.ok) throw new Error(`读取已装 App 清单失败：HTTP ${response.status}`);
  const data = (await response.json()) as { apps?: unknown; platform?: unknown };
  const apps = Array.isArray(data.apps)
    ? data.apps
      .map((raw) => raw as { id?: unknown; name?: unknown; action?: unknown })
      .filter((raw) => typeof raw.id === "string" && typeof raw.name === "string")
      .map((raw) => ({
        id: String(raw.id),
        name: String(raw.name),
        // 老内核（没有 action 字段）一律当 open —— 别因为缺个字段就让菜单崩掉
        action: (raw.action === "reveal" ? "reveal" : "open") as "open" | "reveal",
      }))
    : [];
  return { apps, platform: typeof data.platform === "string" ? data.platform : "" };
}

/** 用**清单里的某个 App** 打开这个路径（appId 走内核清单，面板传不了可执行文件名）。 */
export async function openProjectPathWithApp(input: {
  /** 项目端口 / id / 目录名（三键查找）；不传 = 以工作区根为边界 */
  projectId?: string | null;
  path: string;
  appId: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await apiFetch(`${getApiBaseUrl()}/api/open-in-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: input.appId,
        path: input.path,
        ...(input.projectId ? { project_id: input.projectId } : {}),
      }),
    });
    const data = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
    if (data && typeof data.message === "string") return { ok: data.ok === true, message: data.message };
    return { ok: false, message: `打开失败：HTTP ${response.status}` };
  } catch (e) {
    return { ok: false, message: `打开失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * App 图标（内核用 sips 从 `.icns` 抽的 64px PNG）。
 *
 * 为什么要绕一道 blob：图标路由在 `/api/*` 令牌闸门之内（同 8008 的其它路由），
 * 而 `<img src>` 发不了 `X-Dove-Token` 头 —— 直接把 URL 塞给 img 只会拿到 401。
 * 取不到（404 / 内核不带图标能力）返回 null，调用方退回通用图标。
 */
export async function fetchOpenInAppIcon(id: string): Promise<Blob | null> {
  try {
    const response = await apiFetch(`${getApiBaseUrl()}/api/open-in-app/icon?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 && blob.type.startsWith("image/") ? blob : null;
  } catch {
    return null;
  }
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
  const response = await apiFetch(`${getApiBaseUrl()}/api/projects/${port}/sessions?limit=${limit}`);
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
  const response = await apiFetch(`${getApiBaseUrl()}/api/projects/${port}/session-log?${query}`);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

/**
 * 会话日志的实时推送地址（SSE：先补历史再持续 tail）。
 *
 * 异步：EventSource 发不了自定义头，令牌只能走 `?token=`（兼容层的闸门两种都认）。
 */
export async function sessionLogStreamUrl(port: string, session = "", offset = 0): Promise<string> {
  const query = new URLSearchParams({ offset: String(offset) });
  if (session) query.set("session", session);
  const token = await ensureLocalToken();
  if (token) query.set("token", token);
  return `${getApiBaseUrl()}/api/projects/${port}/session-log/stream?${query}`;
}



// ==================== 模型设置（设置对话框 + 模型 chip）====================

/**
 * 内核里当前的模型设置。**没有 key 本体**：hasKey 表示「存着 / env 里给了」，
 * keyMasked 是给界面看的唯一形态（sk-…c32b）。界面任何时候都不该拿到整把 key。
 */
export interface ModelSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyMasked: string;
}

/** 读当前设置（内核是权威存储：存盘文件 > env > 默认） */
export async function getModelSettings(): Promise<ModelSettings> {
  const response = await apiFetch(`${getApiBaseUrl()}/api/settings/model`);
  if (!response.ok) throw new Error(`读模型设置失败（HTTP ${response.status}）`);
  return response.json();
}

/**
 * 写设置（只传要改的字段）→ 内核落盘 + **下一轮就用新的**，不用重启。
 * apiKey 传空串 = 不改 key：面板拿不到原值，回传的永远是空串或用户新敲的那把。
 */
export async function saveModelSettings(patch: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): Promise<ModelSettings & { ok: true }> {
  const response = await apiFetch(`${getApiBaseUrl()}/api/settings/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `保存模型设置失败（HTTP ${response.status}）`);
  }
  return data;
}

/** 「测试」的结果 —— 不通也是**正常返回**（ok:false），不当异常抛 */
export type ModelTestResult =
  | { ok: true; model: string; latencyMs: number }
  | { ok: false; error: string };

/**
 * 让内核真打一次最小 completion（15s 超时）。
 * 可以带上**还没保存**的值：用户刚敲完 key 就想试，不该逼他先保存。
 */
export async function testModelSettings(patch?: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): Promise<ModelTestResult> {
  const response = await apiFetch(`${getApiBaseUrl()}/api/settings/model/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (typeof data?.ok !== "boolean") {
    return { ok: false, error: `测试接口返回异常（HTTP ${response.status}）` };
  }
  return data as ModelTestResult;
}
