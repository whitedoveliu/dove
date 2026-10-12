/**
 * 只读观察命令：tools / skills / goals / goal
 *
 * 这一组必须**优雅降级**：它们查的端点有两条是别的任务正在补的（/api/tools/list、
 * /api/goal*），老内核上没有。CLI 比内核新是常态（用户升级了 CLI、没重启 App），
 * 撞上 404 就崩会显得整个工具是坏的 —— 所以统一走 apiOrNull，404 时给一句
 * 「内核版本较旧」并说明退化路径，而不是抛异常。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { flagBool, flagNum, flagStr, restText, type Args } from "./args.ts";
import { api, apiOrNull, ApiError, errText, type Target } from "./client.ts";
import { bold, cyan, dim, EXIT, note, out, red, yellow } from "./out.ts";
import { resolveThread, NoThreadError } from "./threads.ts";

interface Row {
  name: string;
  desc: string;
  group?: string;
}

/**
 * 把「工具/技能清单」这种形状不定的响应拍平。
 * 为什么写这么松：这些端点的响应体是并行任务定的（{tools:[]} / [] / {core,system}…），
 * 客户端这边硬编码一种形状，那边换个字段名就整条命令报错 —— 不值得。
 */
function rowsOf(r: unknown): Row[] {
  const pick = (o: Record<string, unknown>): Row => {
    const name = String(o.name ?? o.id ?? o.tool ?? o.path ?? "?");
    const desc = String(o.description ?? o.summary ?? o.desc ?? o.note ?? "");
    const group = o.tier ?? o.group ?? o.layer ?? o.kind;
    return { name, desc, ...(group ? { group: String(group) } : {}) };
  };
  const flat = (v: unknown, group?: string): Row[] => {
    if (!Array.isArray(v)) return [];
    return v.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      if (group && o.tier === undefined && o.group === undefined) return { ...pick(o), group };
      return pick(o);
    });
  };
  if (Array.isArray(r)) return flat(r);
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    if (Array.isArray(o.tools)) return flat(o.tools);
    if (Array.isArray(o.skills)) return flat(o.skills);
    if (Array.isArray(o.items)) return flat(o.items);
    const grouped: Row[] = [];
    for (const [k, v] of Object.entries(o)) if (Array.isArray(v)) grouped.push(...flat(v, k));
    if (grouped.length) return grouped;
  }
  return [];
}

function printRows(rows: Row[], json: boolean): void {
  if (json) { out(JSON.stringify(rows)); return; }
  if (rows.length === 0) { out(dim("（空）")); return; }
  const width = Math.min(28, Math.max(...rows.map((r) => r.name.length)));
  let lastGroup: string | undefined;
  for (const r of rows) {
    if (r.group && r.group !== lastGroup) { out(dim("── " + r.group)); lastGroup = r.group; }
    out(`  ${bold(r.name.padEnd(width))}  ${dim(r.desc.slice(0, 140))}`);
  }
}

export async function cmdTools(t: Target, a: Args): Promise<number> {
  try {
    const j = await api<unknown>(t, "/api/tools/list", { timeoutMs: 10_000 });
    if (flagBool(a, "json")) { out(JSON.stringify(j)); return EXIT.ok; }
    const rows = rowsOf(j);
    out(`${rows.length} 个工具：`);
    printRows(rows, false);
    return EXIT.ok;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // 404 = 这一版内核还没有这条路由（CLI 比内核新是常态：用户升了 CLI、没重启 App）
    // 403 = 路由在，但内核把工具表锁在脚本会话里（PTC 的 session/token，见 server/routes-tools.ts）。
    //       这是内核的安全决定（不带凭据给全量工具表 = 给本机任何进程一个无审批的执行口），
    //       CLI 不该绕它 —— 说清楚 + 给出现有能看的东西就够了。
    if (e.status !== 404 && e.status !== 403) throw e;

    const why = e.status === 404
      ? "内核版本较旧：GET /api/tools/list 还没上线"
      : "内核没有把工具表开放给外部：/api/tools/list 只认脚本会话的 session/token";
    const h = await api<{ tools?: number }>(t, "/api/health", { timeoutMs: 8_000 }).catch(() => null);

    if (flagBool(a, "json")) {
      // --json 也必须吐一行：脚本 `dove tools --json | jq .tools` 拿到**空 stdout** 会静默走错分支
      // （看起来像「内核一个工具都没有」）。所以降级时给一个结构化的空表 + 原因。
      out(JSON.stringify({
        tools: [], count: h?.tools ?? null, degraded: true, reason: why, detail: errText(e.body),
      }));
      return EXIT.ok;
    }

    note(yellow("！" + why));
    note(dim(e.status === 403 ? "  " + errText(e.body) : "  工具总数可以从 dove health 的 tools 字段看到；重启 App / dove up 换上内核再试"));
    if (h?.tools !== undefined) out(`内核里有 ${h.tools} 个工具（清单要模型用 ToolSearch 查，或看 /api/tools/list 的文档）`);
    return EXIT.ok;
  }
}

