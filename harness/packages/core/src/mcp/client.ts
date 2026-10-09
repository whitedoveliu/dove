/**
 * MCP 客户端（T3.12）
 *
 * 握手：initialize（protocolVersion + capabilities + clientInfo）→ notifications/initialized
 * 能力：tools/list（**带 cursor 分页**）、tools/call、resources/list、resources/read、ping
 *
 * 协议版本：客户端发 2024-11-05；服务端返回别的版本时**以服务端为准并记日志**；
 *          若服务端直接以「版本不支持」拒绝握手，用对面提示的版本重试一次。
 * 纪律：connectMcp 失败要把子进程收干净（不留孤儿），错误信息必须带服务器名。
 */
import { StdioTransport } from "./jsonrpc.ts";
import type { RpcLogger } from "./jsonrpc.ts";
import { errMsg } from "../tools/builtin/util.ts";

/** 本 host 支持的 MCP 协议版本 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_CLIENT_INFO = { name: "dove-harness", version: "0.1.0" };
export const MCP_CONNECT_TIMEOUT_MS = 20_000;
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MCP_PING_TIMEOUT_MS = 10_000;
/** tools/list 分页上限（防止服务端 cursor 死循环） */
const MAX_LIST_PAGES = 50;

export interface McpServerConfig {
  /** 服务器名（配置文件里的 key；单独用 connectMcp 时可省略） */
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 缺省视为启用 */
  enabled?: boolean;
  /** 单条请求超时覆盖（毫秒） */
  timeoutMs?: number;
  /** 工具名白名单（不填 = 全部） */
  include?: string[];
  /** 工具名黑名单 */
  exclude?: string[];
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [k: string]: unknown;
}

