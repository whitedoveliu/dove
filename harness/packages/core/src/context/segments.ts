/**
 * 提示词段落注册表（T2.1 / T2.2）
 * 纪律：① 顺序固定，新段只允许追加到尾部（中间插入 = 其后全部前缀缓存失效）；
 *       ② 非 static 段必须写 reason —— 不写理由的类型不过
 *          （照抄 CCB 的 DANGEROUS_uncachedSystemPromptSection(..., reason) 命名纪律）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { homedir } from "node:os";
import type { SegmentKind } from "../constants.ts";
import type { Thread } from "../session/types.ts";
import type { MemorySlice } from "./memories-block.ts";
import type { ProjectInstructionsResult } from "./instructions.ts";
import { resolveLocalTime, type LocalTime } from "./tail-context.ts";

export type { SegmentKind };

/** 提示词文件目录：packages/prompts/（相对本文件 ../../../prompts/） */
const PROMPTS_DIR = new URL("../../../prompts/", import.meta.url);
const promptCache = new Map<string, Promise<string>>();

/** 读取提示词段（带缓存；读失败不缓存，允许重试） */
export function loadPrompt(id: string): Promise<string> {
  const hit = promptCache.get(id);
  if (hit) return hit;
  const url = new URL(`${id}.md`, PROMPTS_DIR);
  const task = readFile(url, "utf8").catch((err: unknown) => {
    throw new Error(`提示词段加载失败：${id}.md（${url.pathname}）—— ${(err as Error).message}`);
  });
  promptCache.set(id, task);
  void task.catch(() => { if (promptCache.get(id) === task) promptCache.delete(id); });
  return task;
}

/** 测试用：清空提示词缓存（改文件后重新读取） */
export function clearPromptCache(): void {
  promptCache.clear();
}

/** 项目上下文（工作目录与产物约定） */
export interface ProjectContext {
  /** 项目根 = 工作目录 */
  workdir?: string;
  outputsDir?: string;
  workDir?: string;
  tmpDir?: string;
  projectName?: string;
  /** Dove 的持久化目录 */
  configDir?: string;
  /** 可用技能目录（名字 + 一句话）；M3 起由技能注册表提供 */
  skills?: { name: string; description: string }[];
  /**
   * 项目指令（AGENTS.md 家族）的加载结果 —— 由调用方**读盘后注入**，段渲染自己不碰磁盘。
   * 为什么要这样传：段渲染每轮都跑，而「要不要重读盘」是有状态的（缓存 + 指纹判定）——
   * 那件事归 agent/assemble-adapter.ts 一个人管，段渲染只负责把拿到的这份正文摆进段里。
   * 注入进来的这份**同一线程内天然稳定**：指纹没变，装配层复用的就是同一份字节。
   */
  projectInstructions?: ProjectInstructionsResult;
}

/** 装配期的可变状态（时间源与持久化文件内容） */
export interface ContextState {
  /** 时间源；测试可注入固定值 */
  now?: Date | number | string;
  timezone?: string;
  /** 持久化文件内容（M4 起由 memory/files.ts 提供） */
  soul?: string;
  user?: string;
  memory?: string;
}

/** 提示词占位符取值 */
export interface PromptVars {
  date: string;
  weekday: string;
  time: string;
  timezone: string;
  workdir: string;
  outputs_dir: string;
  work_dir: string;
  tmp_dir: string;
  project_name: string;
  /** Dove 的持久化目录（SOUL/USER/MEMORY/日记都在这） */
  config_dir: string;
  /** 项目指令正文（含来源锚点）；没有指令时为空串，s12 段据此整段消失 */
  project_instructions: string;
}

export interface SegmentContext {
  thread: Thread;
  project: Required<Pick<ProjectContext, "workdir" | "outputsDir" | "workDir" | "tmpDir" | "projectName">> & ProjectContext;
  state: ContextState;
  memories: MemorySlice[];
  time: LocalTime;
  vars: PromptVars;
}

export interface SegmentContextInput {
  thread: Thread;
  projectContext?: ProjectContext;
  state?: ContextState;
  memories?: MemorySlice[];
}

export interface SegmentDef {
  /** 段 id，同时是 packages/prompts/<id>.md 的文件名（如 s01-identity） */
  id: string;
  kind: SegmentKind;
  /** 动态段必须写理由，不写类型不过（纪律来自 CCB） */
  reason?: string;
  render(ctx: SegmentContext): string | Promise<string>;
}

/** 太短的持久化文件不注入（避免把空模板 / 占位标题塞进系统提示词） */
export const MIN_GLOBAL_CONFIG_CHARS = 20;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** 占位符替换；未知占位符原样保留（便于发现拼写错误） */
export function interpolate(text: string, vars: PromptVars): string {
  return text.replace(PLACEHOLDER, (whole: string, key: string) => {
    const value = (vars as unknown as Record<string, string>)[key];
    return typeof value === "string" ? value : whole;
  });
}

