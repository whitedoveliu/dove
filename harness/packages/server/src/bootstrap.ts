/**
 * 服务容器：把 core 的各个模块接起来。
 * 这是唯一知道「全部模块」的地方（依赖方向的最外层）。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Db } from "../../core/src/session/db.ts";
import { Store } from "../../core/src/session/store.ts";
import { EventLog } from "../../core/src/session/event-log.ts";
import { PendingRegistry } from "../../core/src/agent/pending.ts";
import { SteeringQueue } from "../../core/src/loop/steering.ts";
import { AgentRuntime } from "../../core/src/agent/runtime.ts";
import type { AssembleInput, AssembleOutput, MemoryPort } from "../../core/src/agent/runtime.ts";
import { makeAssembler, fallbackAssemble, makeCompactor } from "../../core/src/agent/assemble-adapter.ts";
import { resolveEmbedder } from "./embedder.ts";
import { installRuntimeLog } from "../../core/src/session/runtime-log.ts";
import type { Config, Services } from "./bootstrap-types.ts";
import { getProvider } from "../../core/src/providers/index.ts";
import { makeClassifier } from "./classifier.ts";
import { allTools } from "../../core/src/tools/index.ts";
import type { Tool } from "../../core/src/tools/types.ts";
import { PreviewManager } from "../../core/src/projects/preview.ts";
import { ProjectManager } from "../../core/src/projects/manager.ts";
import { MemoryService } from "../../core/src/memory/index.ts";
import { TaskRegistry } from "../../core/src/agents/task-registry.ts";
import { EmotionService, FatigueService } from "../../core/src/emotion/index.ts";
import { CronScheduler, Heartbeat } from "../../core/src/scheduler/index.ts";
import { ActivityRecorder } from "../../core/src/activity/index.ts";
import { makeTailState } from "./tail-state.ts";
import { attachInputMonitor, detachInputMonitor } from "../../core/src/activity/focus.ts";
import { providerLlm } from "../../core/src/memory/index.ts";
import { MEMORY_SLEEP_DEFAULTS } from "../../core/src/constants.ts";
import { initMcp, type McpWiring } from "./mcp-wiring.ts";
import type { McpPort } from "./mcp-wiring.ts";

export type { Config, Services, EmotionPort, FatiguePort, CronPort, HeartbeatPort, ActivityPort } from "./bootstrap-types.ts";
function findEnvFile(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const f = join(dir, "env");
    if (existsSync(f)) return f;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readEnv(repoRoot: string): Record<string, string> {
  const envFile = findEnvFile(repoRoot);
  const env: Record<string, string> = {};
  if (!envFile) return env;
  for (const line of readFileSync(envFile!, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
}

export function loadConfig(): Config {
  // 注意：import.meta.dirname 是 <repo>/harness/packages/server/src，
  // 往上**四层**才是仓库根。少写一层会让默认库落到
  // harness/harness/.data/dove.db —— 实测踩过：从终端跑和从桌面 App 跑
  // 会因为 cwd 不同解析到不同路径，**同一个人的数据被劈成两个库**。
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const env = readEnv(repoRoot);
  const key = process.env.DOVE_API_KEY ?? env.ANTHROPIC_API_KEY ?? "";
  // 搜索 API（可选）。配了 WebSearch 就优先用它，没配退回抓 HTML。
  const tavilyApiKey = process.env.TAVILY_API_KEY ?? env.TAVILY_API_KEY ?? "";
  return {
    port: Number(process.env.DOVE_PORT ?? 8790),
    dbFile: process.env.DOVE_DB ?? join(repoRoot, "harness", ".data", "dove.db"),
    configDir: process.env.DOVE_CONFIG ?? join(homedir(), ".dove"),
    workspaceRoot: process.env.DOVE_WORKSPACE ?? join(homedir(), "DoveProjects"),
    templateDir: process.env.DOVE_TEMPLATE ?? (existsSync(join(repoRoot, "react-2.0-tpl")) ? join(repoRoot, "react-2.0-tpl") : undefined),
    providerBaseUrl: process.env.DOVE_BASE_URL ?? "https://api.deepseek.com/v1",
    apiKey: key,
    tavilyApiKey,
    model: process.env.DOVE_MODEL ?? "deepseek-flash",
    toolModel: process.env.DOVE_TOOL_MODEL ?? "deepseek-flash",
    approvalPolicy: (process.env.DOVE_APPROVE as Config["approvalPolicy"]) ?? "ask",
  };
}

/** 极简事件总线：cron / heartbeat 产生的事件通过它流向 SSE（避免 bootstrap 直接依赖 server 层） */
export type BusListener = (e: { type: string; [k: string]: unknown }) => void;

import type { Config, Services } from "./bootstrap-types.ts";

