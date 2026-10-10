/**
 * MCP 服务器配置管理（T3.12）
 *
 * 配置文件：<configDir>/mcp.json
 *   { "servers": { "名字": { "command": "...", "args": [...], "env": {...}, "enabled": true } } }
 *
 * 纪律：
 *  - 所有对外方法**不抛**：连不上就是 { ok:false, error }，绝不拖垮 server 启动
 *  - 工具顺序 = 配置文件里的服务器顺序 × 每服务器工具名排序 → 两次注册前缀一致（前缀缓存）
 *  - 子进程意外退出 → 立刻摘掉该 server 的工具并回调 onToolsChanged（别让模型拿到死工具）
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../tools/types.ts";
import { errMsg } from "../tools/builtin/util.ts";
import { connectMcp, defaultMcpLogger } from "./client.ts";
import type { McpClient, McpServerConfig, McpToolDef } from "./client.ts";
import type { RpcLogger } from "./jsonrpc.ts";
import { bridgeTools } from "./tools-bridge.ts";

export interface McpListEntry {
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
}
export interface McpConnectResult { ok: boolean; tools: string[]; error?: string }
export interface McpConnectAllResult {
  connected: string[];
  failed: { name: string; error: string }[];
  skipped: string[];
}
export interface McpReloadResult {
  added: string[];
  removed: string[];
  changed: string[];
  failed: { name: string; error: string }[];
  tools: { before: string[]; after: string[] };
}
export interface McpManagerOptions {
  configDir: string;
  logger?: RpcLogger;
  /** 工具集合变化时回调（server 侧接 registerExternalTools） */
  onToolsChanged?: (tools: Tool[]) => void;
  /** 配置文件路径覆盖（测试用；默认 <configDir>/mcp.json） */
  configFile?: string;
}

interface McpServerState {
  name: string;
  cfg: McpServerConfig;
  status: "idle" | "connected" | "error";
  tools: Tool[];
  client?: McpClient;
  error?: string;
  connectedAt?: number;
}

const VAR_RE = new RegExp("\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}", "g");

