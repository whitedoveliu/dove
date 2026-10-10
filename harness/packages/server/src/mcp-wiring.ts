/**
 * MCP host 接线（T3.12）
 *
 * 职责：把 McpManager 接到 ① 工具注册表（registry.ts）② 运行时工具表（bootstrap 的 Map）。
 * 单独成文件是为了让 bootstrap.ts 保持精简（单文件 ≤ 400 行硬约束）。
 *
 * 顺序纪律：外部工具**只追加在尾部**；断开时只摘掉 mcp__ 前缀的，内置工具顺序一动不动。
 */
import { McpManager, RpcError, RPC_METHOD_NOT_FOUND } from "../../core/src/mcp/index.ts";
import type { McpClient, McpConnectResult, McpListEntry, McpReloadResult } from "../../core/src/mcp/index.ts";
import { MCP_TOOL_PREFIX } from "../../core/src/mcp/tools-bridge.ts";
import { externalTools, registerExternalTools } from "../../core/src/tools/registry.ts";
import { errMsg } from "../../core/src/tools/builtin/util.ts";
import type { McpResourceListing, McpResourcePort, McpResourceReadResult, Tool } from "../../core/src/tools/types.ts";

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
  /** 资源能力（ListMcpResources / ReadMcpResource）：真实客户端就在这里 */
  resources: McpResourcePort;
}

/** 服务端没实现某能力（JSON-RPC -32601）时说人话，而不是把码丢给模型 */
function capabilityError(method: string, e: unknown): string {
  if (e instanceof RpcError && e.code === RPC_METHOD_NOT_FOUND) {
    return "该服务器没有实现 " + method + "（JSON-RPC -32601 Method not found）";
  }
  return errMsg(e);
}

/**
 * McpManager → 资源端口（ListMcpResources / ReadMcpResource 用）。
 * 纪律：一个服务器失败不影响其他；方法未实现不算异常，返回可读说明。
 */
export function makeMcpResourcePort(manager: McpManager): McpResourcePort {
  const pick = (server?: string): { name: string; client: McpClient }[] =>
    manager.connectedClients().filter((c) => !server || c.name === server);

  return {
    servers: () => manager.listServers().map((s) => ({
      name: s.name, connected: s.connected, enabled: s.enabled, error: s.error,
    })),

    list: async (server?: string): Promise<McpResourceListing[]> => {
      const out: McpResourceListing[] = [];
      for (const { name, client } of pick(server)) {
        const row: McpResourceListing = { server: name, ok: true };
        try {
          row.resources = (await client.listResources()).map((r) => ({
            uri: String(r.uri),
            name: typeof r.name === "string" ? r.name : undefined,
            mimeType: typeof r.mimeType === "string" ? r.mimeType : undefined,
            description: typeof r.description === "string" ? r.description : undefined,
          }));
        } catch (e) {
          row.ok = false;
          row.error = capabilityError("resources/list", e);
        }
        try {
          row.templates = (await client.listResourceTemplates()).map((t) => ({
            uriTemplate: String(t.uriTemplate),
            name: typeof t.name === "string" ? t.name : undefined,
            mimeType: typeof t.mimeType === "string" ? t.mimeType : undefined,
            description: typeof t.description === "string" ? t.description : undefined,
          }));
        } catch (e) {
          // 模板不可用不算整个服务器失败（resources/list 可能还好好的）
          row.note = capabilityError("resources/templates/list", e);
        }
        out.push(row);
      }
      return out;
    },

    read: async (uri: string, server?: string): Promise<McpResourceReadResult[]> => {
      const out: McpResourceReadResult[] = [];
      for (const { name, client } of pick(server)) {
        try {
          const res = await client.readResource(uri);
          out.push({
            server: name,
            ok: true,
            contents: (res.contents ?? []).map((c) => {
              if (typeof c.text === "string") return { uri: c.uri, mimeType: c.mimeType, text: c.text };
              if (typeof c.blob === "string") {
                return {
                  uri: c.uri, mimeType: c.mimeType,
                  blobBytes: Math.floor((c.blob.length * 3) / 4),
                  note: "二进制内容（base64 blob）—— 本 host 不转存，只报了字节数",
                };
              }
              return { uri: c.uri, mimeType: c.mimeType, note: "既没有 text 也没有 blob" };
            }),
          });
        } catch (e) {
          out.push({ server: name, ok: false, error: capabilityError("resources/read", e) });
        }
      }
      return out;
    },
  };
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

  return {
    port: makeMcpPort(manager),
    manager,
    toolNames: manager.tools().map((t) => t.name),
    resources: makeMcpResourcePort(manager),
  };
}
