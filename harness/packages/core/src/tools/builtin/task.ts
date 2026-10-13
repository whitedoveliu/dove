/**
 * Task —— 派子代理独立完成一个任务（M6 / T6.1–T6.5）
 *
 * 为什么要有它：主代理的上下文是稀缺资源。
 * 子代理在自己的上下文里翻文件、试错、失败重来，**只把结论带回来** ——
 * 这是「上下文隔离」，不是「并行加速」（两者用法完全不同）。
 *
 * run_in_background = true 时立即返回 taskId，用 TaskOutput 查结果；
 * 完成后结果会**自动注回原线程**（TaskRegistry 的状态机保证只注一次）。
 *
 * ⚠️ 角色表（SUBAGENT_ROLES）为什么字面定义在这个文件里，而不是 `agents/roles.ts`：
 *    `tools → agents` 是**向上**依赖，lint-layering 会直接挡下（D7 硬约束②：依赖只能单向）。
 *    而「可用角色」一览**必须是生成式的** —— 手写列表会过期：ToolSearch 那句描述原来手写了
 *    四个例子、**漏了 Task（子代理）**，后果是用户让模型派子代理、模型压根不知道有这个能力。
 *    所以字面表放在 tools 层（Task 是唯一入口，它自己就要用它校验参数），
 *    `agents/roles.ts` 把这些名字原样再导出 —— 上层统一从 agents/roles.ts 取，全世界只有一份。
 */
import { defineTool } from "../types.ts";
import type { ToolServices } from "../types.ts";
import { guarded, str, optStr } from "./util.ts";

// ── 子代理角色（单一来源） ──────────────────────────────
export interface SubagentRole {
  id: string;
  /** 给模型看的一句话用途（会进 Task 工具描述的「可用角色」列表） */
  description: string;
  /** 工具白名单；["*"] = 不限（但仍受父会话的权限裁剪约束） */
  tools: string[];
  /** 是否给这个角色加 <git-context> 任务前缀 */
  gitContext?: boolean;
  /** 角色不允许再派子代理（防止无限套娃） */
  canDelegate?: boolean;
}

export const DEFAULT_SUBAGENT_ROLE_ID = "general";

/**
 * 铁律：角色只能**削减**能力，不能提升。
 *
 * 子代理的实际工具表 = 父线程策略结果 ∩ 角色白名单。父会话裁掉的东西（Home 线程的 Bash、
 * 只读模式下的 Write、没被 ToolSearch 激活的按需工具）这里怎么写都不会还回来 ——
 * 白名单里写了一个父没有的工具，结果就是「没有」，而不是「去要一个」。
 * 端口那一侧同理（见 agent/subagent-host.ts 的 #childDeps）。
 */
export const SUBAGENT_ROLES: SubagentRole[] = [
  {
    id: "general",
    description: "通用：能读能写，能跑脚本（RunScript/PTC）把多步工具调用合成一次执行",
    tools: [
      "Bash", "Glob", "Grep", "Read", "Write", "Edit",
      "WebSearch", "WebFetch", "Skill", "TodoWrite",
      // PTC 是 dove 自己宣传的最大效率来源（实测 5.5s vs 76 步/14 分钟），
      // 之前的子代理白名单刻意排除了它 —— 等于把效率最高的手段从子代理里拿掉了
      "RunScript",
    ],
  },
  {
    id: "coder",
    description: "实现向：写代码 + 跑构建/测试（含 RunScript），不联网、不派活",
    // 不含 Task/TaskOutput/ListAgents/SendMessage/InterruptAgent：canDelegate:false
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "RunScript", "TodoWrite"],
    canDelegate: false,
  },
  {
    id: "explore",
    description: "只读调查：翻文件、给结论给证据（文件:行号），不改动任何东西",
    // 只读：Write/Edit/Bash/RunScript 一个都不给（RunScript 能写文件、能起进程 = 本地代码执行）
    tools: ["Read", "Glob", "Grep", "Recall", "GetContextRemaining"],
    // 调查类子代理最容易走错方向：先给它一段 <git-context>（分支/最近提交/脏文件），
    // 它才知道「现在在哪、别人刚改了什么」
    gitContext: true,
    canDelegate: false,
  },
  {
    id: "plan",
    description: "出方案：只读调查 + 写待办清单，产出一份能直接执行的计划",
    tools: ["Read", "Glob", "Grep", "Recall", "GetContextRemaining", "TodoWrite"],
    canDelegate: false,
  },
];