/** 展开环境变量占位符（配置里不写死密钥） */
export function expandVars(s: string): string {
  return s.replace(VAR_RE, (_m, key: string) => process.env[key] ?? "");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class McpManager {
  #configFile: string;
  #logger: RpcLogger;
  #onToolsChanged: ((tools: Tool[]) => void) | undefined;
  #servers = new Map<string, McpServerState>();
  #invalid: Record<string, string> = {};
  #inflight = new Map<string, Promise<McpConnectResult>>();

  constructor(opts: McpManagerOptions) {
    this.#configFile = opts.configFile ?? join(opts.configDir, "mcp.json");
    this.#logger = opts.logger ?? defaultMcpLogger;
    this.#onToolsChanged = opts.onToolsChanged;
  }

  get configPath(): string { return this.#configFile; }

  /** 读配置（不连接）；配置不存在 / 解析失败都只是记日志，不算致命 */
  async load(): Promise<void> {
    const next = this.#read();
    this.#invalid = next.invalid;
    for (const name of [...this.#servers.keys()]) {
      if (!next.configs[name]) { this.#drop(name); this.#servers.delete(name); }
    }
    for (const [name, cfg] of Object.entries(next.configs)) {
      const st = this.#servers.get(name);
      if (st) st.cfg = cfg;
      else this.#servers.set(name, { name, cfg, status: "idle", tools: [] });
    }
    if (next.error) this.#logger("warn", "[mcp] 配置读取异常：" + next.error);
    else if (next.note) this.#logger("info", "[mcp] " + next.note + "（无外部工具）");
    else this.#logger("info", "[mcp] 载入 " + this.#servers.size + " 个服务器配置：" + this.#configFile);
  }

  listServers(): McpListEntry[] {
    const out: McpListEntry[] = [];
    for (const st of this.#servers.values()) {
      out.push({
        name: st.name,
        enabled: st.cfg.enabled !== false,
        connected: st.status === "connected" && st.client?.alive === true,
        toolCount: st.tools.length,
        ...(st.error ? { error: st.error } : {}),
      });
    }
    for (const [name, error] of Object.entries(this.#invalid)) {
      out.push({ name, enabled: false, connected: false, toolCount: 0, error });
    }
    return out;
  }

  /** 连接一个 server 并热注册它的工具；同一 server 并发调用共享同一次连接 */
  connect(name: string): Promise<McpConnectResult> {
    const running = this.#inflight.get(name);
    if (running) return running;
    const p = this.#connectOnce(name).finally(() => { this.#inflight.delete(name); });
    this.#inflight.set(name, p);
    return p;
  }

  async #connectOnce(name: string): Promise<McpConnectResult> {
    const st = this.#servers.get(name);
    if (!st) return { ok: false, tools: [], error: "未配置的 MCP 服务器：" + name };
    if (st.cfg.enabled === false) return { ok: false, tools: [], error: "MCP 服务器已禁用：" + name };
    if (st.client?.alive) return { ok: true, tools: st.tools.map((t) => t.name) };

    this.#drop(name);
    const started = Date.now();
    try {
      const client = await connectMcp({ ...st.cfg, name }, {
        logger: this.#logger,
        onClose: (reason) => { this.#onClientClose(name, reason); },
      });
      const defs = await client.listTools();
      st.client = client;
      st.tools = bridgeTools(name, client, pickTools(defs, st.cfg));
      st.status = "connected";
      st.error = undefined;
      st.connectedAt = Date.now();
      this.#logger("info", "[mcp] " + name + " 已连接，" + st.tools.length + " 个工具（" + (Date.now() - started) + "ms）");
      this.#notify();
      return { ok: true, tools: st.tools.map((t) => t.name) };
    } catch (e) {
      st.status = "error";
      st.error = errMsg(e);
      st.tools = [];
      st.client = undefined;
      this.#logger("error", "[mcp] " + name + " 连接失败：" + st.error);
      this.#notify();
      return { ok: false, tools: [], error: st.error };
    }
  }

  /** 断开（保留配置）；工具立刻从表里消失 */
  disconnect(name: string): void {
    if (!this.#servers.has(name)) return;
    this.#drop(name);
    this.#logger("info", "[mcp] " + name + " 已断开");
    this.#notify();
  }

  /** 连接全部启用的 server；单个失败不影响其他 */
  async connectAll(): Promise<McpConnectAllResult> {
    const enabled: string[] = [];
    const skipped: string[] = [];
    for (const st of this.#servers.values()) {
      if (st.cfg.enabled === false) skipped.push(st.name); else enabled.push(st.name);
    }
    const finished = await Promise.all(enabled.map(async (n) => ({ n, r: await this.connect(n) })));
    const connected: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const { n, r } of finished) {
      if (r.ok) connected.push(n); else failed.push({ name: n, error: r.error ?? "未知错误" });
    }
    return { connected, failed, skipped };
  }

  /**
   * 已连接的客户端（资源工具用）：顺序 = 配置顺序，只回**真正连上**的。
   * 为什么需要它：资源（resources/*）不在工具桥的覆盖范围里，
   * ListMcpResources / ReadMcpResource 必须拿到 client 本体才能发请求。
   */
  connectedClients(): { name: string; client: McpClient }[] {
    const out: { name: string; client: McpClient }[] = [];
    for (const st of this.#servers.values()) {
      if (st.status === "connected" && st.client?.alive) out.push({ name: st.name, client: st.client });
    }
    return out;
  }

  /** 当前所有 MCP 工具（Dove Tool 形态）；顺序稳定：配置顺序 × 工具名排序 */
  tools(): Tool[] {
    const out: Tool[] = [];
    for (const st of this.#servers.values()) {
      if (st.status === "connected" && st.client?.alive) out.push(...st.tools);
    }
    return out;
  }

  /** 配置变更后热重载：消失的断开、变更的重连、新增的连接 */
  async reload(): Promise<McpReloadResult> {
    const before = new Map<string, string>();
    for (const [name, st] of this.#servers) before.set(name, fingerprint(st.cfg));
    const toolsBefore = this.tools().map((t) => t.name);

    const next = this.#read();
    this.#invalid = next.invalid;
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    for (const [name, st] of [...this.#servers]) {
      const cfg = next.configs[name];
      if (!cfg) { this.#drop(name); this.#servers.delete(name); removed.push(name); continue; }
      if (fingerprint(cfg) !== before.get(name)) {
        this.#drop(name);
        st.cfg = cfg;
        st.status = "idle";
        st.error = undefined;
        changed.push(name);
      } else {
        st.cfg = cfg;
      }
    }
    for (const [name, cfg] of Object.entries(next.configs)) {
      if (this.#servers.has(name)) continue;
      this.#servers.set(name, { name, cfg, status: "idle", tools: [] });
      added.push(name);
    }

    const todo = [...added, ...changed].filter((n) => this.#servers.get(n)?.cfg.enabled !== false);
    const finished = await Promise.all(todo.map(async (n) => ({ n, r: await this.connect(n) })));
    const failed: { name: string; error: string }[] = [];
    for (const { n, r } of finished) if (!r.ok) failed.push({ name: n, error: r.error ?? "未知错误" });

    this.#notify();
    this.#logger("info", "[mcp] 热重载：+" + added.length + " -" + removed.length + " ~" + changed.length);
    return { added, removed, changed, failed, tools: { before: toolsBefore, after: this.tools().map((t) => t.name) } };
  }

  /** 关掉所有子进程（配置保留，可再 connect） */
  close(): void {
    for (const name of [...this.#servers.keys()]) this.#drop(name);
    this.#notify();
  }

  // ── 内部 ──────────────────────────────────────────────
  #read(): { configs: Record<string, McpServerConfig>; invalid: Record<string, string>; error?: string; note?: string } {
    const invalid: Record<string, string> = {};
    const file = this.#configFile;
    if (!existsSync(file)) return { configs: {}, invalid, note: "未找到 " + file };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return { configs: {}, invalid, error: "mcp.json 解析失败：" + errMsg(e) };
    }
    const table = isObj(raw) && isObj(raw.servers) ? raw.servers : isObj(raw) ? raw : null;
    if (!table) return { configs: {}, invalid, error: "mcp.json 结构不合法（应为 { servers: { 名字: {...} } }）" };

    const configs: Record<string, McpServerConfig> = {};
    for (const [name, v] of Object.entries(table)) {
      if (!isObj(v)) { invalid[name] = "配置项不是对象"; continue; }
      const command = expandVars(String(v.command ?? "")).trim();
      if (!command) { invalid[name] = "缺少 command"; continue; }
      const cfg: McpServerConfig = { name, command };
      if (Array.isArray(v.args)) cfg.args = v.args.map((a) => expandVars(String(a)));
      if (isObj(v.env)) {
        const env: Record<string, string> = {};
        for (const [k, val] of Object.entries(v.env)) env[k] = expandVars(String(val));
        cfg.env = env;
      }
      if (typeof v.cwd === "string" && v.cwd.trim()) cfg.cwd = expandVars(v.cwd.trim());
      if (v.enabled === false) cfg.enabled = false;
      if (typeof v.timeoutMs === "number" && v.timeoutMs > 0) cfg.timeoutMs = v.timeoutMs;
      if (Array.isArray(v.include)) cfg.include = v.include.map((x) => String(x));
      if (Array.isArray(v.exclude)) cfg.exclude = v.exclude.map((x) => String(x));
      configs[name] = cfg;
    }
    return { configs, invalid };
  }

  /** 子进程意外退出：摘掉工具 + 通知注册表（不自动重连，避免崩溃循环） */
  #onClientClose(name: string, reason: string): void {
    const st = this.#servers.get(name);
    if (!st || st.status !== "connected") return;
    st.status = "error";
    st.error = reason;
    st.tools = [];
    st.client = undefined;
    st.connectedAt = undefined;
    this.#logger("warn", "[mcp] " + name + " 连接中断：" + reason);
    this.#notify();
  }

  #drop(name: string): void {
    const st = this.#servers.get(name);
    if (!st) return;
    try { st.client?.close(); } catch { /* 关闭失败不阻断 */ }
    st.client = undefined;
    st.tools = [];
    st.status = "idle";
    st.error = undefined;
    st.connectedAt = undefined;
  }

  #notify(): void {
    if (!this.#onToolsChanged) return;
    try { this.#onToolsChanged(this.tools()); }
    catch (e) { this.#logger("error", "[mcp] 工具变更回调失败：" + errMsg(e)); }
  }
}

/** include / exclude 过滤（按 MCP 原始工具名） */
function pickTools(defs: McpToolDef[], cfg: McpServerConfig): McpToolDef[] {
  const inc = cfg.include && cfg.include.length > 0 ? new Set(cfg.include) : null;
  const exc = new Set(cfg.exclude ?? []);
  return defs.filter((d) => (!inc || inc.has(d.name)) && !exc.has(d.name));
}

/** 配置指纹：用来判断 reload 时这个 server 有没有变 */
function fingerprint(cfg: McpServerConfig): string {
  return JSON.stringify(cfg);
}
