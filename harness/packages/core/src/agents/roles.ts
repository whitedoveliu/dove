/**
 * 子代理角色：上层（agents / agent / 面板 / 测试）的统一入口。
 *
 * ⚠️ 为什么字面表在 `tools/builtin/task.ts` 里、这里只是再导出：
 *    D7 硬约束②要求依赖单向（… → tools → … → loop → agents → agent），
 *    也就是 **tools 不能 import agents**。而 Task 工具（tools 层）必须
 *    ① 在自己的描述里列出可用角色；② 对非法 role 报错时列出可用角色 —— 两处都要求**生成式**
 *    （手写列表过期过一次：ToolSearch 的描述漏了子代理，模型压根不知道能派活）。
 *    所以表的字面定义落在 tools 层，这个文件是它在上层的**唯一门面**：上层只 import 这里，
 *    永远不要越过它去 import tools/builtin/task.ts（那样以后挪位置会漏改）。
 *
 * 铁律（写在表旁边再写一遍）：**角色只能削减能力，不能提升** ——
 * 实际工具表 = 父线程策略结果 ∩ 角色白名单；端口那一侧也只按同一判据收窄。
 */
import type { Tool } from "../tools/types.ts";
import type { SubagentRole } from "../tools/builtin/task.ts";
import { DELEGATION_TOOLS, SUBAGENT_ROLES, DEFAULT_SUBAGENT_ROLE_ID, getRole } from "../tools/builtin/task.ts";

export type {
  SubagentRole, SubagentSpawnRequest, SubagentSpawnResult, SpawnRequestPort, SubagentServices,
} from "../tools/builtin/task.ts";
export {
  SUBAGENT_ROLES, DEFAULT_SUBAGENT_ROLE_ID, DELEGATION_TOOLS,
  getRole, renderRoleListing, installSpawnRequestPort, readSpawnRequestPort,
} from "../tools/builtin/task.ts";

/** 缺省角色（表被改坏时的兜底也不能崩：拿不到就返回 undefined，由调用方决定怎么办） */
export function defaultRole(): SubagentRole | undefined {
  return getRole(DEFAULT_SUBAGENT_ROLE_ID) ?? SUBAGENT_ROLES[0];
}

export interface RoleToolPolicy {
  tools: Map<string, Tool>;
  /** 父有、但角色不许的名字（告知模型用） */
  blocked: string[];
  /** 白名单是 "*"：不按名单收，只按 canDelegate 收 */
  wildcard: boolean;
}

/**
 * 按角色收窄父线程的工具表。
 *
 * 两个容易写错的地方：
 *  ① 交集方向：**在父表上做减法**，不是拿角色名单当全集 —— 父没有的工具绝不会被加回来。
 *  ② canDelegate:false 必须在这里也收一次：出厂角色的白名单里本来就没有派活工具，
 *     但白名单是**可配置的**（以后加角色/面板里改），漏了这一步就会出现
 *     「表里写着 coder 不派活、工具表里却有 Task」。
 */
export function applyRolePolicy(parentTools: Map<string, Tool>, role: SubagentRole): RoleToolPolicy {
  const wildcard = role.tools.includes("*");
  const allow = new Set(role.tools);
  const tools = new Map<string, Tool>();
  const blocked: string[] = [];
  for (const [name, tool] of parentTools) {
    if (!wildcard && !allow.has(name)) { blocked.push(name); continue; }
    if (role.canDelegate === false && DELEGATION_TOOLS.has(name)) { blocked.push(name); continue; }
    tools.set(name, tool);
  }
  return { tools, blocked, wildcard };
}

/**
 * 「这个角色能不能派活」—— 端口那一侧和工具表那一侧**必须用同一个判据**，
 * 否则两处会各自漂移，最后变成「表里有 Task、端口没挂」这类只能靠人肉对照才能发现的 bug。
 *
 * canDelegate 缺省（undefined）= 看白名单：白名单里没有派活工具 = 本来也派不了。
 * 出厂角色全都落在这个分支上，所以**今天子代理依然不能再派子代理**（既有纪律②：防无限套娃）。
 * 要开放嵌套：把 Task 等名字加进那个角色的白名单即可，两处门会一起打开。
 */
export function roleCanDelegate(role: SubagentRole | undefined): boolean {
  if (!role) return false;
  if (role.canDelegate === false) return false;
  return role.tools.includes("*") || role.tools.some((n) => DELEGATION_TOOLS.has(n));
}
