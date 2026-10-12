#!/usr/bin/env node
/**
 * 后台 shell 生命周期自测（Bash / BashOutput / KillShell / jobs.ts）+ 技能依赖预检（Skill）
 * 运行：cd harness && node --no-warnings scripts/smoke-jobs.ts
 *
 * 对应 Alma 报告里 dove 做得不如它的两条（§3.2.1 / §5.3）：
 *   ① 输出缓冲丢头保尾（上限 200,000 字符/流）—— 真造 500KB+ 输出，
 *      断言开头被丢、最新行在、note 明说「更早的输出已被丢弃」；
 *   ② 停滞守卫 + 自动转后台 —— 阈值走环境变量（DOVE_JOB_STALL_MS / DOVE_AUTO_BACKGROUND_MS），
 *      冒烟压到几百毫秒**真验行为**，不真等 90 秒 / 60 秒；
 *   ③ 技能依赖预检 —— 造声明了不存在 bin/env 的技能目录，断言正文开头有警告。
 *
 * 为什么起内核（端口 8851）：bootstrap 会实例化整张工具表，改动有没有把服务弄挂只有真起才知道。
 * 端口是本脚本分配的，不碰用户在 8790 上正在跑的 Dove。
 * 内容类断言走 tool.execute 原始路径（smoke-terminal 同款）；另有 executeOne 用例专门验
 * 「模型可见层」——budget.ts 会把 stdout 从头裁到 1500 字符，所以别在它上面直接断言长正文。
 */
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库指到临时目录，别碰生产库
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, bootstrap, type Services } from "../packages/server/src/bootstrap.ts";
import { handle } from "../packages/server/src/routes.ts";
import { SseHub } from "../packages/server/src/sse.ts";
import { finish } from "./_lifecycle.ts";
import { BashTool } from "../packages/core/src/tools/builtin/bash.ts";
import { BashOutputTool } from "../packages/core/src/tools/builtin/bash-output.ts";
import { KillShellTool } from "../packages/core/src/tools/builtin/kill-shell.ts";
import { SkillTool } from "../packages/core/src/tools/builtin/skill.ts";
import { RuntimeStatusTool } from "../packages/core/src/tools/builtin/runtime-status.ts";
import { MAX_JOB_STREAM_CHARS, listJobs, killJob } from "../packages/core/src/tools/builtin/jobs.ts";
import { executeOne } from "../packages/core/src/loop/tool-exec.ts";
import type { Tool, ToolContext } from "../packages/core/src/tools/types.ts";
import type { ToolCallPayload } from "../packages/core/src/providers/types.ts";

process.env.DOVE_PORT = "8851";   // 分配给我的端口（见标题注释）

const PORT = 8851;
const THREAD = "smoke-jobs";
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};
const section = (t: string): void => { console.log("\n=== " + t + " ==="); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const S = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

const workdir = process.env.DOVE_WORKSPACE ?? tmpdir();

function ctxOf(dir: string, threadId = THREAD): ToolContext {
  return {
    toolCallId: "smoke", threadId, workdir: dir, outputsDir: tmpdir(),
    emit: () => {}, requestApproval: async () => ({ approved: true }), services: {},
  } as unknown as ToolContext;
}
const run = (tool: Tool, args: Record<string, unknown>, dir: string):
Promise<Record<string, unknown>> => tool.execute(args, ctxOf(dir)) as Promise<Record<string, unknown>>;

/** executeOne 的执行依赖（真实管线：审批 + 超时 + 输出预算） */
function execDeps(tool: Tool, dir: string): never {
  return {
    tools: new Map([[tool.name, tool]]),
    ctxBase: { threadId: THREAD, workdir: dir, outputsDir: tmpdir(), emit: () => {}, services: {} },
    resolveApproval: async () => ({ approved: true }),
  } as never;
}
const callOf = (id: string, name: string, args: Record<string, unknown>): ToolCallPayload =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } }) as unknown as ToolCallPayload;

