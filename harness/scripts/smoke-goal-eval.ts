/**
 * 冒烟：目标验收（独立评估 + 硬闸门）—— 端到端，桩评估器，不许真模型参与。
 *
 * 为什么必须有它：这条链路横跨「runtime 跑一轮 → 落库 → 取证 → 独立评估 → 判定 → complete 闸门
 * → 反馈进下一轮提示词」七处，任何一处断了都不会报错，只会**静默放行**（干活的人自己宣布完成）。
 * 单测只能覆盖判定函数；"评估器到底拿到了什么证据""complete 真的被拒了吗"只能端到端跑。
 *
 * 架构：真 provider 桩（一个假的 OpenAI 兼容 SSE 服务，按轮次回放剧本）+ **真** runtime /
 * 真工具 / 真 SQLite / 真 GoalStore，只有**评估器**是桩（注入 opts.evaluator）——
 * 这正是这条纪律要的形状：模型可以换，判定纪律不换。
 *
 * 端口 8871：起面板契约层（legacy 那个 8008 的同一份代码），验证 criteria 能沿 HTTP 回读；
 * 4 个行为用例走 runWithGoalContinuation 直连（HTTP chat 路由没法注入桩评估器）。
 *
 * 用例：① 空证据 → FAIL，不给完成 ② 一项低于阈值 → 不完成且反馈带该项 id/描述
 *      ③ 全过 → 允许完成 ④ 没配 criteria → 行为不变（评估器一次都不跑）
 */
import "./_isolate.ts";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { startLegacyServer } from "../packages/server/src/legacy/server.ts";
import { loadOrMintToken } from "../packages/server/src/local-token.ts";
import { finish } from "./_lifecycle.ts";
import { GoalStore } from "../packages/core/src/agents/goal-store.ts";
import { CreateGoalTool } from "../packages/core/src/tools/builtin/goal-create.ts";
import { GetGoalTool } from "../packages/core/src/tools/builtin/goal-get.ts";
import { UpdateGoalTool } from "../packages/core/src/tools/builtin/goal-update.ts";
import { judgeEvaluation } from "../packages/core/src/agents/goal-criteria.ts";
import type { CriterionScore, GoalCriterion } from "../packages/core/src/agents/goal-criteria.ts";
import type { GoalEvaluator, GoalEvaluationInput } from "../packages/core/src/agents/goal-evaluator.ts";
import { makeModelEvaluator } from "../packages/core/src/agents/goal-evaluator.ts";
import { runWithGoalContinuation } from "../packages/server/src/goal-runner.ts";

process.env.DOVE_PORT = "8871";
process.env.DOVE_API_KEY = process.env.DOVE_API_KEY ?? "smoke-stub-key";
process.env.DOVE_LEGACY = "off";   // 8008 别起：本脚本自己把同一份契约层起在 8871

let pass = 0, fail = 0;
function check(name: string, ok: boolean, note = ""): void {
  if (ok) { pass++; console.log("  PASS  " + name + (note ? "   [" + note + "]" : "")); }
  else { fail++; console.log("  FAIL  " + name + (note ? "   [" + note + "]" : "")); }
}

// ── 假 provider：OpenAI 兼容 SSE，按剧本回放（只对**带 tools 的请求**回放剧本）──
type Plan = (msgs: Msg[]) => Turn;
interface Msg { role?: string; content?: unknown; name?: string; tool_calls?: { function: { name: string } }[] }
interface Turn { text?: string; toolCalls?: { name: string; args: Record<string, unknown> }[] }

let planner: Plan = () => ({ text: "（没有剧本）" });
/** 真评估器那条路用的答复（只有模型是假的，提示词/解析/判定都是真的） */
let evaluatorReply: string | null = null;
/** 评估器请求原样留档：用来验「它到底看得到什么」 */
const evaluatorRequests: { role?: string; content?: unknown }[][] = [];
let providerCalls = 0;

