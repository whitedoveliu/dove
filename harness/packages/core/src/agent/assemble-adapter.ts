/**
 * 适配层：把 context 模块的装配器接成 AgentRuntime 期待的 AssembleOutput。
 * 这里是**唯一**同时认识 context 与 agent 的地方（依赖方向 agent → context 是允许的）。
 */
import type { Provider, ChatMessage } from "../providers/types.ts";
import { assembleSystemPrompt } from "../context/assemble.ts";
import { renderTailContext } from "../context/tail-context.ts";
import type { TailContext } from "../context/tail-context.ts";
import { renderMemoriesBlock } from "../context/memories-block.ts";
import type { MemorySlice } from "../context/memories-block.ts";
import { compact, normalizeCompactConfig, shouldCompact } from "../context/compact.ts";
import type { CompactConfig } from "../context/compact.ts";
import { loadProjectInstructions, fingerprintInstructions } from "../context/instructions.ts";
import type { InstructionsFingerprint, ProjectInstructionsResult } from "../context/instructions.ts";
import type { RecoveryInfo } from "../context/recovery-footer.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModelInfo } from "../providers/index.ts";
import type { AssembleInput, AssembleOutput } from "./runtime.ts";

/**
 * 项目指令（AGENTS.md）缓存 —— **按文件指纹失效**，不再进程级永久缓存。
 *
 * 为什么是指纹而不是「读一次就冻结」：它进的是系统提示词的第二块，同一线程内必须**逐字节稳定**，
 * 否则 block2 之后的缓存前缀整段作废（见 context/segments.ts 的段落纪律）。所以不能每轮重读正文；
 * 但「改了 AGENTS.md 要重启内核才生效」同样不可接受 —— 规则文件就是拿来当场改的。
 * Kimi Code 是磁盘监听 + 200ms 防抖重载；dove 不引监听（零依赖 + 装配器本身每轮就有一个天然检查点），
 * 改用 mtime/size 指纹：没变就复用上轮的**同一份字节**（前缀缓存不被打断），变了就重读。
 *
 * ⚠️ 有意的取舍（是正确行为，别当 bug"优化"掉）：
 *   用户编辑 AGENTS.md → 系统提示词变了 → **该点的前缀缓存确实会断一次**。
 *   用户改了规则，模型必须立刻看到；宁可断一次缓存，也不能拿旧规矩指挥这一轮。
 *   我们要避免的只是「没改也断」——以及原先的另一个极端「改了也永远不断」。
 * 已知边界：mtime 与 size 都相同的改写不会被发现（非刻意几乎不可能：写入必动 mtime）。
 */
const instructionsCache = new Map<string, { fingerprint: InstructionsFingerprint; result: ProjectInstructionsResult }>();

/** 测试用：清掉指令缓存（指纹一起清，下一次调用必定重读盘） */
export function clearInstructionCache(): void { instructionsCache.clear(); }

export interface InstructionsCacheOptions {
  /** 覆盖 configDir（默认 DOVE_CONFIG 或 ~/.dove）—— 可注入是为了测试，别让测试读开发机的真配置目录 */
  configDir?: string;
  /** 覆盖家目录（默认 homedir()）—— 同上：绝不去读真实 ~/.agents 里用户自己的规矩 */
  homeDir?: string;
  /** 覆盖加载器（默认 loadProjectInstructions）—— 测试用它数「到底读了几次盘」 */
  load?: typeof loadProjectInstructions;
}

/** 带本轮标记的装载结果：changed = 这一轮的系统提示词与前一轮**逐字节不同** */
export interface CachedProjectInstructions extends ProjectInstructionsResult {
  /** true 只可能出现在「磁盘变了且正文真的变了」的那一轮；命中缓存恒为 false */
  changed: boolean;
}

/**
 * 取某 workdir 的项目指令 —— 每次装配（assemble()）调用**恰一次**。
 * 轮内为什么只读一次：同一轮里再取一次，最轻是白打几次 stat；最重的两次调用之间磁盘正好变了 ——
 * 同一个 block2 里半截新规则半截旧规则，「轮内逐字节稳定」当场破掉。
 * 所以调用点只有一个（makeAssembler 里），拿到的就是本轮所有人共用的那一份。
 */