export async function bootstrap(cfg: Config): Promise<Services> {
  // 第一件事就装日志桥 —— 后面所有 console 输出（包括这条之后的诊断）
  // 才会同时进环形缓冲和磁盘。装晚了会漏掉启动阶段最关键的几条。
  installRuntimeLog(cfg.configDir);

  if (!cfg.apiKey) console.warn("[bootstrap] 未找到 API key，模型调用会失败");

  const db = new Db(cfg.dbFile);
  const store = new Store(db);
  const logsDir = join(cfg.configDir, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const eventLog = new EventLog({ dir: logsDir });
  const pending = new PendingRegistry();
  const steering = new SteeringQueue();
  const preview = new PreviewManager(3000);
  const projects = new ProjectManager({ store, workspaceRoot: cfg.workspaceRoot, templateDir: cfg.templateDir, preview });
  const provider = getProvider({ baseUrl: cfg.providerBaseUrl, apiKey: cfg.apiKey });

  // 工具
  const tools = new Map<string, Tool>();
  try {
    for (const t of allTools()) tools.set(t.name, t);
  } catch (e) {
    console.error("[bootstrap] 工具注册表加载失败：", e instanceof Error ? e.message : e);
  }

  // MCP host（T3.12）：外部工具**直接注册进工具表**（只追加尾部，保护前缀缓存）
  let mcpWiring: McpWiring | null = null;
  try {
    mcpWiring = await initMcp({ configDir: cfg.configDir, tools });
  } catch (e) {
    console.error("[bootstrap] MCP 初始化失败（降级为无外部工具）：", e instanceof Error ? e.message : e);
  }

  // 记忆
  // 向量后端：优先本地 ONNX（真语义），装不上就降级 hash（字面匹配）。
  // 降级不是失败 —— 没有模型时功能照常，只是召回质量差一档。
  const embedder = await resolveEmbedder();
  console.log(`[dove] 向量后端: ${embedder.id}${embedder.note ? "（" + embedder.note + "）" : ""}`);

  // 搜索后端：配了 Tavily 就用它（结果质量高一个量级），没配退回抓搜索引擎 HTML。
  //
  // ⚠️ 这行日志不是可有可无的。webSearchKey 要穿过 5 个地方才能到工具手上
  //    （bootstrap → AgentServices → runtime 转发 → wire 的 WireInput 类型 → wire 的 services），
  //    **漏掉任何一处都是静默失败**：不报错、不打日志，只是悄悄退回抓 Bing。
  //    实测为此查了三轮 —— 表现只是模型抱怨「Bing 把 VST 认成卓佳」。
  //    打出来之后，一眼就能看出 key 有没有到位。
  console.log(`[dove] 搜索后端: ${cfg.tavilyApiKey ? "tavily（已配 key）" : "抓取 Bing/DDG/百度（未配 TAVILY_API_KEY，质量较差）"}`);
  // 屏幕语义通道只在真向量上开：hash 降级是字面匹配，0.40 那个阈值是按 BGE 标定的尺度
  const screenEmbedder = embedder.note ? undefined : embedder.provider;

  let memory: MemoryService | null = null;
  try {
    memory = new MemoryService({
      db, configDir: cfg.configDir,
      embedder: embedder.provider,
      llm: providerLlm(provider, cfg.toolModel),
    });
    await memory.init();
    // ⚠️ 必须显式启动睡眠调度 —— 光 init() 不会启。
    //
    // 实测踩过：MemoryService 有 startScheduler()，shutdown 里也老老实实调了
    // stopScheduler()，**但启动侧一直没人调 startScheduler** ——
    // 于是「每天 03:00 归档记忆」这条流水线从来没跑过，
    // memory_sleep_runs 一直是 0 行，模型说「我的日记本还是空的」。
    //
    // 为什么测试没发现：smoke-memory 直接调 runSleep()（业务逻辑本身是好的），
    // **绕过了调度器** —— 测了引擎，没测点火。
    memory.startScheduler();
    console.log(`[dove] 记忆睡眠流水线: 已排程（每天 ${MEMORY_SLEEP_DEFAULTS.dailyTime}）`);
  } catch (e) {
    console.error("[bootstrap] 记忆服务初始化失败（降级为无记忆）：", e instanceof Error ? e.message : e);
    memory = null;
  }

  const memoryPort: MemoryPort | undefined = memory ? {
    retrieveForContext: (q, pid) => memory!.retrieveForContext(q, { scope: pid ? undefined : undefined }),
    remember: (c, k, s) => memory!.remember(c, k as never, s),
    captureDaily: (c) => memory!.captureDaily(c),
    captureDiary: (x) => memory!.captureDiary(x),
    summarizeTurn: async (_tid, _pid, text) => { await memory!.rememberFromConversation(text); },
  } : undefined;

  // 上下文装配
  const assembler = makeAssembler({
    loadFiles: memory ? () => memory!.loadFilesForPrompt() : undefined,
    dualSystem: false,
    tailState: makeTailState({
      configDir: cfg.configDir,
      emotion: (threadId) => emotions.renderBlock(threadId),
      fatigue: () => fatigue.renderBlock(),
      activity: () => activity,
      screenEmbedder: () => screenEmbedder,
    }),
  });

  const assemble = async (input: AssembleInput): Promise<AssembleOutput> => {
    try { return await assembler(input); }
    catch (e) {
      console.error("[bootstrap] 提示词装配失败，使用降级版：", e instanceof Error ? e.message : e);
      return fallbackAssemble(input);
    }
  };

  const compact = makeCompactor({ provider, model: cfg.toolModel });

  // 审批策略在装配层解决：不改 PendingRegistry 的语义，只决定"要不要真的问人"
  if (cfg.approvalPolicy === "auto") {
    const orig = pending.requestApproval.bind(pending);
    pending.requestApproval = (toolCallId, req, _timeout, hasWindow) => {
      if (!hasWindow) return Promise.resolve({ approved: false, reason: "no-window" as const, decision: "deny" as const });
      return Promise.resolve({ approved: true, decision: "allow" as const });
    };
    void orig;
  } else if (cfg.approvalPolicy === "deny") {
    pending.requestApproval = () => Promise.resolve({ approved: false, reason: "user" as const, decision: "deny" as const });
  }

  const tasks = new TaskRegistry(db);
  const busListeners: BusListener[] = [];
  const emit: BusListener = (e) => { for (const l of busListeners) { try { l(e); } catch { /* 单个订阅者出错不影响其他人 */ } } };

  // ── M6：情绪 / 疲劳 / 定时 / 心跳
  const emotions = new EmotionService({ configDir: cfg.configDir });
  const fatigue = new FatigueService({ configDir: cfg.configDir });

  /** 取一条 assistant 消息的纯文本（cron / heartbeat 的返回值） */
  const assistantText = (messageId: string, threadId: string): string => {
    const m = store.listMessages(threadId).find((x) => x.id === messageId);
    if (!m) return "";
    return m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("").trim();
  };

  const runtime = new AgentRuntime({
    provider, store, eventLog, pending, steering, tools, assemble, tasks,
    memory: memoryPort,
    compact,
    projectOps: (id) => projects.ops(id),
    // 屏幕记忆：Recall 的「我屏幕上看到过什么」那条通道。
    // ⚠️ activity 是在这个 runtime **之后**才创建的（它自己要用 runtime 派活），
    //    所以这里必须惰性取值 —— 直接写 activity?.xxx 会命中 TDZ。
    activity: { searchScreen: (q, o) => activity?.store.searchScreen(q, o) ?? [] },
    // 搜索 API 的 key（Tavily）。没配就退回抓搜索引擎 HTML —— 见 webSearchKey 的注释。
    webSearchKey: cfg.tavilyApiKey,
    // 审批分类器（auto 模式用）。⚠️ 这个值以前**根本没提供** —— 只在类型里声明过，
    // 于是 auto 模式表面说「每次调用前审一遍」、实际全部放行。实现见 classifier.ts。
    classifier: makeClassifier(provider),
  });

  // cron / heartbeat 需要 runtime，放在 runtime 之后建
  const cron = new CronScheduler({
    db, configDir: cfg.configDir,
    run: async (job) => {
      const homeId = store.getOrCreateHomeThread().id;
      const threadId = job.mode === "main"
        ? (job.deliverTo ?? homeId)
        : store.createThread({ id: `cron_${job.id}_${Date.now().toString(36)}`, kind: "project", title: `定时：${job.name}` }).id;
      emit({ type: "cron_start", jobId: job.id, name: job.name, threadId, mode: job.mode });
      const r = await runtime.run({ threadId, userText: job.prompt, model: job.model, sink: (e) => emit({ ...e, cron: job.id }) });
      const text = assistantText(r.assistantMessageId, threadId);
      emit({ type: "cron_done", jobId: job.id, name: job.name, threadId, text: text.slice(0, 400) });
      return text;
    },
  });

  const heartbeat = new Heartbeat({
    configDir: cfg.configDir,
    run: async (prompt) => {
      const homeId = store.getOrCreateHomeThread().id;
      const r = await runtime.run({ threadId: homeId, userText: prompt, sink: (e) => emit({ ...e, heartbeat: true }) });
      return assistantText(r.assistantMessageId, homeId);
    },
    // 只有「真的需要用户注意」的内容才会走到这里（HEARTBEAT_OK 已被 heartbeat 内部抑制）
    deliver: (text: string) => emit({ type: "heartbeat_report", text }),
  });

  // ── M7：感知层（活动记录器）
  // 没有屏幕录制权限时**不启动触发器**，但 analyze / report 仍然可用。
  let activity: ActivityRecorder | null = null;
  if (process.env.DOVE_ACTIVITY !== "off") {
    try {
      activity = new ActivityRecorder({
        db, configDir: cfg.configDir,
        // OCR 很贵，默认每 3 帧一次。DOVE_OCR_EVERY=1 可以每帧都 OCR
        // （调参/联调时用；生产别设 1，CPU 吃不消）
        ...(process.env.DOVE_OCR_EVERY ? { ocrEvery: Number(process.env.DOVE_OCR_EVERY) } : {}),
        llm: providerLlm(provider, cfg.toolModel),
        logger: (level, msg, data) => {
          if (level === "error" || level === "warn") console.log("[activity]", level, msg, data ?? "");
        },
        remember: memory ? (content: string, kind?: string) => memory!.remember(content, kind as never) : undefined,
      });
      const init = await activity.init();
      if (init.screenPermission) {
        activity.start();
        console.log("[dove] 屏幕感知已启动（有屏幕录制权限）");
      } else {
        console.warn("[dove] 屏幕感知未启动：" + (init.note ?? "没有屏幕录制权限"));
      }
      // T7.4 输入监听：给它 app 名/窗口标题，快照才有上下文。
      // 键盘事件需要「辅助功能」权限；没权限时仍能收 app 切换事件，所以这里不阻塞。
      try {
        const input = await attachInputMonitor(activity, {
          logger: (lv: string, m: string, d?: unknown) => { if (lv !== "info") console.log("[input]", lv, m, d ?? ""); },
        });
        // note 自己就是一句完整的话（"仅 app 切换事件：没有辅助功能权限…"），不要再套一层"已启动"，
        // 否则会打成「已启动（已启动（…））」。
        console.log("[dove] 输入监听：" + (input.ok ? (input.note ? input.note : "已启动") : "未启动 —— " + (input.error ?? "")));
      } catch (e) {
        console.warn("[dove] 输入监听启动失败（不影响感知）：", e instanceof Error ? e.message : e);
      }
      emit({ type: "activity_ready", screenPermission: init.screenPermission, note: init.note });
    } catch (e) {
      console.error("[bootstrap] 活动记录器初始化失败（降级为不感知）：", e instanceof Error ? e.message : e);
      activity = null;
    }
  }

  return {
    cfg, db, store, eventLog, pending, steering, runtime, tools, projects, preview, memory, tasks,
    mcp: mcpWiring?.port,
    onEvent: (l: BusListener) => { busListeners.push(l); },
    shutdown: () => {
      // 顺序很重要：先停生产者，再关存储
      try { mcpWiring?.manager.close(); } catch { /* ignore */ }
      try { detachInputMonitor(); } catch { /* ignore */ }
      try { activity?.stop(); } catch { /* ignore */ }
      try { cron.stop(); } catch { /* ignore */ }
      try { heartbeat.stop(); } catch { /* ignore */ }
      try { memory?.stopScheduler(); } catch { /* ignore */ }
      try { preview.stopAll(); } catch { /* ignore */ }
      try { eventLog.close(); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
    },
    emotion: {
      getState: (chatId?: string) => emotions.getState(chatId) as never,
      setBase: (v) => emotions.setBase(v as never),
      setContext: (v, chatId) => emotions.setContext(v as never, chatId),
      renderBlock: (chatId?: string) => emotions.renderBlock(chatId),
    },
    fatigue: {
      get: () => { const s = fatigue.snapshot(); return { level: s.fatigue, state: s.state, energy: s.energy }; },
      sleep: () => fatigue.sleep(),
      wake: () => fatigue.wake(),
      rest: (m: number) => fatigue.rest(m),
      renderBlock: () => fatigue.renderBlock(),
    },
    cron: {
      start: () => cron.start(), stop: () => cron.stop(),
      list: () => cron.list() as never,
      create: (job) => cron.create(job as never) as never,
      remove: (id) => cron.remove(id),
      enable: (id, on) => cron.enable(id, on),
      runNow: (id) => cron.runNow(id),
      history: (id, limit) => cron.history(id, limit) as never,
    },
    heartbeat: {
      start: () => heartbeat.start(), stop: () => heartbeat.stop(),
      tick: () => heartbeat.tick(),
    },
    activity: activity ? {
      init: async () => ({ ok: true, screenPermission: activity!.screenPermission }),
      start: () => activity!.start(),
      stop: () => activity!.stop(),
      captureNow: (reason?: string) => activity!.captureNow(reason),
      listSnapshots: (date?: string, limit?: number) => activity!.listSnapshots(date, limit) as never,
      dailyReport: (date: string) => activity!.dailyReport(date),
      weeklyReport: () => activity!.weeklyReport(),
      stats: () => activity!.stats() as never,
    } : undefined,
  };
}