export function getRole(id: string): SubagentRole | undefined {
  return SUBAGENT_ROLES.find((r) => r.id === id);
}

/** 角色一览（生成式：加/改角色时，Task 描述与错误文案跟着变） */
export function renderRoleListing(): string {
  return SUBAGENT_ROLES.map((r) => "- " + r.id + "：" + r.description).join("\n");
}

/**
 * 派活类工具。
 * canDelegate:false 的角色，这五个名字要**从工具表和端口两处一起**收掉 ——
 * 只收一处就会留下「表里没有但端口还在」（或反过来）的缺口，那是最难查的一类不一致。
 */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  "Task", "TaskOutput", "ListAgents", "SendMessage", "InterruptAgent",
]);

// ── 完整子代理入口（带 role/resume） ────────────────────
/** 一次派活的完整请求。比 ToolServices.spawnSubagent 多 role / resume 两个字段。 */
export interface SubagentSpawnRequest {
  prompt: string;
  label?: string;
  background?: boolean;
  /** 角色 id（见 SUBAGENT_ROLES）；缺省 general */
  role?: string;
  /** 续跑：要重挂的子代理 id（必须是本线程派出去的） */
  resume?: string;
}

export interface SubagentSpawnResult {
  status: "running" | "done";
  taskId?: string;
  output?: string;
  subagentId?: string;
  role?: string;
  /** true = 重挂了同一段子代理历史跑出来的结论（不是新起的） */
  resumed?: boolean;
  /** token 用量（父级记账用） */
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  note?: string;
}

export type SpawnRequestPort = (req: SubagentSpawnRequest) => Promise<SubagentSpawnResult>;

/**
 * 完整入口的挂载点。
 *
 * 为什么不写进 ToolServices 当正式字段：tools/types.ts 是**父代理在动的四个接线点**之一
 *（bootstrap 传参 → AgentServices 声明 → runtime 转发 → 落到 ToolServices），
 * 这里只加两个可选字段却要同时改四处，风险大于收益。
 * 而 spawnSubagent 的既有三参数签名**会把 role/resume 静默丢掉**（run-services 那一跳
 * 只解构了 prompt/label/background）——「静默丢掉角色」等于偷偷放宽权限，不能接受。
 *
 * 所以 SubagentHost 在构造时把自己的完整入口挂到**同一个 services 对象**上（同一引用），
 * Task 工具读这个挂载点；读不到又确实要用 role/resume 时**直接报错**，绝不静默退回。
 * 子代理侧由 #childDeps 按 canDelegate 显式清除它（否则子代理能绕过角色限制去派活）。
 */
export interface SubagentServices extends ToolServices {
  spawnSubagentRequest?: SpawnRequestPort;
}

export function installSpawnRequestPort(services: ToolServices, port: SpawnRequestPort): void {
  (services as SubagentServices).spawnSubagentRequest = port;
}

export function readSpawnRequestPort(services: ToolServices | undefined): SpawnRequestPort | undefined {
  return services ? (services as SubagentServices).spawnSubagentRequest : undefined;
}