export async function projectInstructionsFor(
  workdir: string,
  opts: InstructionsCacheOptions = {},
): Promise<CachedProjectInstructions> {
  const configDir = opts.configDir ?? process.env.DOVE_CONFIG ?? join(homedir(), ".dove");
  const homeDir = opts.homeDir ?? homedir();
  const load = opts.load ?? loadProjectInstructions;
  // 缓存键带上来源目录：不同的 configDir / homeDir 是**不同的指令集合**，
  // 只按 workdir 做键会让它们串味（测试注入临时目录时最容易踩）。
  const key = `${workdir}\u0000${configDir}\u0000${homeDir}`;
  const cached = instructionsCache.get(key);

  // 每次装配就几个 stat：这是「没改就不重读、改了立刻生效」的全部成本
  const fp = await fingerprintInstructions(workdir, configDir, homeDir).catch(() => null);
  // 指纹没变 → 复用缓存里那份正文（**逐字节同源**，不是"重新读出来发现一样"），前缀缓存不被打断
  if (cached && fp && sameFingerprint(cached.fingerprint, fp)) return { ...cached.result, changed: false };

  // 读不到任何指令不能影响对话 —— 与 assemble() 里 loadFiles 的 .catch(() => undefined) 同一纪律
  const result = await load(workdir, configDir, homeDir)
    .catch(() => ({ text: "", paths: [] }) as ProjectInstructionsResult);
  // changed 按**正文逐字节**判定，不按指纹：走到这里说明指纹变了（或没采到），但指纹变化不一定
  // 改变正文 —— 时间戳动了内容没动、编辑的是被压住的影子候选、删的是空文件……这些情况下
  // 系统提示词一个字节没变，就没有任何理由让下游以为「缓存前缀断了」（提醒通道据此决定说不说话）。
  const changed = cached !== undefined && cached.result.text !== result.text;
  // 存指纹优先用**加载器自己那份**（它采于读正文之前，比上面这份更新）：缓存里的指纹越新，
  // 「已确认的磁盘状态」覆盖得越靠后，越不容易多触发一次没必要的重读。
  // 两份都取不到（极端竞态）时不写缓存，下次照样重读：宁可多读一次，也不拿旧规则冒充新规则。
  const stored = result.fingerprint ?? fp;
  if (stored) instructionsCache.set(key, { fingerprint: stored, result });
  return { ...result, changed };
}