let svc: Services | null = null;
let server: Server | null = null;
const skillRoot = mkdtempSync(join(tmpdir(), "dove-smoke-skills-"));

try {
  const cfg = loadConfig();
  check("内核端口就是分配给我的 8851", cfg.port === PORT, "port=" + cfg.port);
  svc = await bootstrap(cfg);
  const hub = new SseHub();
  server = createServer((req, res) => {
    handle(req, res, { svc: svc!, hub, controlPanelDir: "", running: new Map() }).catch(() => {
      try { res.writeHead(500); res.end(); } catch { /* 已经写过头 */ }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(PORT, "127.0.0.1", () => resolve());
  });

  // ── 0. 内核起来 + 工具契约一致（Alma 反面教材：bash_id / shell_id 双命名） ──
  section("0. 内核在 8851 起得来；三个后台工具的参数名一致");
  const health = await (await fetch("http://127.0.0.1:" + PORT + "/api/health")).json() as Record<string, unknown>;
  check("GET /api/health ok", health.ok === true, JSON.stringify(health).slice(0, 110));
  check("工具表已装配（>= 30 个）", Number(health.tools) >= 30, "tools=" + S(health.tools));
  const props = (t: Tool): string[] =>
    Object.keys((t.parameters as { properties?: Record<string, unknown> }).properties ?? {});
  const idParam = "job_id";
  check("BashOutput / KillShell 共用同一个 id 参数名 " + idParam,
    props(BashOutputTool).includes(idParam) && props(KillShellTool).includes(idParam),
    props(BashOutputTool).join(",") + " | " + props(KillShellTool).join(","));
  check("没有 bash_id / shell_id 这类第二种命名",
    ![...props(BashTool), ...props(BashOutputTool), ...props(KillShellTool)].some((p) => p === "bash_id" || p === "shell_id"),
    [...props(BashTool), ...props(BashOutputTool), ...props(KillShellTool)].join(","));
  const reg = await import("../packages/core/src/tools/registry.ts");
  check("三个工具都在注册表里（改的是各自文件，不是注册表）",
    ["Bash", "BashOutput", "KillShell"].every((n) => !!reg.getTool(n)));

  // ── 1. 丢头保尾 ──────────────────────────────────────
  section("1. 输出缓冲：丢头保尾（真吐 500KB+，要最新行、不要开头）");
  const gen = "node -e \"for(let i=0;i<4000;i++)console.log('JOBLINE-'+i+' '+'x'.repeat(120))\"";
  const bg = await run(BashTool, { command: gen, run_in_background: true }, workdir);
  const jobId = S(bg.job_id);
  check("后台任务拿到 job_id", jobId.startsWith("sh_"), jobId);
  const out1 = await run(BashOutputTool, { job_id: jobId, wait_seconds: 30 }, workdir);
  check("任务跑完 status=completed", S(out1.status) === "completed", S(out1.status) + " exit=" + S(out1.exit_code));
  const text1 = S(out1.stdout);
  check("保留的是尾部：含最新行 JOBLINE-3999", text1.includes("JOBLINE-3999"), JSON.stringify(text1.slice(-30)));
  check("开头已被丢弃：JOBLINE-0 不在缓冲里", !text1.includes("JOBLINE-0 "), JSON.stringify(text1.slice(0, 40)));
  const firstLine = text1.split("\n").find((l) => l.startsWith("JOBLINE-"));
  check("保留下来的第一行号 > 0（头部真的丢掉了）",
    Number(/JOBLINE-(\d+)/.exec(firstLine ?? "")?.[1] ?? -1) > 0, firstLine?.slice(0, 28) ?? "(空)");
  check("单流不超过源头上限 " + MAX_JOB_STREAM_CHARS, text1.length <= MAX_JOB_STREAM_CHARS, "len=" + text1.length);
  check("报告了丢弃字符数（dropped_stdout_chars > 100000）", Number(out1.dropped_stdout_chars) > 100_000, S(out1.dropped_stdout_chars));
  check("note 明确标注「更早的输出已被丢弃」", S(out1.note).includes("更早的输出已被丢弃"), S(out1.note).slice(0, 90));

  // ── 1b. 模型可见层：tail_chars 让预算层拿到的是尾部 ──
  section("1b. executeOne 真实管线：tail_chars 一档，模型可见的 stdout 就是最新输出");
  const boOutcome = await executeOne(callOf("smoke-bo", "BashOutput", { job_id: jobId, tail_chars: 300 }), execDeps(BashOutputTool, workdir));
  const boOut = (boOutcome.output ?? {}) as Record<string, unknown>;
  check("executeOne ok 且无截断标记（300 字符 < 预算 1500）",
    boOutcome.ok === true && boOut._truncationNotice === undefined, "ok=" + boOutcome.ok);
  check("模型可见 stdout 含最新行", S(boOut.stdout).includes("JOBLINE-3999"), JSON.stringify(S(boOut.stdout).slice(-30)));

  // ── 2. 停滞守卫（阈值可配，秒级验证） ────────────────
  section("2. 停滞守卫：静默任务超过阈值 → stalled + note 告诉模型「可能卡住了」");
  process.env.DOVE_JOB_STALL_MS = "700";
  try {
    const silent = await run(BashTool, { command: "sleep 5", run_in_background: true }, workdir);
    const sid = S(silent.job_id);
    const fresh = await run(BashOutputTool, { job_id: sid }, workdir);
    check("刚起来时不算停滞", fresh.stalled !== true, "stalled=" + S(fresh.stalled) + " silence=" + S(fresh.silence_ms));
    await sleep(1100);
    const stalled = await run(BashOutputTool, { job_id: sid }, workdir);
    check("超过阈值后 stalled=true", stalled.stalled === true, "stalled=" + S(stalled.stalled) + " silence=" + S(stalled.silence_ms));
    check("silence_ms 是真实静默时长（>= 700）", Number(stalled.silence_ms) >= 700, S(stalled.silence_ms));
    check("note 讲清「这个任务可能卡住了」", S(stalled.note).includes("可能卡住了"), S(stalled.note).slice(0, 100));
    // 列表视图（省略 job_id）也吃同一份 jobSummary：stalled 必须一路可见
    const listing = await run(BashOutputTool, {}, workdir);
    const row = (listing.jobs as Record<string, unknown>[]).find((j) => S(j.job_id) === sid);
    check("BashOutput 列表视图也带 stalled 标记", !!row && row.stalled === true, JSON.stringify(row));
    const ksList = await run(KillShellTool, {}, workdir);
    const krow = (ksList.jobs as Record<string, unknown>[]).find((j) => S(j.job_id) === sid);
    check("KillShell 列表视图同样带 stalled", !!krow && krow.stalled === true, JSON.stringify(krow));
    // RuntimeStatus 是 Home 线程唯一的只读自检入口（Bash 被策略裁掉了），
    // 「有没有命令卡住了」必须在这里也能问出来 —— 否则心跳只能凭印象
    const rs = await RuntimeStatusTool.execute({}, ctxOf(workdir)) as Record<string, unknown>;
    const rsJobs = rs.shell_jobs as Record<string, unknown>;
    check("RuntimeStatus 报出连停滞的 shell 任务一起算的 running 数",
      Number(rsJobs.running) >= 1 && Number(rsJobs.stalled) >= 1,
      "running=" + S(rsJobs.running) + " stalled=" + S(rsJobs.stalled));
    check("RuntimeStatus 报出停滞判定阈值（可注入的那个值）", Number(rsJobs.stall_threshold_ms) === 700, S(rsJobs.stall_threshold_ms));
    const rsRow = (rsJobs.items as Record<string, unknown>[]).find((j) => S(j.job_id) === sid);
    check("RuntimeStatus 的条目里这个 job 带 stalled=true", !!rsRow && rsRow.stalled === true, JSON.stringify(rsRow));
    check("RuntimeStatus 的 note 说清「可能卡住了」并给出下一步",
      S(rsJobs.note).includes("可能卡住了") && S(rsJobs.note).includes("BashOutput"),
      S(rsJobs.note).slice(0, 110));
    const killed = await run(KillShellTool, { job_id: sid }, workdir);
    check("KillShell 用同一个 job_id 收得掉", killed.killed === true, JSON.stringify(killed).slice(0, 90));
    const after = await run(BashOutputTool, { job_id: sid, wait_seconds: 5 }, workdir);
    check("停掉之后不再标 stalled（只对运行中判定）",
      after.stalled !== true && S(after.status) === "killed", "status=" + S(after.status) + " stalled=" + S(after.stalled));
    const rsAfter = await RuntimeStatusTool.execute({}, ctxOf(workdir)) as Record<string, unknown>;
    const rsAfterJobs = rsAfter.shell_jobs as Record<string, unknown>;
    check("杀掉之后 RuntimeStatus 不再把它算作 running/stalled",
      Number(rsAfterJobs.running) === 0 && Number(rsAfterJobs.stalled) === 0,
      "running=" + S(rsAfterJobs.running) + " stalled=" + S(rsAfterJobs.stalled));
  } finally {
    delete process.env.DOVE_JOB_STALL_MS;
  }

  // ── 3. 自动转后台（阈值可配，走真实执行管线） ────────
  section("3. 自动转后台：前台命令没给 timeout，跑满阈值就收编成后台任务");
  process.env.DOVE_AUTO_BACKGROUND_MS = "600";
  try {
    const t0 = Date.now();
    const outcome = await executeOne(
      callOf("smoke-bg", "Bash", { command: "echo EARLY-MARK; sleep 2; echo LATE-MARK" }),
      execDeps(BashTool, workdir),
    );
    const elapsed = Date.now() - t0;
    const out = (outcome.output ?? {}) as Record<string, unknown>;
    check("工具没干等：阈值 600ms + 2 秒命令，返回耗时 < 1.8 秒", elapsed < 1800, "elapsed=" + elapsed + "ms");
    check("结果里带 job_id 且标了 promoted_to_background",
      S(out.job_id).startsWith("sh_") && out.promoted_to_background === true,
      "job=" + S(out.job_id) + " promoted=" + S(out.promoted_to_background));
    check("note 告诉模型「已转后台，用 BashOutput 取结果」",
      S(out.note).includes("已自动转后台") && S(out.note).includes("BashOutput"), S(out.note).slice(0, 110));
    check("转后台前已产出的输出随结果带回（EARLY-MARK）", S(out.stdout).includes("EARLY-MARK"), JSON.stringify(S(out.stdout).slice(0, 40)));
    const final = await run(BashOutputTool, { job_id: S(out.job_id), wait_seconds: 10 }, workdir);
    check("转后台后任务跑完 status=completed", S(final.status) === "completed", S(final.status) + " exit=" + S(final.exit_code));
    check("收编切换点没丢输出：EARLY 和 LATE 都在", S(final.stdout).includes("EARLY-MARK") && S(final.stdout).includes("LATE-MARK"), JSON.stringify(S(final.stdout)));

    // 反面：显式给了 timeout_ms 就不许悄悄改语义（还是前台等到结束）
    const explicit = await run(BashTool, { command: "sleep 1; echo DONE-EXPLICIT", timeout_ms: 5000 }, workdir);
    check("显式 timeout_ms：不转后台，正常等到退出码 0",
      explicit.job_id === undefined && Number(explicit.exit_code) === 0 && S(explicit.stdout).includes("DONE-EXPLICIT"),
      "job=" + S(explicit.job_id) + " exit=" + S(explicit.exit_code));
  } finally {
    delete process.env.DOVE_AUTO_BACKGROUND_MS;
  }

  // ── 4. 技能依赖预检 ─────────────────────────────────
  section("4. 技能依赖预检：声明了不存在依赖 → 正文开头警告，别硬跑");
  const writeSkill = (name: string, body: string): void => {
    mkdirSync(join(skillRoot, "skills", name), { recursive: true });
    writeFileSync(join(skillRoot, "skills", name, "SKILL.md"), body);
  };
  // Alma 同款写法：metadata.requires.*（只存不校验的那个字段）
  writeSkill("dep-meta", [
    "---", "name: dep-meta", "description: 依赖缺失示例", "metadata:", "  requires:",
    '    bins: ["dove-no-such-bin-xyz"]', '    env: ["DOVE_NO_SUCH_ENV_XYZ"]', "---", "",
    "# 正文", "第一步就跑 lark-cli 干活。",
  ].join("\n"));
  // 顶层 requires + 块数组写法
  writeSkill("dep-plain", ["---", "requires:", "  bins:", "    - dove-no-such-bin-abc", "---", "# 正文"].join("\n"));
  // 正向对照：依赖都在（node / PATH）→ 不许误报
  writeSkill("dep-ok", ["---", "metadata:", "  requires:", "    bins: [node]", "    env: [PATH]", "---", "# 正文", "什么都不缺。"].join("\n"));

  const meta = await run(SkillTool, { name: "dep-meta" }, skillRoot);
  const content = S(meta.content);
  check("正文以警告开头", content.startsWith("⚠️ 这个技能声明的依赖缺失"), JSON.stringify(content.slice(0, 42)));
  check("点名缺的 bin（命令不存在）", content.includes("dove-no-such-bin-xyz（命令不存在）"), content.slice(0, 110));
  check("点名缺的 env（环境变量未设置）", content.includes("DOVE_NO_SUCH_ENV_XYZ（环境变量未设置）"), content.slice(0, 160));
  check("说了「装了再试，别硬跑」", content.includes("装了再试，别硬跑"));
  check("missing 结构化列出 2 条", Array.isArray(meta.missing) && (meta.missing as unknown[]).length === 2, JSON.stringify(meta.missing));
  check("正文本身还在（警告 + 原文）", content.includes("第一步就跑 lark-cli 干活"));
  const plain = await run(SkillTool, { name: "dep-plain" }, skillRoot);
  check("块数组写法也解析得到", S(plain.content).startsWith("⚠️") && S(plain.content).includes("dove-no-such-bin-abc"), S(plain.content).slice(0, 80));
  const okSkill = await run(SkillTool, { name: "dep-ok" }, skillRoot);
  check("依赖都在 → 不加警告、不误报", !S(okSkill.content).startsWith("⚠️") && okSkill.missing === undefined, S(okSkill.content).slice(0, 30));

  // ── 5. 收尾卫生 ─────────────────────────────────────
  section("5. 没有遗留的运行中后台任务");
  const stillRunning = listJobs().filter((j) => j.status === "running");
  check("跑完全部用例后注册表里没有 running", stillRunning.length === 0, stillRunning.map((j) => j.id + ":" + j.command).join(" | ") || "无");
} catch (e) {
  failed++;
  console.log("  ❌ 冒烟脚本自己抛了（这就是 bug）：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  // 兜底收尾：绝不能因为断言失败就留下孤儿进程
  for (const j of listJobs()) if (j.status === "running") killJob(j.id, "SIGKILL");
  rmSync(skillRoot, { recursive: true, force: true });
  server?.close();
}

section("结果");
console.log("  通过 " + passed + " / 失败 " + failed);
console.log(failed === 0 ? "✅ 后台任务生命周期 + 技能依赖预检全部通过" : "❌ 有失败项，见上面");
finish(svc, failed === 0 ? 0 : 1);