/**
 * `dove skills` —— 技能包目录。
 *
 * 优先问内核（以后有 /api/skills 就用它），没有就**直接读磁盘**：
 * CLI 和内核跑在同一台机器上，而技能目录的位置是死的（workspace/skills、
 * workspace/.dove/skills、~/.dove/skills —— 就是 Skill 工具那三处，见
 * core/src/tools/builtin/skill.ts）。与其等一个新端点，不如现在就能用。
 */
export async function cmdSkills(t: Target, a: Args): Promise<number> {
  const fromApi = await apiOrNull<unknown>(t, "/api/skills", { timeoutMs: 10_000 });
  if (fromApi !== null) {
    if (flagBool(a, "json")) { out(JSON.stringify(fromApi)); return EXIT.ok; }
    const rows = rowsOf(fromApi);
    out(`${rows.length} 个技能包：`);
    printRows(rows, false);
    return EXIT.ok;
  }

  let workspace = "";
  try {
    const cfg = await api<Record<string, unknown>>(t, "/api/config", { timeoutMs: 8_000 });
    workspace = String(cfg.workspaceRoot ?? "");
  } catch { /* 拿不到工作区就只扫全局目录 */ }

  const roots = [...new Set([
    workspace && join(workspace, "skills"),
    workspace && join(workspace, ".dove", "skills"),
    join(homedir(), ".dove", "skills"),
  ].filter(Boolean) as string[])];

  const rows: Row[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries) {
      const file = join(root, name, "SKILL.md");
      try { if (!statSync(file).isFile()) continue; } catch { continue; }
      rows.push({ name, desc: summaryOf(file), group: root.replace(homedir(), "~") });
    }
  }
  if (flagBool(a, "json")) { out(JSON.stringify(rows)); return EXIT.ok; }
  // 提示先打（stderr），结果后打（stdout）：两个 fd 的写入顺序在合并捕获时才会对得上
  note(dim("（内核没有 /api/skills，这里直接读磁盘：" + roots.map((r) => r.replace(homedir(), "~")).join(" · ") + "）"));
  out(`${rows.length} 个技能包：`);
  printRows(rows, false);
  return EXIT.ok;
}

/** SKILL.md 的第一行「像说明」的文字（跳过标题和 frontmatter）—— 和内核给模型看的一句话一致 */
function summaryOf(file: string): string {
  try {
    const text = readFileSync(file, "utf8").slice(0, 20_000);
    return text.split("\n").map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !l.startsWith("---"))?.slice(0, 160) ?? "";
  } catch { return ""; }
}

// ── 目标（goal） ────────────────────────────────────────────────

interface GoalView {
  objective?: string;
  phase?: string;
  rounds_started?: number;
  max_rounds?: number;
  revision?: number;
}

function renderGoal(g: GoalView | null, where: string, note0?: string): void {
  if (!g) { out(`  ${dim(where + "：没有目标")}`); return; }
  const phase = g.phase === "active" ? cyan("进行中") : g.phase === "complete" ? dim("已完成") : yellow(String(g.phase ?? "?"));
  out(`  ${bold(where)}  ${phase}  ${g.rounds_started ?? 0}/${g.max_rounds ?? "?"} 轮  ${dim("rev " + (g.revision ?? "?"))}`);
  out(`    ${String(g.objective ?? "").slice(0, 200)}`);
  if (note0) out(dim("    " + note0));
}

export async function cmdGoals(t: Target, a: Args): Promise<number> {
  const all = await apiOrNull<unknown>(t, "/api/goals", { timeoutMs: 10_000 });
  if (all !== null) {
    if (flagBool(a, "json")) { out(JSON.stringify(all)); return EXIT.ok; }
    const list = Array.isArray(all) ? (all as GoalView[]) : rowsOf(all).map((r) => ({ objective: r.name + " " + r.desc }));
    out(`${list.length} 个目标：`);
    for (const g of list) renderGoal(g, String((g as Record<string, unknown>).thread_id ?? (g as Record<string, unknown>).threadId ?? "?"));
    return EXIT.ok;
  }

  // 退化：逐个项目问一遍 /api/projects/<key>/goal。
  // ⚠️ 实测（2026-10-12）：新内核**两条都没有** —— 项目级目标只挂在老兼容层（8008）上。
  //    所以这里大概率会全空。留着它是因为：等目标路由补到新内核上，这条命令就自动能用了，
  //    不需要再改 CLI。退化时**说清**自己退化到哪儿了，别让用户以为是「真的没有目标」。
  const projects = await api<{ id: string; name?: string }[]>(t, "/api/projects", { timeoutMs: 8_000 });
  const rows: { where: string; goal: GoalView | null }[] = [];
  for (const p of projects) {
    const r = await apiOrNull<{ goal?: GoalView | null }>(t, `/api/projects/${encodeURIComponent(p.id)}/goal`, { timeoutMs: 8_000 });
    rows.push({ where: p.name ?? p.id, goal: r?.goal ?? null });
  }
  if (flagBool(a, "json")) { out(JSON.stringify(rows)); return EXIT.ok; }
  note(yellow("！内核还没有目标路由（/api/goals 与 /api/projects/<id>/goal 都不在）：逐个项目查也没有结果"));
  note(dim("  目标路由上线之前，只有老兼容层（8008）的 /api/projects/<key>/goal 有这个能力"));
  out(`${rows.filter((r) => r.goal).length}/${rows.length} 个项目有目标：`);
  for (const r of rows) renderGoal(r.goal, r.where);
  return EXIT.ok;
}