export interface McpContentPart {
  type?: string;
  text?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentPart[];
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

export interface McpResource {
  uri: string;
  name?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface McpResourceContent {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpReadResourceResult {
  contents?: McpResourceContent[];
  [k: string]: unknown;
}

/** 默认日志：只出 warn / error，不刷屏 */
export const defaultMcpLogger: RpcLogger = (level, msg, data) => {
  if (level === "info") return;
  const line = data === undefined ? msg : msg + " " + safeJson(data);
  if (level === "error") console.error(line); else console.warn(line);
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** 从错误里嗅出服务端提示的协议版本（形如 2024-11-05） */
export function protocolHint(e: unknown): string | undefined {
  const text = safeJson(e) + " " + errMsg(e);
  const m = /(\d{4}-\d{2}-\d{2})/.exec(text);
  return m ? m[1] : undefined;
}

export class McpClient {
  /** 实际生效的协议版本（服务端说了算） */
  protocolVersion = MCP_PROTOCOL_VERSION;
  serverInfo: Record<string, unknown> = {};
  capabilities: Record<string, unknown> = {};
  instructions: string | undefined;

  #name: string;
  #transport: StdioTransport;
  #logger: RpcLogger;
  #timeoutMs: number;
  #tools: McpToolDef[] | null = null;

  constructor(name: string, transport: StdioTransport, opts: { logger?: RpcLogger; timeoutMs?: number } = {}) {
    this.#name = name;
    this.#transport = transport;
    this.#logger = opts.logger ?? defaultMcpLogger;
    this.#timeoutMs = opts.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    // 服务端声明工具列表变了 → 丢掉缓存，下次 listTools 重新拉
    transport.onNotification((method) => {
      if (method === "notifications/tools/list_changed") this.#tools = null;
    });
  }

  get name(): string { return this.#name; }
  get alive(): boolean { return this.#transport.alive; }
  get closeReason(): string { return this.#transport.closeReason; }
  get stderrTail(): string { return this.#transport.stderrTail; }

  /** 订阅服务端通知；返回退订函数 */
  onNotification(cb: (method: string, params: unknown) => void): () => void {
    return this.#transport.onNotification(cb);
  }

  #log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
    this.#logger(level, "[mcp:" + this.#name + "] " + msg, data);
  }

  /** 握手：initialize → notifications/initialized */
  async initialize(): Promise<void> {
    let version = MCP_PROTOCOL_VERSION;
    let res: Record<string, unknown> | null = null;
    let lastErr: unknown;
    // 握手超时：配置了更严格的 timeoutMs 就听配置的（否则挂死的 server 会拖满 20s）
    const handshakeMs = Math.min(this.#timeoutMs, MCP_CONNECT_TIMEOUT_MS);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const params = { protocolVersion: version, capabilities: {}, clientInfo: MCP_CLIENT_INFO };
        const raw = await this.#transport.request<Record<string, unknown>>("initialize", params, handshakeMs);
        res = isObj(raw) ? raw : {};
        break;
      } catch (e) {
        lastErr = e;
        const hinted = protocolHint(e);
        if (attempt === 0 && hinted && hinted !== version) {
          this.#log("warn", "服务端要求协议版本 " + hinted + "（客户端 " + version + "），用该版本重试握手");
          version = hinted;
          continue;
        }
        throw e;
      }
    }
    if (!res) throw lastErr instanceof Error ? lastErr : new Error(errMsg(lastErr));

    const sv = typeof res.protocolVersion === "string" && res.protocolVersion ? res.protocolVersion : version;
    if (sv !== MCP_PROTOCOL_VERSION) {
      // 协议版本以服务端为准（MCP 规范：服务端不支持则回它自己的版本）
      this.#log("warn", "协议版本不一致：客户端 " + MCP_PROTOCOL_VERSION + " / 服务端 " + sv + "，以服务端为准");
    }
    this.protocolVersion = sv;
    this.serverInfo = isObj(res.serverInfo) ? res.serverInfo : {};
    this.capabilities = isObj(res.capabilities) ? res.capabilities : {};
    this.instructions = typeof res.instructions === "string" ? res.instructions : undefined;
    this.#log("info", "握手完成（协议 " + sv + "，服务端 " + String(this.serverInfo.name ?? "?") + " " + String(this.serverInfo.version ?? "") + "）");
    this.#transport.notify("notifications/initialized", {});
  }

  /** 主动 ping；失败抛错（要区分原因时用） */
  async ping(timeoutMs?: number): Promise<void> {
    await this.#transport.request("ping", {}, timeoutMs ?? MCP_PING_TIMEOUT_MS);
  }

  /** 健康检查：任何失败都返回 false，绝不抛 */
  async healthy(): Promise<boolean> {
    if (!this.alive) return false;
    try { await this.ping(); return true; } catch { return false; }
  }

  /** tools/list（自动翻页）；force=true 忽略缓存 */
  async listTools(force = false): Promise<McpToolDef[]> {
    if (!force && this.#tools) return this.#tools;
    const tools = await this.#paginate<McpToolDef>("tools/list", (r) => (Array.isArray(r.tools) ? r.tools.filter(isToolDef) : []));
    this.#tools = tools;
    return tools;
  }

  /** tools/call：把结果原样交回，由 tools-bridge 决定怎么呈现 */
  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<McpCallResult> {
    const raw = await this.#transport.request<McpCallResult>("tools/call", { name, arguments: args }, timeoutMs ?? this.#timeoutMs);
    return isObj(raw) ? raw : { content: [] };
  }

  /** resources/list（可选能力；服务端没实现会抛 RpcError -32601） */
  async listResources(): Promise<McpResource[]> {
    return this.#paginate<McpResource>("resources/list", (r) => (Array.isArray(r.resources) ? (r.resources.filter(isObj) as unknown as McpResource[]) : []));
  }

  /** resources/read */
  async readResource(uri: string, timeoutMs?: number): Promise<McpReadResourceResult> {
    const raw = await this.#transport.request<McpReadResourceResult>("resources/read", { uri }, timeoutMs ?? this.#timeoutMs);
    return isObj(raw) ? raw : { contents: [] };
  }

  close(): void { this.#transport.close(); }

  /** 按 cursor 翻页取全量（最多 MAX_LIST_PAGES 页，防死循环） */
  async #paginate<T>(method: string, pick: (res: Record<string, unknown>) => T[]): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params = cursor === undefined ? {} : { cursor };
      const res = await this.#transport.request<Record<string, unknown>>(method, params, this.#timeoutMs);
      const obj = isObj(res) ? res : {};
      out.push(...pick(obj));
      const next = obj.nextCursor;
      if (typeof next !== "string" || !next) return out;
      cursor = next;
    }
    this.#log("warn", method + " 分页超过 " + MAX_LIST_PAGES + " 页，已截断（服务端 cursor 可能没推进）");
    return out;
  }
}

function isToolDef(v: unknown): v is McpToolDef {
  return isObj(v) && typeof v.name === "string" && v.name.length > 0;
}

/**
 * 连接一个 MCP server 并完成握手。
 * 失败时一定把子进程收掉，再抛出带服务器名的人话错误。
 */
export async function connectMcp(
  cfg: McpServerConfig,
  opts: { logger?: RpcLogger; onClose?: (reason: string) => void } = {},
): Promise<McpClient> {
  const command = String(cfg.command ?? "").trim();
  if (!command) throw new Error("MCP 服务器缺少 command");
  const name = (cfg.name ?? "").trim() || command;
  const logger = opts.logger ?? defaultMcpLogger;

  const transport = new StdioTransport({
    logger,
    timeoutMs: cfg.timeoutMs,
    onClose: opts.onClose,
  });
  const client = new McpClient(name, transport, { logger, timeoutMs: cfg.timeoutMs });
  try {
    await transport.start(command, cfg.args ?? [], cfg.env ?? {}, cfg.cwd);
    await client.initialize();
    return client;
  } catch (e) {
    const tail = transport.stderrTail.trim().slice(-300);
    client.close();
    throw new Error("连接 MCP 服务器 " + name + " 失败：" + errMsg(e) + (tail ? "；stderr: " + tail : ""));
  }
}