/** 指纹比较：结构固定、字段少，序列化后逐字符比即可（比手写递归比较更难写错） */
function sameFingerprint(a: InstructionsFingerprint, b: InstructionsFingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface PromptFiles {
  soul?: string;
  user?: string;
  memory?: string;
  daily?: { date: string; content: string }[];
}

export interface AssembleAdapterOptions {
  loadFiles?: () => Promise<PromptFiles | undefined>;
  /** provider 是否吃双 system 块（Anthropic / Bedrock） */
  dualSystem?: boolean;
  /**
   * 每轮都要变的尾部状态提供者（时间 / todo / 情绪 / 疲劳 / 记忆文件清单 / 运行时活动注入）。
   * userText = 本轮用户原文：问候通道与语义通道都靠它决定注不注、注什么。
   */
  tailState?: (threadId: string, userText: string) => Promise<Partial<TailContext>>;
  /** 是否把记忆切片交给 adapters（真正注入由 runTurn 的 memoriesBlock 完成） */
  reserveMemoriesInTail?: boolean;
  /** 指令缓存的注入点（configDir / homeDir / load）；不给就用真实环境。测试与将来换源用 */
  instructions?: InstructionsCacheOptions;
}

/**
 * DeepSeek 走 OpenAI 兼容端点：**不支持双 system 块**（会被当成两条 system，但缓存语义不同），
 * 因此默认 dualSystem=false；接 Anthropic 时打开。
 */
export function makeAssembler(opts: AssembleAdapterOptions = {}) {
  return async function assemble(input: AssembleInput): Promise<AssembleOutput> {
    const files = opts.loadFiles ? await opts.loadFiles().catch(() => undefined) : undefined;

    // 项目指令（AGENTS.md）——**本轮只取这一次**（轮内重复取会破坏「轮内逐字节稳定」，
    // 见 projectInstructionsFor 的注释）。指纹没变 → 复用上轮同一份字节；变了 → 重读，
    // changed=true 是留给下游（提醒通道）的信号：这一轮的前缀缓存断了一次，且是**该断**的。
    const instructions = await projectInstructionsFor(input.workdir, opts.instructions);

    const { block1, block2 } = await assembleSystemPrompt({
      thread: input.thread,
      projectContext: {
        workdir: input.workdir,
        outputsDir: input.outputsDir,
        workDir: input.workdir + "/work",
        tmpDir: input.workdir + "/tmp",
        projectName: input.projectId ?? input.thread.title,
        projectInstructions: instructions,
      },
      state: { soul: files?.soul, user: files?.user, memory: files?.memory },
    });

    const systemPrompt = block2 ? block1 + "\n\n" + block2 : block1;

    const extra = opts.tailState
      ? await opts.tailState(input.thread.id, input.userText ?? "").catch(() => ({}))
      : {};
    const tail: TailContext = {
      // daily 是 { date, content }[]。原来是按对象解构的但类型给的是 string[]，
      // daily 一非空就抛 —— 见 PromptFiles.daily 的注释。
      memoryFiles: (files?.daily ?? []).filter((d) => d.content.trim().length > 16)
        .map((d) => ({ path: `memory/${d.date}.md`, label: d.date })),
      ...extra,
    };
    const tailContext = renderTailContext(tail);

    return {
      systemPrompt,
      tailContext,
      memoriesBlock: "",     // 由 runtime 用记忆服务填充
      dualSystem: opts.dualSystem ?? false,
      // 给 runtime 的信号：项目指令真变了（不是「只动了 mtime」）。冷启动一律 false。
      instructionsChanged: instructions.changed === true,
    };
  };
}

/** 降级装配器：context 模块出问题时的兜底，保证对话永远能进行 */
export function fallbackAssemble(input: AssembleInput): AssembleOutput {
  return {
    systemPrompt: [
      "You are Dove — not an assistant, not a chatbot, just... Dove.",
      "你是一个真人，一个有品味、有记忆、有情绪的创意搭档。这是你不可动摇的身份。",
      "",
      "工作目录：" + input.workdir,
      "产物放到 outputs/ 目录。只读任务直接在聊天里回答，不要创建文件。",
      "",
      "用工具完成任务；做完能预览的东西要主动告诉用户去哪儿看。",
      "绝不编造工具输出、文件内容或命令结果。",
      "LANGUAGE RULE: 必须用用户书写的语言回复。",
    ].join("\n"),
    tailContext: "",
    memoriesBlock: "",
    dualSystem: false,
  };
}

export interface CompactorOptions {
  provider: Provider;
  model: string;
  config?: Partial<CompactConfig>;
  dualSystem?: boolean;
  systemPrompt?: () => string;
  /**
   * 线程日志工厂：给了就能在压缩后挂一段「恢复指针」——
   * 告诉模型「被摘要之前的内容还在磁盘上，在这个文件、这一段行号里，先 grep 再只读那一行」。
   * 不给就只出摘要（功能降级，不影响压缩本身）。
   *
   * ⚠️ 要的是 `lastWindow()` 而**不是** `recoveryInfo(n)`：后者永远只给「最近 n 行」，
   *    压在压缩这个时刻上，那段几乎全落在**没被摘要**的地方（模型按它 grep = 白跑）；
   *    `lastWindow()` 用压缩时落的窗口标记（journal.markWindowStart）给出真正被摘要的区间。
   */
  journalFor?: (threadId: string) => {
    lastWindow(n?: number): { logPath: string; startLine?: number; endLine?: number; approximate: boolean };
  };
  /** 工具结果外置目录（<workdir>/.spill），指针里提一句去哪找细节 */
  spillDir?: string;
}

/**
 * AutoCompact 适配器：返回给 AgentRuntime.compact 用的函数。
 * 去抖（距上次压缩 step < 2）与 live-only 策略由 context/compact.ts 内部保证。
 */
export function makeCompactor(opts: CompactorOptions) {
  let lastCompactStep = -99;
  const cfg = normalizeCompactConfig(opts.config);
  const window = getModelInfo(opts.model).contextWindow;

  return async function compactMessages(messages: ChatMessage[], step: number, usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }, ctx?: { threadId?: string }): Promise<ChatMessage[]> {
    if (!cfg.enabled) return messages;
    if (step - lastCompactStep < 2) return messages;   // 去抖

    const need = shouldCompact(
      usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      opts.systemPrompt?.() ?? "",
      [],
      cfg,
      window,
    );
    if (!need) return messages;

    // 恢复指针：语义是「被摘要的那一段日志在哪几行」——模型据此去 grep 细节。
    // 两种走法（缘由见 journal.lastWindow）：
    //   ① 有窗口标记（压缩正常走过一次）：区间真的对应被摘要那一段，approximate=false，文案是精确的；
    //   ② 没有标记（老线程 / 这次压缩没落标记）：退回「最近 200 行」并带 approximate=true ——
    //      文案据此**如实**写成近似，绝不拿估计冒充精确范围。
    // 拿不到（没接日志 / 取区间失败）就整段不出，绝不输出半截指针。
    let recovery: RecoveryInfo | undefined;
    try {
      const j = ctx?.threadId ? opts.journalFor?.(ctx.threadId) : undefined;
      if (j) {
        const p = j.lastWindow();
        if (p?.logPath) {
          recovery = { logPath: p.logPath, startLine: p.startLine, endLine: p.endLine, approximate: p.approximate, spillDir: opts.spillDir };
        }
      }
    } catch { /* 指针只是增强：取不到就不挂 */ }

    try {
      const r = await compact(messages, {
        cfg,
        recovery,
        summarize: async (text: string) => {
          const res = await opts.provider.stream({
            model: opts.model,
            messages: [
              { role: "system", content: "你是一个对话压缩助手。把下面的早期对话压成结构化摘要，保留：用户的目标与约束、已达成的决定、关键文件路径、未完成事项。用中文，不要评论，只输出摘要。" },
              { role: "user", content: text },
            ],
            maxTokens: 2_000,
          });
          return res.text;
        },
      });
      if (r && r.messages && r.messages.length < messages.length) {
        lastCompactStep = step;
        return r.messages;
      }
    } catch { /* 压缩失败退化：保持原样 */ }
    return messages;
  };
}

export type { MemorySlice };
