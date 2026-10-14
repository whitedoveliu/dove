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
import { openJournal } from "../../core/src/session/journal.ts";
import { createHookRegistry } from "../../core/src/loop/hooks.ts";
import { registerSecretPathGuard } from "../../core/src/agent/hook-presets.ts";
import { planAging } from "../../core/src/tools/result-aging.ts";
import { PendingRegistry } from "../../core/src/agent/pending.ts";
import { SteeringQueue } from "../../core/src/loop/steering.ts";
import { AgentRuntime } from "../../core/src/agent/runtime.ts";
import type { AssembleInput, AssembleOutput, MemoryPort } from "../../core/src/agent/runtime.ts";
import { makeAssembler, fallbackAssemble, makeCompactor } from "../../core/src/agent/assemble-adapter.ts";
import { resolveEmbedder } from "./embedder.ts";
import { installRuntimeLog } from "../../core/src/session/runtime-log.ts";
import type { Config, Services } from "./bootstrap-types.ts";
import { makeClassifier } from "./classifier.ts";
import { GoalStore } from "../../core/src/agents/goal-store.ts";
import { makeExitPlanMode } from "./plan-mode-wiring.ts";
import { allTools } from "../../core/src/tools/index.ts";
import type { Tool } from "../../core/src/tools/types.ts";
import { cronThreadMetadata } from "./cron-permission.ts";
import { PreviewManager } from "../../core/src/projects/preview.ts";
import { ProjectManager } from "../../core/src/projects/manager.ts";
import { MemoryService } from "../../core/src/memory/index.ts";
import { TaskRegistry } from "../../core/src/agents/task-registry.ts";
import { EmotionService, FatigueService } from "../../core/src/emotion/index.ts";
import { CronScheduler, Heartbeat, makeCronOps } from "../../core/src/scheduler/index.ts";
import { makeTailState } from "./tail-state.ts";
import { providerLlm } from "../../core/src/memory/index.ts";
import { MEMORY_SLEEP_DEFAULTS } from "../../core/src/constants.ts";
import { initMcp, type McpWiring } from "./mcp-wiring.ts";
import type { McpPort } from "./mcp-wiring.ts";
import { publishDiscovery } from "./discovery.ts";
import { LiveModelProvider, ModelSettingsStore } from "./model-settings.ts";