const fakeProvider = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    providerCalls++;
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { messages?: Msg[]; tools?: unknown[] };
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const sys = (body.messages ?? []).find((m) => m.role === "system");
    const isEvaluator = typeof sys?.content === "string" && sys.content.includes("独立验收评估器");
    if (isEvaluator) evaluatorRequests.push(body.messages ?? []);
    // 只有主循环的请求带 tools。记忆/日记/分类器那些后台请求也给一个正常答复 ——
    // 否则它们会被剧本当成"这一轮还没写文件"，凭空调起 Write 来。
    const turn: Turn = isEvaluator && evaluatorReply !== null
      ? { text: evaluatorReply }
      : hasTools ? planner(body.messages ?? []) : { text: "（后台提炼：无操作）" };
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (o: unknown): void => { res.write("data: " + JSON.stringify(o) + "\n\n"); };
    if (turn.text) send({ choices: [{ delta: { content: turn.text }, finish_reason: null }] });
    (turn.toolCalls ?? []).forEach((c, i) => {
      send({
        choices: [{
          delta: { tool_calls: [{ index: i, id: "call_" + providerCalls + "_" + i, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] },
          finish_reason: null,
        }],
      });
    });
    send({ choices: [{ delta: {}, finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop" }] });
    send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

const fakePort = await new Promise<number>((resolve) => {
  fakeProvider.listen(0, "127.0.0.1", () => resolve((fakeProvider.address() as { port: number }).port));
});
process.env.DOVE_BASE_URL = "http://127.0.0.1:" + fakePort + "/v1";
console.log("[smoke] 假 provider 在 :" + fakePort + "，内核 8871");

// ── 剧本 ────────────────────────────────────────────
type Mode = "claim" | "artifact" | "artifact+complete";

function msgsThisRound(msgs: Msg[]): Msg[] {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === "user") return msgs.slice(i);
  return msgs;
}
function calledTools(round: Msg[]): Set<string> {
  const s = new Set<string>();
  for (const m of round) for (const c of m.tool_calls ?? []) s.add(c.function.name);
  return s;
}
function lastToolResult(round: Msg[], name: string): Record<string, unknown> | null {
  for (let i = round.length - 1; i >= 0; i--) {
    const m = round[i]!;
    if (m.role === "tool" && m.name === name && typeof m.content === "string") {
      try { return JSON.parse(m.content) as Record<string, unknown>; } catch { return null; }
    }
  }
  return null;
}

/** 一轮里的动作序列：Write（放产物）→ GetGoal → UpdateGoal complete → AttemptCompletion（收尾） */
function makePlanner(mode: Mode, artifact: string, marker: string): Plan {
  const content = "# 交付物\n\nmarker: " + marker + "\n";
  return (msgs: Msg[]) => {
    const round = msgsThisRound(msgs);
    const called = calledTools(round);
    // 收尾必须走 AttemptCompletion：干过活的回合不声明完成，完成守（gates.ts）会
    // 再开三次 pass 把同一套动作重放一遍 —— 那会让「一轮"调用了几次工具」完全失真
    if (called.has("AttemptCompletion")) return { text: "本轮结束。" };
    if (mode === "claim") {
      // 光说自己做完了：一个写类工具都不调 → 没有任何可核验的证据
      if (!called.has("GetGoal")) return { toolCalls: [{ name: "GetGoal", args: {} }] };
      if (!called.has("UpdateGoal")) {
        const g = (lastToolResult(round, "GetGoal")?.goal ?? {}) as Record<string, unknown>;
        return { toolCalls: [{ name: "UpdateGoal", args: { goal_id: String(g.id ?? ""), revision: Number(g.revision ?? 0), action: "complete" } }] };
      }
      return { toolCalls: [{ name: "AttemptCompletion", args: { summary: "都做完了，一切正常。" } }] };
    }
    if (!called.has("Write")) return { toolCalls: [{ name: "Write", args: { file_path: artifact, content } }] };
    if (mode === "artifact") {
      // 再跑一条**只读**验证命令（wc 在审批白名单里，不需要弹窗）——
      // 命令输出也是证据，评估器该看得到
      if (!called.has("Bash")) return { toolCalls: [{ name: "Bash", args: { command: "wc -c " + artifact } }] };
      return { toolCalls: [{ name: "AttemptCompletion", args: { summary: "这一轮的产物已经落盘，并跑过一次检查。" } }] };
    }
    if (!called.has("GetGoal")) return { toolCalls: [{ name: "GetGoal", args: {} }] };
    if (!called.has("UpdateGoal")) {
      const g = (lastToolResult(round, "GetGoal")?.goal ?? {}) as Record<string, unknown>;
      return { toolCalls: [{ name: "UpdateGoal", args: { goal_id: String(g.id ?? ""), revision: Number(g.revision ?? 0), action: "complete" } }] };
    }
    return { toolCalls: [{ name: "AttemptCompletion", args: { summary: "本轮结束。" } }] };
  };
}

// ── 桩评估器：打分由脚本给，判定走**真**规则（空证据 = FAIL 就是这里验的）──
interface StubHarness { evaluator: GoalEvaluator; calls: GoalEvaluationInput[] }
function makeStub(score: (input: GoalEvaluationInput) => CriterionScore[]): StubHarness {
  const calls: GoalEvaluationInput[] = [];
  return {
    calls,
    evaluator: {
      id: "stub",
      async evaluate(input: GoalEvaluationInput) {
        calls.push(input);
        return judgeEvaluation({
          criteria: input.criteria, scores: score(input),
          evidenceCount: input.evidence.length, round: input.round,
        });
      },
    },
  };
}

// ── 服务 ────────────────────────────────────────────
const svc = await bootstrap(loadConfig());
const goals = new GoalStore(svc.db);
// 兼容层除 /api/health 外都要令牌（和 main.ts 同一条路径），这里自己取一把
const token = loadOrMintToken(svc.cfg.configDir);
const legacy = await startLegacyServer(svc, 8871, token);
check("面板契约层起在 8871", legacy?.port === 8871, "port=" + (legacy?.port ?? "null"));

type ToolCallCtx = never;
function ctxFor(threadId: string, workdir: string): ToolCallCtx {
  return {
    toolCallId: "call_smoke", threadId, workdir, outputsDir: workdir + "/outputs",
    emit: () => { /* 冒烟不关心事件 */ },
    services: { goals },
  } as never;
}
type AnyTool = { execute: (i: Record<string, unknown>, c: never) => Promise<Record<string, unknown>> };
const runTool = (t: AnyTool, input: Record<string, unknown>, ctx: ToolCallCtx): Promise<Record<string, unknown>> => t.execute(input, ctx);

function textOf(m: { parts: unknown[] }): string {
  return (m.parts as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}
function userTexts(threadId: string): string[] {
  return svc.store.listMessages(threadId).filter((m) => m.role === "user").map(textOf);
}
function toolOutputs(threadId: string): { tool: string; output: Record<string, unknown> }[] {
  const out: { tool: string; output: Record<string, unknown> }[] = [];
  for (const m of svc.store.listMessages(threadId)) {
    for (const p of m.parts as { type: string; toolName?: string; output?: unknown }[]) {
      if (p.type.startsWith("tool-") && p.toolName) out.push({ tool: p.toolName, output: (p.output ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

interface CaseResult {
  threadId: string; projectId: string; rounds: number;
  goal: ReturnType<GoalStore["get"]>; stub: StubHarness; events: { type: string; [k: string]: unknown }[];
}
async function runCase(o: {
  tag: string; mode: Mode; objective: string; userText: string;
  criteria?: GoalCriterion[]; score: (i: GoalEvaluationInput) => CriterionScore[]; maxRounds?: number;
}): Promise<CaseResult> {
  const proj = svc.projects.create({ name: "目标验收冒烟-" + o.tag });
  const th = svc.store.getOrCreateProjectThread(proj.id, proj.name);
  planner = makePlanner(o.mode, "artifact.md", "SMOKE-" + o.tag);
  const created = await runTool(CreateGoalTool as AnyTool, {
    objective: o.objective, ...(o.maxRounds ? { max_rounds: o.maxRounds } : {}),
    ...(o.criteria ? { criteria: o.criteria } : {}),
  }, ctxFor(th.id, proj.path));
  if (created.ok !== true) throw new Error("建目标失败：" + JSON.stringify(created));
  const stub = makeStub(o.score);
  const events: { type: string; [k: string]: unknown }[] = [];
  const r = await runWithGoalContinuation(svc.runtime, {
    threadId: th.id, userText: o.userText, projectId: proj.id,
    sink: (e) => events.push(e), evaluator: stub.evaluator,
  });
  return { threadId: th.id, projectId: proj.id, rounds: r.rounds, goal: goals.get(th.id), stub, events };
}

const c1Desc = "交付物文件落盘且内容非空";
const c2Desc = "跑过一次验证命令";
const CRITERIA: GoalCriterion[] = [
  { id: "c1", description: c1Desc, threshold: 80 },
  { id: "c2", description: c2Desc, threshold: 60 },
];

// ── 用例 ①：空证据 → FAIL，不给完成 ─────────────────
console.log("\n=== ① 空证据：评估器连证据都拿不到，一律 FAIL ===");
const r1 = await runCase({
  tag: "01-empty", mode: "claim", criteria: CRITERIA, maxRounds: 3,
  objective: "交付一份能看的说明（带验收标准）", userText: "开始做，做完告诉我。",
  // 桩给的分很漂亮 —— 空证据必须压过分数（这正是「空证据 = 自动 FAIL」）
  score: () => [{ id: "c1", score: 100, evidence: "（桩：无依据的高分）" }, { id: "c2", score: 100, evidence: "（桩：无依据的高分）" }],
});
const up1 = toolOutputs(r1.threadId).filter((t) => t.tool === "UpdateGoal");
check("① 桩评估器收到的证据为空", r1.stub.calls.length > 0 && r1.stub.calls.every((c) => c.evidence.length === 0), "评估次数=" + r1.stub.calls.length);
check("① 目标没被完成（phase 仍是 active）", r1.goal?.phase === "active", "phase=" + r1.goal?.phase);
check("① 评估结论落盘为 FAIL", r1.goal?.lastVerdict?.pass === false, r1.goal?.lastVerdict?.reason ?? "");
check("① 模型在轮内的 complete 被硬拒", up1.some((t) => t.output.code === "GOAL_EVAL_FAILED"), JSON.stringify(up1.map((t) => t.output.code ?? t.output.goal ?? t.output)));
check("① 事件里有 goal_eval pass=false", r1.events.some((e) => e.type === "goal_eval" && e.pass === false), "评估事件=" + r1.events.filter((e) => e.type === "goal_eval").length);
check("① 失败项作为反馈进了下一轮提示词", userTexts(r1.threadId).some((t) => t.includes("<goal_eval_feedback>") && t.includes("[c1]") && t.includes(c1Desc)),
  "第 " + r1.rounds + " 轮续跑");
check("① 每轮都重新评估（不是只评一次）", r1.stub.calls.length >= 2, "评估=" + r1.stub.calls.length + " 次 / 续跑 " + r1.rounds + " 轮");

// 非法标准必须当场拒绝（"标准"要是能被随手写坏，这条纪律就成摆设了）
const badCreate = await runTool(CreateGoalTool as AnyTool, {
  objective: "坏标准", criteria: [{ id: "c1", threshold: 200 }],
}, ctxFor(r1.threadId, ""));
check("建目标时非法的 criteria 被拒（GOAL_BAD_INPUT）",
  badCreate.ok === false && badCreate.code === "GOAL_BAD_INPUT", String(badCreate.error ?? "").slice(0, 60));

// 面板契约回读（真 HTTP）—— 带令牌，和面板走同一条路
const gres = await fetch("http://127.0.0.1:8871/api/projects/" + r1.projectId + "/goal", {
  headers: { "X-Dove-Token": token },
});
const gbody = await gres.json() as { goal?: { criteria?: GoalCriterion[]; last_eval?: { pass?: boolean } } };
check("HTTP /goal 回读 criteria（面板那条路）",
  gres.status === 200 && (gbody.goal?.criteria?.length ?? 0) === 2 && gbody.goal?.criteria?.[0]?.id === "c1",
  "status=" + gres.status + " criteria=" + JSON.stringify(gbody.goal?.criteria));
check("HTTP /goal 回读最近一次评估", gbody.goal?.last_eval?.pass === false, "last_eval=" + JSON.stringify(gbody.goal?.last_eval));

// ── 用例 ②：一项低于阈值 → 不完成，反馈带该项 ─────────
console.log("\n=== ② 一项低于阈值：不完成，反馈里必须有那一项 ===");
const r2 = await runCase({
  tag: "02-low", mode: "artifact", criteria: CRITERIA, maxRounds: 2,
  objective: "交付 artifact.md 并跑过一次验证", userText: "开始做。",
  score: () => [
    { id: "c1", score: 92, evidence: "证据 1：文件 artifact.md 存在，内容含 marker: SMOKE-02-low" },
    { id: "c2", score: 41, evidence: "证据里没有任何命令输出" },
  ],
});
check("② 桩评估器拿到了真产物（文件内容含 marker）",
  r2.stub.calls.some((c) => c.evidence.some((e) => e.kind === "file" && e.ref.endsWith("artifact.md") && e.exists === true && e.detail.includes("SMOKE-02-low"))),
  "证据=" + (r2.stub.calls[0]?.evidence.map((e) => e.kind + ":" + e.ref).join(", ") ?? "无"));
check("② 命令输出也进了证据（不是只认文件）",
  r2.stub.calls.some((c) => c.evidence.some((e) => e.kind === "command" && e.ref.includes("wc -c") && e.detail.includes("[exit_code] 0"))),
  "命令证据=" + (r2.stub.calls[0]?.evidence.filter((e) => e.kind === "command").length ?? 0) + " 条");
check("② 目标没被完成", r2.goal?.phase === "active", "phase=" + r2.goal?.phase);
const v2 = r2.goal?.lastVerdict;
check("② 只有 c2 判失败（c1 过了不算失败）", v2?.failures.length === 1 && v2.failures[0]?.id === "c2", JSON.stringify(v2?.failures.map((f) => f.id)));
check("② 失败原因写的是低于阈值", (v2?.failures[0]?.reason ?? "").includes("低于阈值"), v2?.failures[0]?.reason ?? "");
const try2 = await runTool(UpdateGoalTool as AnyTool, {
  goal_id: r2.goal!.id, revision: r2.goal!.revision, action: "complete",
}, ctxFor(r2.threadId, ""));
check("② 直接 complete 也会被拒（GOAL_EVAL_FAILED）", try2.ok === false && try2.code === "GOAL_EVAL_FAILED", JSON.stringify(try2).slice(0, 160));
check("② 反馈里有该项 id 与描述",
  userTexts(r2.threadId).some((t) => t.includes("<goal_eval_feedback>") && t.includes("[c2]") && t.includes(c2Desc)),
  "用户消息数=" + userTexts(r2.threadId).length);

// ── 用例 ③：全过 → 允许完成 ─────────────────────────
console.log("\n=== ③ 全部达标：评估通过，complete 才放行 ===");
const r3 = await runCase({
  tag: "03-pass", mode: "artifact+complete", criteria: CRITERIA, maxRounds: 3,
  objective: "交付 artifact.md 并跑过一次验证", userText: "开始做。",
  score: () => [
    { id: "c1", score: 95, evidence: "证据 1：artifact.md 存在，内容含 marker: SMOKE-03-pass" },
    { id: "c2", score: 88, evidence: "证据 1 的命令输出显示验证命令 exit_code=0" },
  ],
});
const up3 = toolOutputs(r3.threadId).filter((t) => t.tool === "UpdateGoal");
check("③ 评估通过前 complete 被拒（先评估后完成）", up3.some((t) => t.output.code === "GOAL_EVAL_FAILED"), JSON.stringify(up3.map((t) => t.output.code ?? "ok")));
check("③ 评估通过后 complete 成功", r3.goal?.phase === "complete", "phase=" + r3.goal?.phase + " rounds=" + r3.rounds);
check("③ 事件里有 goal_eval pass=true", r3.events.some((e) => e.type === "goal_eval" && e.pass === true), "");
check("③ 评估器只在目标还 active 时跑", r3.stub.calls.length === 1, "评估=" + r3.stub.calls.length + " 次");

// ── 用例 ④：没配 criteria → 老行为不变 ────────────────
console.log("\n=== ④ 无验收标准：不出评估器，行为与以前一致 ===");
const r4 = await runCase({
  tag: "04-plain", mode: "artifact+complete", maxRounds: 3,
  objective: "交付 artifact.md（没给验收标准）", userText: "开始做。",
  score: () => [{ id: "x", score: 100, evidence: "不该被调用" }],
});
check("④ 评估器一次都没跑", r4.stub.calls.length === 0, "评估=" + r4.stub.calls.length + " 次");
check("④ 没有 goal_eval 事件", r4.events.every((e) => e.type !== "goal_eval"), "事件=" + r4.events.map((e) => e.type).join(","));
check("④ 第一轮就能 complete（无闸门）", r4.goal?.phase === "complete" && r4.rounds === 0, "phase=" + r4.goal?.phase + " rounds=" + r4.rounds);
check("④ 没有任何 GOAL_EVAL_FAILED", !toolOutputs(r4.threadId).some((t) => t.output.code === "GOAL_EVAL_FAILED"), "");
check("④ 回读里没有 criteria 字段", !JSON.stringify((await runTool(GetGoalTool as AnyTool, {}, ctxFor(r4.threadId, ""))).goal ?? {}).includes("criteria"), "");

// ── 用例 ⑤：真评估器（提示词/解析/判定都是真的，只有模型是假的）──
// 桩能替是「可注入」；真实现能跑通才是这条链路真的接上了。
console.log("\n=== ⑤ 真评估器：解析打分 + 失败关闭 ===");
const realEval = makeModelEvaluator({ provider: svc.runtime.services.provider, model: "deepseek-flash" });
const fakeEvidence = [{ kind: "file" as const, ref: "/tmp/artifact.md", exists: true, bytes: 32, detail: "marker: SMOKE-real" }];

evaluatorReply = JSON.stringify({ items: [{ id: "c1", score: 91, evidence: "marker: SMOKE-real" }, { id: "c2", score: 70, evidence: "exit_code=0" }] });
const realPass = await realEval.evaluate({ objective: "交付 artifact.md", criteria: CRITERIA, evidence: fakeEvidence, round: 1 });
check("⑤ 真评估器：解析出打分且判通过", realPass.pass === true && realPass.items.length === 2, realPass.reason);
const evalReq = JSON.stringify(evaluatorRequests);
check("⑤ 评估器只看得到目标/标准/证据，看不到主代理的自我陈述",
  evaluatorRequests.length > 0 && evalReq.includes("交付 artifact.md") && evalReq.includes(c1Desc)
    && evalReq.includes("marker: SMOKE-real") && !evalReq.includes("都做完了，一切正常。"),
  "评估器请求 " + evaluatorRequests.length + " 次");

evaluatorReply = "这个……我看还行吧。（没有 JSON）";
const realGarbage = await realEval.evaluate({ objective: "交付 artifact.md", criteria: CRITERIA, evidence: fakeEvidence, round: 1 });
check("⑤ 真评估器：输出不是 JSON → 一律 FAIL（失败关闭）", realGarbage.pass === false && realGarbage.reason.includes("评估没能完成"), realGarbage.reason);

evaluatorReply = JSON.stringify({ items: [{ id: "c1", score: 99, evidence: "" }] });
const realThin = await realEval.evaluate({ objective: "交付 artifact.md", criteria: CRITERIA, evidence: fakeEvidence, round: 1 });
check("⑤ 真评估器：无证据引用 / 漏项都判失败", realThin.pass === false && realThin.failures.length === 2,
  realThin.failures.map((f) => f.id + ":" + f.reason).join(" | "));

const beforeEmpty = providerCalls;
evaluatorReply = JSON.stringify({ items: [{ id: "c1", score: 100, evidence: "我猜做到了" }] });
const realEmpty = await realEval.evaluate({ objective: "交付 artifact.md", criteria: CRITERIA, evidence: [], round: 1 });
check("⑤ 真评估器：空证据时连模型都不叫（直接 FAIL）", realEmpty.pass === false && providerCalls === beforeEmpty,
  "模型调用 " + beforeEmpty + " → " + providerCalls);

console.log("\n=== 汇总 ===");
console.log("provider 调用 " + providerCalls + " 次（全是假 provider；真模型 0 次）  PASS=" + pass + " FAIL=" + fail);
legacy?.close();
fakeProvider.close();
finish(svc, fail > 0 ? 1 : 0);