/** 由 thread + 项目上下文 + 状态构造渲染上下文 */
export function buildSegmentContext(input: SegmentContextInput): SegmentContext {
  const project = input.projectContext ?? {};
  const state = input.state ?? {};
  const workdir = project.workdir ?? cwd();
  const time = resolveLocalTime(state.now, state.timezone);
  const vars: PromptVars = {
    date: time.date,
    weekday: time.weekday,
    time: time.time,
    timezone: time.timezone,
    workdir,
    outputs_dir: project.outputsDir ?? join(workdir, "outputs"),
    work_dir: project.workDir ?? join(workdir, "work"),
    tmp_dir: project.tmpDir ?? join(workdir, "tmp"),
    project_name: project.projectName ?? input.thread.title ?? "",
    config_dir: project.configDir ?? process.env.DOVE_CONFIG ?? join(homedir(), ".dove"),
    project_instructions: project.projectInstructions?.text.trim() ?? "",
  };
  return {
    thread: input.thread,
    project: { ...project, workdir, outputsDir: vars.outputs_dir, workDir: vars.work_dir, tmpDir: vars.tmp_dir, projectName: vars.project_name },
    state,
    memories: input.memories ?? [],
    time,
    vars,
  };
}

/** SOUL.md / USER.md / MEMORY.md 正文追加（内容由记忆模块提供，太短不注入） */
function appendGlobalFiles(text: string, ctx: SegmentContext): string {
  const sections: string[] = [];
  const add = (title: string, body?: string): void => {
    if (body && body.trim().length >= MIN_GLOBAL_CONFIG_CHARS) sections.push(`## ${title}\n${body.trim()}`);
  };
  add("SOUL.md", ctx.state.soul);
  add("USER.md", ctx.state.user);
  add("MEMORY.md", ctx.state.memory);
  if (sections.length === 0) return text;
  return `${text.trimEnd()}\n\n${sections.join("\n\n")}`;
}

/**
 * 项目指令段（s12）的后处理。
 *
 * 为什么非得在这里兜一次空：正文是 `{{project_instructions}}` 占位符换进去的，没指令时换成空串，
 * 段落文件里那几句说明就会**独自留下** —— 一个只剩标题、正文空着的段等于告诉模型
 * 「这个项目立了规矩」却什么都没给，比不注入更糟（模型会去猜、去问、或者干脆自己编一套）。
 * 没有指令就整段返回空串，由 assemble.ts 的 `if (text.length > 0)` 把它剔掉。
 *
 * 超长告警也在这里附上：模型有权知道这次注入的规矩总量已经超出预算（我们没截断，它是完整的），
 * 冲突时该往「就近的那一份」去查 —— 顺带也让告警在聊天里能被看见，而不是只躺在日志里。
 */
function appendProjectInstructions(text: string, ctx: SegmentContext): string {
  const loaded = ctx.project.projectInstructions;
  if (!loaded || loaded.text.trim().length === 0) return "";
  const body = text.trimEnd();
  return loaded.warning ? `${body}\n\n> 注意：${loaded.warning}` : body;
}

function segment(
  id: string,
  kind: SegmentKind,
  reason?: string,
  transform?: (text: string, ctx: SegmentContext) => string,
): SegmentDef {
  return {
    id,
    kind,
    reason,
    async render(ctx: SegmentContext): Promise<string> {
      const raw = await loadPrompt(id);
      const text = interpolate(raw, ctx.vars);
      return transform ? transform(text, ctx) : text;
    },
  };
}

/**
 * 段落注册表（顺序固定，只在尾部追加）。
 * block1（冻结前缀）= 前导 static 段；切点落在第一个非 static 段之前，见 assemble.ts。
 */
export const SEGMENTS: SegmentDef[] = [
  segment("s01-identity", "static"),
  segment("s02-personality", "static"),
  segment("s03-tone", "static"),
  segment("s04-working-dir", "semi", "工作目录随项目线程切换；同一线程内冻结"),
  segment("s05-date-awareness", "semi", "日期锚每天变一次（天级失效）；绝不能逐轮变"),
  segment("s06-security", "static"),
  segment("s07-global-config", "semi", "SOUL/USER/MEMORY.md 随用户编辑变化，不是逐轮变", appendGlobalFiles),
  segment("s08-skills-first", "static"),
  segment("s09-execution", "static"),
  segment("s10-retrievable-context", "static"),
  segment("s11-artifacts", "static"),
  // ⚠️ 只许在这里（尾部）追加新段。插到中间 = 其后每一段的位置都变了 = 前缀缓存整段作废。
  // s12 的内容按 AGENTS.md 的指纹失效（没改逐字节复用，改了下一轮装配才换）——它本来就在切点之后，
  // 换内容只让 block2 这一段的缓存失效，冻结前缀（block1）不受影响。
  segment("s12-project-instructions", "semi", "项目指令随项目与 AGENTS.md 的编辑变化，不是逐轮变（指纹没变则逐字节复用，见 agent/assemble-adapter.ts）", appendProjectInstructions),
];

/** 纪律检查：非 static 段缺 reason 直接抛错（装配前调用） */
export function assertSegmentDiscipline(): void {
  for (const seg of SEGMENTS) {
    if (seg.kind === "static") continue;
    if (!seg.reason || seg.reason.trim().length === 0) {
      throw new Error(`提示词段 ${seg.id} 是 ${seg.kind} 段，必须写明 reason（缓存纪律：不写理由的类型不过）`);
    }
  }
}