export type { Config, Services, EmotionPort, FatiguePort, CronPort, HeartbeatPort } from "./bootstrap-types.ts";
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
    // 模板目录可选：仓库不再内置模板，只有显式设了 DOVE_TEMPLATE 时才往新项目里拷
    templateDir: process.env.DOVE_TEMPLATE,
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

  // 模型设置（面板设置对话框的落点）：env > 存盘 > 默认 —— env 给过的字段是**托管层**，
  // 运行期以 env 为准，且永不落盘（见 model-settings.ts 的 #write）。
  // ⚠️ 必须在**建 provider 之前**读 —— provider 吃的就是它。cfg 只是「报告面」
  //    （/api/health · /api/config · discovery 读的是 cfg），这里把它同步成**生效值**，
  //    面板一改设置就跟着变，不用等重启。
  const modelSettings = new ModelSettingsStore({
    configDir: cfg.configDir,
    fallback: { baseUrl: cfg.providerBaseUrl, model: cfg.model, apiKey: cfg.apiKey },
  });
  const syncCfgFromSettings = (): void => {
    cfg.providerBaseUrl = modelSettings.baseUrl;
    cfg.model = modelSettings.model;
    cfg.apiKey = modelSettings.apiKey;
  };
  modelSettings.onChange(syncCfgFromSettings);
  syncCfgFromSettings();
  if (modelSettings.filePath && existsSync(modelSettings.filePath)) {
    console.log(`[dove] 模型设置: ${modelSettings.filePath}（文件里存的是面板改过的值；env 给过的字段以 env 为准）`);
  }

  if (!cfg.apiKey) console.warn("[bootstrap] 未找到 API key，模型调用会失败");

  const db = new Db(cfg.dbFile);
  /**
   * 依赖注入而不是让 session 层 import 上层：
   * - `planAging` 住在 tools 层（上层），session 直接 import 会被 lint-layering 拦（连动态 import 都查）；
   * - 日志实例由 configDir + threadId 现开，所以传工厂而不是实例。
   * 缺任何一个都只是功能降级（不做老化 / 不写线程日志），不会让服务起不来。
   */
  const store = new Store(db, {
    planAging,
    journalFor: (threadId) => openJournal(cfg.configDir, threadId),
  });
  const logsDir = join(cfg.configDir, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const eventLog = new EventLog({ dir: logsDir });
  const pending = new PendingRegistry();
  const steering = new SteeringQueue();
  const preview = new PreviewManager(3000);
  const projects = new ProjectManager({ store, workspaceRoot: cfg.workspaceRoot, templateDir: cfg.templateDir, preview });
  const provider = new LiveModelProvider(modelSettings);

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
    // ⚠️ 原写法是 `{ scope: pid ? undefined : undefined }` —— 两个分支恒等，
    //    于是**永远**把 scope 覆盖成 undefined：pid 被彻底忽略，
    //    而且连服务自己的 `#scopeList()`（项目作用域时是 [scope, "global"]）也被这个 undefined 覆盖掉
    //    （retrieveForContext 里是 `{ scope: ..., ...opts }`，opts 在后）。
    //    现在：有 pid 就收窄到「该项目 + global」；没有就交给服务默认范围，不要传 scope。
    retrieveForContext: (q, pid) =>
      pid ? memory!.retrieveForContext(q, { scope: [pid, "global"] }) : memory!.retrieveForContext(q),
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
    }),
  });

  const assemble = async (input: AssembleInput): Promise<AssembleOutput> => {
    try { return await assembler(input); }
    catch (e) {
      console.error("[bootstrap] 提示词装配失败，使用降级版：", e instanceof Error ? e.message : e);
      return fallbackAssemble(input);
    }
  };

  // 压缩：把「恢复指针」也接上 —— 没有它，模型被摘要之后就不知道细节还在磁盘上
  const compact = makeCompactor({
    provider, model: cfg.toolModel,
    journalFor: (threadId) => openJournal(cfg.configDir, threadId),
    spillDir: join(cfg.workspaceRoot, ".spill"),
  });

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

  /**
   * 循环 hook 注册表：**一处构造、跨轮存活**（每轮新建等于白注册）。
   *
   * 这是「让新特性注册、而不是改循环」的挂载点：任何监听者可以 veto / allow / pass /
   * waitUntil（延后到同步监听者跑完 —— 审批弹窗正是靠这个才不阻塞别的注册者），
   * 事件见 loop/hooks.ts 的 HookEvent。
   *
   * ⚠️ 目前**一个内置监听者都没有**，这是刻意的：现成的横切逻辑（工具去重、断路器、
   *    压缩、提醒注入）都已经在各自的正确位置实现了，硬塞进 hook 只是换个地方重复一遍。
   *    这个字段的价值在于「下一条横切需求不用再改 loop/turn.ts」。
   */
  const hooks = createHookRegistry();
  // 注册**真的在干活**的那条：秘密路径的全域兜底（覆盖 MCP / 用户工具 / 将来忘了接护栏的新工具）。
  // 这里必须显式调用 —— 注册表不会自己长出监听者，「建好没接」是本仓库栽过多次的坑。
  registerSecretPathGuard(hooks);

  const runtime = new AgentRuntime({
    provider, store, eventLog, pending, steering, tools, assemble, tasks,
    hooks,
    memory: memoryPort,
    compact,
    // 每线程的可重放日志（恢复指针的第二份来源）。runtime 里与 eventLog **双写**，
    // 缺这一处只是没有线程日志（恢复指针退化），不会让对话失败 —— 见 agent/run-log.ts。
    journalFor: (threadId) => openJournal(cfg.configDir, threadId),
    projectOps: (id) => projects.ops(id),
    // MCP 资源能力（ListMcpResources / ReadMcpResource）。
    // ⚠️ 这个值要穿过四处：bootstrap（这里）→ AgentServices 声明 → wire.ts 的转发 → ToolServices.mcp。
    //    漏了 wire.ts 那一处 = 工具永远返回「MCP 未接入」，而且不报错。
    mcp: mcpWiring?.resources,
    // 搜索 API 的 key（Tavily）。没配就退回抓搜索引擎 HTML —— 见 webSearchKey 的注释。
    webSearchKey: cfg.tavilyApiKey,
    // 审批分类器（auto 模式用）。⚠️ 这个值以前**根本没提供** —— 只在类型里声明过，
    // 于是 auto 模式表面说「每次调用前审一遍」、实际全部放行。实现见 classifier.ts。
    classifier: makeClassifier(provider),
    // 长期目标：模型侧三个工具与面板的 /api/projects/{key}/goal **共用这一张表**，
    // 所以人在面板上改了目标，模型手里的旧 revision 会被拒（GOAL_STALE_REVISION）。
    goals: new GoalStore(db),
    // 计划模式：批准之后把线程从计划模式里放出来（改 metadata）。
    // 实现放 server 层是因为核心层不能 import server —— 见 plan-mode-wiring.ts。
    exitPlanMode: makeExitPlanMode({ store, sink: (e) => emit(e) }),
  });

  // cron / heartbeat 需要 runtime，放在 runtime 之后建
  const cron = new CronScheduler({
    db, configDir: cfg.configDir,
    run: async (job) => {
      const homeId = store.getOrCreateHomeThread().id;
      const threadId = job.mode === "main"
        ? (job.deliverTo ?? homeId)
        : store.createThread({
            id: `cron_${job.id}_${Date.now().toString(36)}`, kind: "project", title: `定时：${job.name}`,
            // 档位**显式**落到新线程上（见 cron-permission.ts：不显式就等于静默用默认档，最难查）
            metadata: cronThreadMetadata(store, job),
          }).id;
      emit({ type: "cron_start", jobId: job.id, name: job.name, threadId, mode: job.mode });
      const r = await runtime.run({ threadId, userText: job.prompt, model: job.model, sink: (e) => emit({ ...e, cron: job.id }) });
      const text = assistantText(r.assistantMessageId, threadId);
      emit({ type: "cron_done", jobId: job.id, name: job.name, threadId, text: text.slice(0, 400) });
      return text;
    },
  });

  // cron 工具（CronCreate / CronList / CronDelete）走端口注入。
  // ⚠️ cron 是在 runtime **之后**建的（它自己要用 runtime.run），所以是**事后补注入**：
  //    buildExecDeps 每轮才读 runtime.services.cron，来得及。
  //    接线仍是四处：bootstrap（这里）→ AgentServices 声明 → wire.ts 转发 → ToolServices.cron。
  runtime.services.cron = makeCronOps(cron);

  const heartbeat = new Heartbeat({
    configDir: cfg.configDir,
    run: async (prompt) => {
      const homeId = store.getOrCreateHomeThread().id;
      const r = await runtime.run({
        threadId: homeId, userText: prompt,
        sink: (e) => emit({ ...e, heartbeat: true }),
        heartbeat: true,   // 心跳不需要"完成任务"这道守卫（见 RunOptions.heartbeat）
      });
      // 空产出的心跳 = 无事发生。runtime 会为「没有任何可见产出」的回合补一条说明
      // （问题 ④），但那是给**用户回合**看的；心跳把它当汇报发出去就是纯噪音。
      if (r.silent) return "";
      return assistantText(r.assistantMessageId, homeId);
    },
    // 只有「真的需要用户注意」的内容才会走到这里（HEARTBEAT_OK 已被 heartbeat 内部抑制）
    deliver: (text: string) => emit({ type: "heartbeat_report", text }),
  });

  // 对外发现信息（~/.dove/port + api-spec.md）：内核是常驻服务，CLI / 外部 agent
  // 得先知道去哪儿说话。只写这两个文件，绝不碰用户数据；写失败也不影响内核干活。
  publishDiscovery(cfg, tools.size);

  return {
    cfg, db, store, eventLog, pending, steering, runtime, tools, projects, preview, memory, tasks,
    modelSettings,
    mcp: mcpWiring?.port,
    onEvent: (l: BusListener) => { busListeners.push(l); },
    shutdown: () => {
      // 顺序很重要：先停生产者，再关存储
      try { mcpWiring?.manager.close(); } catch { /* ignore */ }
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
  };
}