// ── 工具本体 ────────────────────────────────────────────
export const TaskTool = defineTool({
  name: "Task",
  discoverable: "**派一个子代理**独立完成一件明确的活（可按角色派："
    + SUBAGENT_ROLES.map((r) => r.id).join("/") + "；过程不占你的上下文）",
  description: [
    "派一个子代理去独立完成一个明确的任务，它只把**结论**带回来。",
    "",
    "什么时候用：",
    "- 需要翻很多文件才能回答的问题（它翻，你不用翻）",
    "- 探索性的活：「找出这个项目里所有硬编码的颜色值」",
    "- 需要试错的任务：「试着让构建通过，告诉我你改了什么」",
    "- 耗时且你不想干等的活 → 加 run_in_background，然后继续做别的事",
    "",
    "什么时候别用：",
    "- 你已经知道要改哪个文件的简单改动 —— 直接改更快",
    "- 需要用户交互的任务（子代理不能和用户对话）",
    "",
    "写 prompt 的要点：子代理**看不到你和用户的对话**。",
    "必须把背景、目标、验收标准、涉及的文件路径都写全，否则它会瞎猜。",
    "",
    "可用角色（role 参数，缺省 " + DEFAULT_SUBAGENT_ROLE_ID + "）：",
    renderRoleListing(),
    "角色只能**削减**能力：父线程没有的工具，子代理也不会有（写类工具、按需工具同理）。",
    "",
    "续跑：resume 传一个本线程派过的子代理 id，它会在**同一段历史**上接着做 ——",
    "适合「上一轮的结论大体对，但还差一个点」的追问，比重新派一个省一大截上下文。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "给子代理的完整任务描述（背景 + 目标 + 验收标准 + 文件路径 + 边界）" },
      label: { type: "string", description: "3–5 个词的任务标签，会显示在界面上" },
      role: {
        type: "string",
        description: "子代理角色，缺省 " + DEFAULT_SUBAGENT_ROLE_ID + "。可选："
          + SUBAGENT_ROLES.map((r) => r.id).join(" / ") + "（见工具描述里的角色一览）",
      },
      resume: { type: "string", description: "要续跑的子代理 id（ListAgents 或上次 Task 返回的 subagentId）；给了它就在同一段历史上继续，不新起" },
      run_in_background: { type: "boolean", description: "为 true 时立即返回 taskId，用 TaskOutput 查进度；完成后结果自动回到本线程" },
      allowed_tools: {
        type: "array", items: { type: "string" },
        description: "进一步提示它该用哪些工具（可选；真正的裁剪由 role 决定）",
      },
    },
    required: ["prompt"],
  },
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const prompt = str(input, "prompt");
    const label = optStr(input, "label") ?? "子任务";
    const background = input.run_in_background === true;
    const allowed = Array.isArray(input.allowed_tools) ? (input.allowed_tools as string[]).map(String) : undefined;
    const roleId = (optStr(input, "role") ?? DEFAULT_SUBAGENT_ROLE_ID).trim() || DEFAULT_SUBAGENT_ROLE_ID;
    const resume = optStr(input, "resume")?.trim() || undefined;

    if (!ctx.services.spawnSubagent) {
      return {
        ok: false, error: "SUBAGENT_UNAVAILABLE",
        note: "子代理运行时没接上。你可以自己做这件事。"
          + "（如果你自己就是个子代理，说明嵌套派活被禁止了 —— 自己动手做。）",
      };
    }

    // 非法角色要**明确报错**并列出可用角色（列表是生成的，改角色表不会过期）。
    // 不能静默回落 general：调用方以为派了个只读的 explore，实际拿到一个有写权限的子代理。
    const role = getRole(roleId);
    if (!role) {
      return {
        ok: false, error: "未知角色 \"" + roleId + "\"",
        available_roles: SUBAGENT_ROLES.map((r) => r.id),
        note: "可用角色：\n" + renderRoleListing(),
      };
    }

    const port = readSpawnRequestPort(ctx.services);
    // role/resume 只能走完整入口。退回三参数端口会静默丢掉它们（= 偷偷按 general 跑、偷偷新起一个），
    // 所以缺这两个能力时**直接报错**，不做事后看起来"成功"的降级。
    if ((roleId !== DEFAULT_SUBAGENT_ROLE_ID || resume) && !port) {
      return {
        ok: false, error: "SUBAGENT_ROLE_UNAVAILABLE",
        note: "当前的子代理端口不支持 role/resume（只有 prompt/label/background）。"
          + "换用默认角色且不续跑，或者让上层把完整端口接上。",
      };
    }

    const fullPrompt = allowed ? prompt + "\n\n（可用工具限制为：" + allowed.join(", ") + "）" : prompt;
    const r: SubagentSpawnResult = port
      ? await port({ prompt: fullPrompt, label, background, role: roleId, resume })
      : await ctx.services.spawnSubagent({ prompt: fullPrompt, label, background });

    if (r.error) {
      return { ok: false, label, role: roleId, error: r.error, note: r.note ?? "这次派活没有成功发出。" };
    }
    if (r.status === "running") {
      return {
        ok: true, taskId: r.taskId, label, role: roleId, subagentId: r.subagentId, status: "running",
        note: "子代理已在后台开始工作。**不要在这里干等** —— 继续做别的事，或者告诉用户你在等。完成后它的结论会自动出现在这个对话里。用 TaskOutput 可以随时查进度。",
      };
    }
    return {
      ok: true, label, role: r.role ?? roleId, status: "done", output: r.output,
      subagentId: r.subagentId, resumed: r.resumed === true, usage: r.usage,
      note: "以上是子代理带回的结论。它的中间过程你看不到；如果结论不够，"
        + "可以用 resume=" + String(r.subagentId ?? "?") + " 在同一段历史上追问，或者再派一次并追问更具体的点。",
    };
  }),
});
