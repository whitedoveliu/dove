/**
 * MCP host 接线（T3.12）
 *
 * 职责：把 McpManager 接到 ① 工具注册表（registry.ts）② 运行时工具表（bootstrap 的 Map）。
 * 单独成文件是为了让 bootstrap.ts 保持精简（单文件 ≤ 400 行硬约束）。
 *
 * 顺序纪律：外部工具**只追加在尾部**；断开时只摘掉 mcp__ 前缀的，内置工具顺序一动不动。
 */
import { McpManager } from "../../core/src/mcp/index.ts";
import type { McpConnectResult, McpListEntry, McpReloadResult } from "../../core/src/mcp/index.ts";
import { MCP_TOOL_PREFIX } from "../../core/src/mcp/tools-bridge.ts";
import { externalTools, registerExternalTools } from "../../core/src/tools/registry.ts";
import type { Tool } from "../../core/src/tools/types.ts";

/** 路由层需要的窄接口（面板只读状态 + 手动重连/重载） */
export interface McpPort {
  listServers(): McpListEntry[];
  connect(name: string): Promise<McpConnectResult>;
  reload(): Promise<McpReloadResult>;
  toolCount(): number;
}

export interface McpWiring {
  port: McpPort;
  manager: McpManager;
  toolNames: string[];
}

/** server 侧日志出口：info → stdout，warn/error → stderr */
const logger = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void => {
  const line = data === undefined ? msg : msg + " " + JSON.stringify(data);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

/**
 * MCP 工具 → 注册表 + 运行时 Map。
 * 先 registerExternalTools（它会丢掉与内置重名的），再让 Map 与注册表**完全一致**。
 */
export function syncMcpTools(map: Map<string, Tool>, list: Tool[]): void {
  registerExternalTools(list);
  for (const name of [...map.keys()]) if (name.startsWith(MCP_TOOL_PREFIX)) map.delete(name);
  for (const t of externalTools()) map.set(t.name, t);
}

/** 把 McpManager 收窄成路由层要的端口（面板只读状态 + 手动重连/重载） */
export function makeMcpPort(manager: McpManager): McpPort {
  return {
    listServers: () => manager.listServers(),
    connect: (name: string) => manager.connect(name),
    reload: () => manager.reload(),
    toolCount: () => manager.tools().length,
  };
}

/** 初始化 MCP host：读配置 → 连接全部启用的 server → 工具进表。任何失败都只降级，不抛。 */
export async function initMcp(opts: { configDir: string; tools: Map<string, Tool> }): Promise<McpWiring> {
  const manager = new McpManager({
    configDir: opts.configDir,
    logger,
    onToolsChanged: (list) => syncMcpTools(opts.tools, list),
  });
  await manager.load();
  const r = await manager.connectAll();
  if (r.connected.length > 0) {
    console.log("[dove] MCP 已连接 " + r.connected.length + " 个服务器：" + r.connected.join(", ")
      + "（" + manager.tools().length + " 个工具）");
  }
  for (const f of r.failed) console.warn("[dove] MCP 服务器 " + f.name + " 连接失败：" + f.error);

  return { port: makeMcpPort(manager), manager, toolNames: manager.tools().map((t) => t.name) };
}
