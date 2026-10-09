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
import { getModelInfo } from "../providers/index.ts";
import type { AssembleInput, AssembleOutput } from "./runtime.ts";

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
}

/**
 * DeepSeek 走 OpenAI 兼容端点：**不支持双 system 块**（会被当成两条 system，但缓存语义不同），
 * 因此默认 dualSystem=false；接 Anthropic 时打开。
 */
export function makeAssembler(opts: AssembleAdapterOptions = {}) {
  return async function assemble(input: AssembleInput): Promise<AssembleOutput> {
    const files = opts.loadFiles ? await opts.loadFiles().catch(() => undefined) : undefined;

    const { block1, block2 } = await assembleSystemPrompt({
      thread: input.thread,
      projectContext: {
        workdir: input.workdir,
        outputsDir: input.outputsDir,
        workDir: input.workdir + "/work",
        tmpDir: input.workdir + "/tmp",
        projectName: input.projectId ?? input.thread.title,
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
}

/**
 * AutoCompact 适配器：返回给 AgentRuntime.compact 用的函数。
 * 去抖（距上次压缩 step < 2）与 live-only 策略由 context/compact.ts 内部保证。
 */
export function makeCompactor(opts: CompactorOptions) {
  let lastCompactStep = -99;
  const cfg = normalizeCompactConfig(opts.config);
  const window = getModelInfo(opts.model).contextWindow;

  return async function compactMessages(messages: ChatMessage[], step: number, usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }): Promise<ChatMessage[]> {
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

    try {
      const r = await compact(messages, {
        cfg,
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
