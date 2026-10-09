/**
 * bootstrap 的类型定义（从 bootstrap.ts 拆出来，那个文件顶到 400 行了）
 */
import type { Db } from "../../core/src/session/db.ts";
import type { Store } from "../../core/src/session/store.ts";
import type { EventLog } from "../../core/src/session/event-log.ts";
import type { PendingRegistry } from "../../core/src/agent/pending.ts";
import type { SteeringQueue } from "../../core/src/loop/steering.ts";
import type { AgentRuntime } from "../../core/src/agent/runtime.ts";
import type { Tool } from "../../core/src/tools/types.ts";
import type { ProjectManager } from "../../core/src/projects/manager.ts";
import type { MemoryService } from "../../core/src/memory/index.ts";
import type { TaskRegistry } from "../../core/src/agents/task-registry.ts";
import type { EmotionService, FatigueService } from "../../core/src/emotion/index.ts";
import type { CronScheduler } from "../../core/src/scheduler/index.ts";
import type { SchedulerHeartbeat } from "../../core/src/scheduler/index.ts";
import type { ActivityRecorder } from "../../core/src/activity/index.ts";
import type { McpPort } from "./mcp-wiring.ts";

export interface Config {
  port: number;
  dbFile: string;
  configDir: string;
  workspaceRoot: string;
  templateDir?: string;
  providerBaseUrl: string;
  apiKey: string;
  /** Tavily 搜索 API 的 key（可选）。配了 WebSearch 优先用它，没配退回抓 HTML */
  tavilyApiKey?: string;
  model: string;
  toolModel: string;
  /** 审批策略：ask = 弹窗询问；auto = 自动放行（CLI / 无人值守）；deny = 一律拒绝 */
  approvalPolicy: "ask" | "auto" | "deny";
}

/** 从当前目录向上找 env 文件（harness 可能被嵌在仓库子目录里） */

export interface Services {
  cfg: Config;
  /** 订阅内核侧事件（cron 结果、心跳报告） */
  onEvent(l: BusListener): void;
  /**
   * 优雅关闭：**必须先停后台服务再关 DB**。
   * 否则采集循环 / 调度器会在 DB 关掉之后继续写，报 "database is not open"。
   */
  shutdown(): void;
  db: Db;
  store: Store;
  eventLog: EventLog;
  pending: PendingRegistry;
  steering: SteeringQueue;
  runtime: AgentRuntime;
  tools: Map<string, Tool>;
  projects: ProjectManager;
  preview: PreviewManager;
  memory: MemoryService | null;
  tasks: TaskRegistry;
  /** M6/M7 的服务由子模块注入；未接入时为 undefined，路由要能优雅降级 */
  emotion?: EmotionPort;
  fatigue?: FatiguePort;
  cron?: CronPort;
  heartbeat?: HeartbeatPort;
  activity?: ActivityPort;
  /** MCP host（T3.12）：外部工具已注册进 tools；未接入时为 undefined */
  mcp?: McpPort;
}

export interface EmotionPort {
  getState(chatId?: string): { fused: { label: string; valence: number } };
  setBase(v: { label?: string; valence?: number }): void;
  setContext(v: { label?: string; valence?: number }, chatId?: string): void;
  renderBlock(chatId?: string): string;
}
export interface FatiguePort {
  get(): { level: number; state: string };
  sleep(): void; wake(): void; rest(minutes: number): void;
  renderBlock(): string;
}
export interface CronPort {
  start(): void; stop(): void;
  list(): unknown[]; create(job: Record<string, unknown>): unknown;
  remove(id: string): boolean; enable(id: string, on: boolean): boolean;
  runNow(id: string): Promise<{ ok: boolean; result?: string; error?: string }>;
  history(id?: string, limit?: number): unknown[];
}
export interface HeartbeatPort {
  start(): void; stop(): void;
  tick(): Promise<{ ran: boolean; suppressed?: boolean; output?: string; reason?: string }>;
}
export interface ActivityPort {
  init(): Promise<{ ok: boolean; screenPermission: boolean; note?: string }>;
  start(): void; stop(): void;
  captureNow(reason?: string): Promise<{ snapshotId?: string; skipped?: string }>;
  listSnapshots(date?: string, limit?: number): unknown[];
  dailyReport(date: string): Promise<string>;
  weeklyReport(): Promise<string>;