/**
 * `dove goal <create|get|update|clear>`
 * 主路径按任务约定走 /api/goal*；老内核上退回项目级的那条（只对项目线程有效）。
 */
export async function cmdGoal(t: Target, a: Args): Promise<number> {
  const action = a.sub || "get";
  let thread;
  try {
    thread = await resolveThread(t, a, undefined, { allowCreate: false });
  } catch (e) {
    if (e instanceof NoThreadError) { note(red("✗ ") + e.message); return EXIT.fail; }
    throw e;
  }

  let body: Record<string, unknown> = { threadId: thread.id, action };
  let want: "get" | "post" = "post";
  if (action === "get" || action === "show") { want = "get"; body = {}; }
  if (action === "create") {
    const objective = flagStr(a, "objective") ?? restText(a);
    if (!objective) { note("用法：dove goal create [--thread <id>] \"目标\" [--max-rounds 20]"); return EXIT.usage; }
    body.objective = objective;
    const mr = flagNum(a, "max-rounds");
    if (mr !== undefined) body.max_rounds = mr;
  }
  if (action === "update" || action === "pause" || action === "resume" || action === "complete" || action === "blocked") {
    const verb = action === "update"
      ? (flagBool(a, "pause") ? "pause" : flagBool(a, "resume") ? "resume" : flagBool(a, "complete") ? "complete" : flagBool(a, "blocked") ? "blocked" : "")
      : action;
    if (!verb) { note("用法：dove goal update --pause|--resume|--complete|--blocked [--reason ...]"); return EXIT.usage; }
    body.action = verb;
    const reason = flagStr(a, "reason");
    if (reason) body.blocked_reason = reason;
  }

  const path = want === "get" ? `/api/goal?threadId=${encodeURIComponent(thread.id)}` : "/api/goal";
  const r = await apiOrNull<Record<string, unknown>>(t, path, want === "get" ? { timeoutMs: 8_000 } : { body, timeoutMs: 8_000 });
  if (r !== null) return reportGoal(r, a);

  // ── 退化路径：项目级目标。只在项目线程上有意义（而且只在兼容层跑着的时候真的有） ──
  if (!thread.projectId) {
    note(yellow("！内核还没有目标路由：/api/goal* 不存在，而这个线程（" + thread.id + "）不属于任何项目，也没有项目级可退"));
    note(dim("  目标路由上线之前，只有老兼容层（8008）的 /api/projects/<key>/goal 有这个能力"));
    return EXIT.fail;
  }
  const p = `/api/projects/${encodeURIComponent(thread.projectId)}/goal`;
  const r2 = want === "get"
    ? await apiOrNull<Record<string, unknown>>(t, p, { timeoutMs: 8_000 })
    : await apiOrNull<Record<string, unknown>>(t, p, { body, timeoutMs: 8_000 });
  if (r2 === null) {
    note(red("✗ ") + "内核还没有目标路由：/api/goal* 与 " + p + " 都是 404");
    note(dim("  等 /api/goal* 上线（重启 App / dove up）之后这条命令就能用"));
    return EXIT.fail;
  }
  note(dim("（走的是项目级 " + p + "：内核还没有 /api/goal*）"));
  return reportGoal(r2, a);
}

function reportGoal(r: Record<string, unknown>, a: Args): number {
  if (flagBool(a, "json")) { out(JSON.stringify(r)); return r.success === false ? EXIT.fail : EXIT.ok; }
  if (r.success === false) {
    note(red("✗ ") + String(r.message ?? "内核拒绝了这次修改"));
    if (String(r.code ?? "").includes("NOT_FOUND")) note(dim("  这个会话还没有目标：dove goal create \"目标\""));
    return EXIT.fail;
  }
  renderGoal((r.goal ?? null) as GoalView | null, "目标", typeof r.note === "string" ? r.note : undefined);
  return EXIT.ok;
}
