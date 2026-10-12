#!/usr/bin/env node
/**
 * PTC（RunScript + 工具控制面）端到端冒烟 —— 端口 **8841**（分配给我的那个）。
 *
 * 走**真实路径**：真 bootstrap（临时库，见 _isolate）、真 HTTP 路由（routes.ts 的 handle）、
 * 真 Node 子进程、脚本内 doveTool 真的打回 /api/tools/invoke、审批真的走 /api/approve。
 * 只有 provider 是桩（不然这条路径要花真钱、还不可复现）。
 *
 * 六项断言：
 *  ① 脚本里 doveTool('Glob') 拿到真实结果；顺带 listTools() 的层/清单正确，且**不含 RunScript**（不开递归）
 *  ② 脚本里 doveTool('Bash') 真的回到内核审批 —— 批准的那条**执行了**（文件权限被改），
 *     拒绝的那条**没执行**（文件还在）。断言的是 approvals 计数与文件状态，不是「没报错」
 *  ③ timeout_ms 到点杀进程：timedOut + 没跑到后面那行
 *  ④ 只读线程下工具表里没有 RunScript（单元 + 真回合两条路）
 *  ⑤ stdout 超限落盘：结果里给 _spillPath，存档文件里是完整内容
 *  ⑥ 不带 session/token 调工具控制面 → 403（不学 Alma 的「不带就退化成全部工具」）
 */
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库指到临时目录，别碰生产库
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { handle } from "../packages/server/src/routes.ts";
import { SseHub } from "../packages/server/src/sse.ts";
import { allTools, CORE_TOOLS } from "../packages/core/src/tools/registry.ts";
import { applyThreadPolicy } from "../packages/core/src/agent/tool-policy.ts";
import { PTC_APPROVAL_PREFIX } from "../packages/core/src/tools/builtin/run-script.ts";
import type { Provider, StreamOptions, StreamResult } from "../packages/core/src/providers/types.ts";
import { finish } from "./_lifecycle.ts";

const PORT = 8841;
process.env.DOVE_PORT = String(PORT);
process.env.DOVE_APPROVE = "ask";       // 审批必须真走一遍（别被外部环境的 auto 短路掉）
process.env.DOVE_ACTIVITY = "off";
process.env.DOVE_LEGACY = "off";

let failures = 0;
function check(ok: boolean, label: string, detail?: unknown): void {
  if (ok) { console.log("  ✓ " + label); return; }
  failures++;
  console.error("  ✗ " + label + (detail === undefined ? "" : " —— " + JSON.stringify(detail).slice(0, 500)));
}

const cfg = loadConfig();
if (cfg.port !== PORT) { console.error("端口不是 " + PORT + "（DOVE_PORT 没生效？）实际 " + cfg.port); process.exit(1); }
const svc = await bootstrap(cfg);

// ── 真 HTTP 服务（和 main.ts 同一个 handle 函数；这里不起 legacy/cron） ──
const hub = new SseHub();
const server = createServer((req, res) => {
  handle(req, res, { svc, hub, controlPanelDir: "/nonexistent-cp", running: new Map() })
    .catch((e) => { try { res.writeHead(500); res.end(String(e)); } catch { /* 已结束 */ } });
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
const BASE = "http://127.0.0.1:" + PORT;
console.log("[ptc] 内核已起：" + BASE + "（真路由）");

// ── 夹具：项目 + 两个 txt（Glob 要能找到） ──
const proj = svc.projects.create({ name: "PTC 冒烟" });
writeFileSync(join(proj.path, "alpha.txt"), "alpha\n");
writeFileSync(join(proj.path, "beta.txt"), "beta\n");
const thread = svc.store.createThread({ id: "th_ptc", kind: "project", title: "PTC", projectId: proj.id });
console.log("[ptc] 项目 " + proj.path);

// ── provider 桩：按 step 回「RunScript 调用 → AttemptCompletion → 收尾文本」 ──
interface Scripted { code: string; timeout_ms?: number; language?: string }
let armed: Scripted | null = null;
let runStep = 0;
const usage = { inputTokens: 120, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

const stubProvider: Provider = {
  id: "stub-ptc",
  stream: async (opts: StreamOptions): Promise<StreamResult> => {
    // 记忆摘要那类内部调用没有工具表 —— 别把回合的步数计到它们头上
    if (!opts.tools || opts.tools.length === 0) {
      return { text: "(stub) 非回合调用", reasoning: "", toolCalls: [], usage, finishReason: "stop" };
    }
    runStep++;
    if (runStep === 1 && armed) {
      const s = armed;
      return {
        text: "", reasoning: "", usage, finishReason: "tool_calls",
        toolCalls: [{
          id: "call_ptc_" + Math.random().toString(36).slice(2, 8), type: "function",
          function: {
            name: "RunScript",
            arguments: JSON.stringify({
              code: s.code, description: "冒烟：PTC 脚本",
              ...(s.timeout_ms === undefined ? {} : { timeout_ms: s.timeout_ms }),
              ...(s.language === undefined ? {} : { language: s.language }),
            }),
          },
        }],
      };
    }
    if (runStep === 2) {
      return {
        text: "", reasoning: "", usage, finishReason: "tool_calls",
        toolCalls: [{
          id: "call_done_" + Math.random().toString(36).slice(2, 8), type: "function",
          function: { name: "AttemptCompletion", arguments: JSON.stringify({ summary: "冒烟回合结束" }) },
        }],
      };
    }
    return { text: "冒烟结束", reasoning: "", toolCalls: [], usage, finishReason: "stop" };
  },
};
svc.runtime.services.provider = stubProvider;

// ── 回合驱动：收集审批 / 工具结果，审批走**真实** POST /api/approve ──
interface Captured {
  approvals: { toolCallId: string; title: string; message: string; approved: boolean }[];
  toolResults: { tool: string; ok: boolean; error: string; result?: Record<string, unknown> }[];
  events: string[];
  runScript?: Record<string, unknown>;
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(BASE + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try { parsed = await r.json() as Record<string, unknown>; } catch { /* 非 JSON */ }
  return { status: r.status, body: parsed };
}

/** 跑一个真回合：脚本由桩 provider 作为 RunScript 调用发出，之后的审批全部自动处理 */
async function runTurn(threadId: string, userText: string, script: Scripted): Promise<Captured> {
  armed = script;
  runStep = 0;
  const cap: Captured = { approvals: [], toolResults: [], events: [] };
  const pending: Promise<unknown>[] = [];
  const sink = (e: { type: string; [k: string]: unknown }): void => {
    cap.events.push(e.type);
    if (e.type === "tool_approval") {
      const message = String(e.message ?? "");
      const toolCallId = String(e.toolCallId ?? "");
      // 只拒绝「脚本内发起的 rm」：RunScript 自己的审批消息里也含命令行（args 原文），
      // 所以必须用前缀区分，否则会把整个脚本本身拒掉
      const deny = message.startsWith(PTC_APPROVAL_PREFIX) && message.includes("rm -f");
      cap.approvals.push({ toolCallId, title: String(e.title ?? ""), message, approved: !deny });
      pending.push(post("/api/approve", { toolCallId, approved: !deny, reason: deny ? "冒烟：拒绝 rm" : undefined }));
    }
    if (e.type === "tool_result") {
      const result = e.result as Record<string, unknown> | undefined;
      cap.toolResults.push({ tool: String(e.tool ?? ""), ok: e.ok === true, error: String(e.error ?? ""), result });
      if (e.tool === "RunScript" && result) cap.runScript = result;
    }
  };
  await svc.runtime.run({ threadId, userText, projectId: proj.id, signal: AbortSignal.timeout(180_000), sink });
  await Promise.allSettled(pending);
  return cap;
}

// ─────────────────────────────────────────────────────────
console.log("\n=== ① 脚本里 doveTool('Glob') 拿到真实结果 + listTools() ===");
{
  const cap = await runTurn(thread.id, "用脚本找一下 txt 文件", {
    code: [
      "const tools = await listTools();",
      "const names = tools.map(function (t) { return t.name; });",
      "console.log('TOOLS=' + tools.length + ' CORE=' + tools.filter(function (t) { return t.layer === 'core'; }).length);",
      "console.log('HAS_RUNSCRIPT=' + names.includes('RunScript') + ' HAS_GLOB=' + names.includes('Glob'));",
      "const g = await doveTool('Glob', { pattern: '**/*.txt' });",
      "console.log('GLOB_FILES=' + JSON.stringify(g.files));",
      "console.log('GLOB_COUNT=' + g.count);",
    ].join("\n"),
  });
  const r = cap.runScript ?? {};
  const stdout = String(r.stdout ?? "");
  console.log("  stdout:\n" + stdout.split("\n").map((l) => "    | " + l).join("\n"));
  check(typeof r.stdout === "string" && r.exitCode === 0, "脚本正常退出（exitCode=0）", r);
  check(/HAS_RUNSCRIPT=false/.test(stdout), "listTools() 里没有 RunScript（脚本内不能再开脚本）", stdout.slice(0, 200));
  check(/HAS_GLOB=true/.test(stdout), "listTools() 里有 Glob（真工具表）", stdout.slice(0, 200));
  check(/TOOLS=\d+ CORE=\d+/.test(stdout), "listTools() 带 layer 字段（CORE 层数量 > 0）", stdout.slice(0, 200));
  check(/alpha\.txt/.test(stdout) && /beta\.txt/.test(stdout), "Glob 结果来自内核（真实文件）", stdout.slice(0, 300));
  const calls = (r.toolCalls ?? []) as { tool: string; ok: boolean }[];
  check(calls.length === 1 && calls[0]!.tool === "Glob" && calls[0]!.ok, "toolCalls 记下了这次调用且 ok", calls);
  check(typeof r.savedTokens === "number" && (r.savedTokens as number) > 0, "savedTokens 是正数（Glob 结果没进上下文）", r.savedTokens);
  check(cap.approvals.length === 1, "只有 RunScript 本身要审批（Glob 不需要）", cap.approvals.map((a) => a.title));
}

console.log("\n=== ② 脚本里 doveTool('Bash') 回到内核审批：批准的执行、拒绝的没执行 ===");
{
  const proof = join(proj.path, "proof.txt");
  const denyProbe = join(proj.path, "deny-probe.txt");
  writeFileSync(proof, "proof\n");
  writeFileSync(denyProbe, "这个文件不能被删掉\n");
  const cap = await runTurn(thread.id, "用脚本改一下权限，然后试着删掉探针文件", {
    code: [
      "const out = { chmodOk: false, rmDenied: false };",
      "try { await doveTool('Bash', { command: 'chmod 600 proof.txt', description: '冒烟：审批通过后真的执行' }); out.chmodOk = true; }",
      "catch (e) { out.chmodErr = String(e.message).slice(0, 200); }",
      "try { await doveTool('Bash', { command: 'rm -f deny-probe.txt', description: '冒烟：这条会被拒绝' }); }",
      "catch (e) { out.rmDenied = true; out.rmErr = String(e.message).slice(0, 200); }",
      "console.log('BASH_RESULT=' + JSON.stringify(out));",
    ].join("\n"),
  });
  const r = cap.runScript ?? {};
  const stdout = String(r.stdout ?? "");
  console.log("  stdout:\n" + stdout.split("\n").map((l) => "    | " + l).join("\n"));
  const inner = cap.approvals.filter((a) => a.message.startsWith(PTC_APPROVAL_PREFIX));
  const chmodApprovals = inner.filter((a) => a.message.includes("chmod 600"));
  const rmApprovals = inner.filter((a) => a.message.includes("rm -f"));
  console.log("  approvals 计数：总 " + cap.approvals.length + "，脚本内 " + inner.length +
    "（chmod " + chmodApprovals.length + " / rm " + rmApprovals.length + "）");
  check(cap.approvals.length === 3, "approvals 计数 = 3（RunScript 1 + 脚本内 Bash 2）", cap.approvals.map((a) => a.title));
  check(chmodApprovals.length === 1 && chmodApprovals[0]!.approved, "chmod 那条真的弹了审批并被批准", chmodApprovals);
  check(rmApprovals.length === 1 && !rmApprovals[0]!.approved, "rm 那条真的弹了审批并被拒绝", rmApprovals);
  check((statSync(proof).mode & 0o777) === 0o600, "被批准的 Bash **执行了**（proof.txt 权限变成 600）", (statSync(proof).mode & 0o777).toString(8));
  check(existsSync(denyProbe), "被拒绝的 Bash **没执行**（deny-probe.txt 还在）");
  check(/BASH_RESULT=.*"chmodOk":true/.test(stdout), "脚本看到 chmod 成功", stdout.slice(0, 300));
  check(/BASH_RESULT=.*"rmDenied":true/.test(stdout), "脚本看到 rm 被拒（抛错，不是静默放行）", stdout.slice(0, 300));
  const calls = (r.toolCalls ?? []) as { tool: string; ok: boolean; error?: string }[];
  check(calls.length === 2 && calls[0]!.ok === true && calls[1]!.ok === false,
    "toolCalls = [Bash ok, Bash 被拒]", calls);
}

console.log("\n=== ③ timeout_ms 到点杀进程 ===");
{
  const cap = await runTurn(thread.id, "跑一个会超时的脚本", {
    code: [
      "console.log('BEFORE_WAIT');",
      "await new Promise(function (r) { setTimeout(r, 60000); });",
      "console.log('AFTER_WAIT');",
    ].join("\n"),
    timeout_ms: 3000,
  });
  const r = cap.runScript ?? {};
  console.log("  " + JSON.stringify({ timedOut: r.timedOut, exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs }));
  check(r.timedOut === true, "结果里 timedOut=true（明确报错，不静默）", r);
  check(String(r.stdout ?? "").includes("BEFORE_WAIT") && !String(r.stdout ?? "").includes("AFTER_WAIT"),
    "只跑到被杀之前那一行（AFTER_WAIT 没有出现）", r.stdout);
  check(Number(r.durationMs) < 30_000, "3s 超时确实按 3s 掐掉（没等 60s）", r.durationMs);
  check(/已被终止/.test(String(r.note ?? "")), "note 里写清了「已被终止」（模型知道发生了什么）", r.note);
}

console.log("\n=== ④ 只读线程下没有 RunScript ===");
{
  const all = new Map(allTools().map((t) => [t.name, t]));
  const ro = applyThreadPolicy("project", all, { readOnly: true });
  const home = applyThreadPolicy("home", all);
  check(CORE_TOOLS.some((t) => t.name === "RunScript"), "RunScript 在 CORE（常驻）里");
  check(!ro.tools.has("RunScript") && ro.blocked.includes("RunScript"), "只读线程：裁掉 RunScript", ro.blocked);
  check(!home.tools.has("RunScript"), "Home 线程：也裁掉 RunScript（和 Bash 同档）", home.blocked);

  // 真回合：只读线程里连 RunScript 这个名字都不存在（模型调它只会拿到「未知工具」）
  const roThread = svc.store.createThread({
    id: "th_ptc_ro", kind: "project", projectId: proj.id, title: "PTC 只读", metadata: { readOnly: true },
  });
  const cap = await runTurn(roThread.id, "只读线程里试一下写脚本", {
    code: "console.log('这段不该跑起来');",
  });
  const rr = cap.toolResults.find((t) => t.tool === "RunScript");
  console.log("  只读回合的工具结果：" + JSON.stringify(rr)?.slice(0, 220));
  check(cap.events.includes("policy"), "只读回合发了 policy 事件（裁剪真的发生了）", cap.events);
  check(cap.approvals.length === 0, "RunScript 根本没走到审批（工具表里就没有它）", cap.approvals.length);
  check(!!rr && !rr.ok && /RunScript/.test(rr.error), "模型调 RunScript 拿到明确的「未知工具/不可用」错误", rr);
  check(cap.runScript === undefined, "只读线程里脚本一次都没跑起来");
}

console.log("\n=== ⑤ stdout 超限 → 落盘并回写路径 ===");
{
  const cap = await runTurn(thread.id, "打印一大段东西", {
    code: [
      "const g = await doveTool('Glob', { pattern: '*.txt' });",
      "console.log('SPILL_BEGIN' + 'x'.repeat(20000) + 'SPILL_END');",
      "console.log('GLOB_COUNT=' + g.count);",
    ].join("\n"),
  });
  const r = cap.runScript ?? {};
  const spill = String(r._spillPath ?? "");
  console.log("  spillPath = " + spill);
  check(typeof r.stdout === "string" && (r.stdout as string).length <= 1500, "返回给模型的 stdout 被裁到 1500 以内", String(r.stdout).length);
  check(!!spill && existsSync(spill), "结果里有 _spillPath 且文件真的存在", spill);
  const saved = spill && existsSync(spill) ? readFileSync(spill, "utf8") : "";
  check(saved.includes("SPILL_BEGIN") && saved.includes("SPILL_END"), "存档文件里是**完整**输出（BEGIN…END 都在）", saved.length);
  console.log("  存档大小 = " + saved.length + " 字符");
  check(/存档/.test(String(r._truncationNotice ?? "")), "_truncationNotice 告诉模型去哪儿读全文", String(r._truncationNotice).slice(0, 200));
  check(Number(r.savedTokens) > 0, "savedTokens 也记了这次的调用", r.savedTokens);
}

console.log("\n=== ⑥ 工具控制面：invoke 没凭据一律拒绝；list 只读、回环上放开 ===");
{
  const noCred = await post("/api/tools/invoke", { name: "Glob", args: { pattern: "*" } });
  const fakeCred = await post("/api/tools/invoke", { name: "Glob", args: { pattern: "*" }, session: "ptc_dead", token: "nope" });
  const listNoCred = await fetch(BASE + "/api/tools/list");
  const listBody = await listNoCred.json() as { tools?: unknown[] };
  const listFakeCred = await fetch(BASE + "/api/tools/list?session=ptc_dead&token=nope");
  console.log("  不带凭据 invoke → " + noCred.status + " " + JSON.stringify(noCred.body).slice(0, 120));
  console.log("  假凭据 invoke → " + fakeCred.status + " " + JSON.stringify(fakeCred.body).slice(0, 120));
  console.log("  不带凭据 list → " + listNoCred.status + "（" + (listBody.tools?.length ?? 0) + " 个工具）");
  console.log("  假凭据 list → " + listFakeCred.status);
  check(noCred.status === 403 && !!noCred.body.error, "不带 session/token 的 invoke 被拒（403）", noCred);
  check(fakeCred.status === 403 && !!fakeCred.body.error, "session/token 不匹配的 invoke 被拒（403）", fakeCred);
  // list 是只读元数据（模型每轮的 system prompt 里本来就有），执行才是能力 ——
  // 所以 list 在回环上不带凭据也给，`dove tools` 才能用；带了错凭据仍然拒绝。
  check(listNoCred.status === 200 && Array.isArray(listBody.tools) && listBody.tools.length > 40,
    "不带凭据的 list 给全量工具表（CLI 要用）", listBody.tools?.length);
  check(listFakeCred.status === 403, "带了错凭据的 list 仍然拒绝（403）", listFakeCred.status);
}

console.log("\n=== ⑦ 脚本等内核（审批 / 慢工具）等超时 → 明确报错，不静默 ===");
{
  // Sleep(15s) 不带审批、稳定慢：脚本的 timeout_ms=9000 → 等内核的上限被下调到 7000ms。
  // 断言的是**脚本自己先报错**（而不是被 timeout_ms 杀掉）：它还能把错误打出来给人看。
  const cap = await runTurn(thread.id, "调一个比脚本超时还慢的工具", {
    code: [
      "const t0 = Date.now();",
      "try {",
      "  await doveTool('Sleep', { seconds: 15, reason: '冒烟：比脚本的等内核上限还慢' });",
      "  console.log('SHOULD_NOT_REACH=1');",
      "} catch (e) {",
      "  console.log('WAIT_ERR_MS=' + (Date.now() - t0));",
      "  console.log('WAIT_ERR=' + String(e.message).slice(0, 160));",
      "}",
    ].join("\n"),
    timeout_ms: 9000,
  });
  const r = cap.runScript ?? {};
  const stdout = String(r.stdout ?? "");
  const waited = Number((/WAIT_ERR_MS=(\d+)/.exec(stdout) ?? [])[1] ?? 0);
  console.log("  stdout:\n" + stdout.split("\n").map((l) => "    | " + l).join("\n"));
  console.log("  " + JSON.stringify({ timedOut: r.timedOut, exitCode: r.exitCode, durationMs: r.durationMs }));
  check(r.timedOut !== true && r.exitCode === 0, "脚本不是被杀，而是自己收尾退出（exitCode=0）", { timedOut: r.timedOut, exitCode: r.exitCode });
  check(/WAIT_ERR=.*等内核超时/.test(stdout), "超时报的是「等内核超时」，带调整建议", stdout.slice(0, 400));
  check(waited >= 6000 && waited < 9000, "在剧本的等内核上限（7000ms）附近放弃，没等到 15s", waited);
  check(!/SHOULD_NOT_REACH/.test(stdout), "超时的 doveTool 真的抛了错（后面的代码没继续跑）");
  const calls = (r.toolCalls ?? []) as { tool: string; ok: boolean; error?: string }[];
  check(calls.length === 1 && calls[0]!.ok === false && /超时/.test(String(calls[0]!.error)),
    "toolCalls 记的是这次失败（ok=false）", calls);
}

console.log("\n=== ⑧ dove() 走本地 CLI：跑得通就跑，跑不通必须有清晰错误（不静默） ===");
{
  // 真 CLI 分支：仓库自带 harness/bin/dove.mjs（另一并行任务在做），它能答就答。
  const real = await runTurn(thread.id, "脚本里问一下 CLI 版本", {
    code: [
      "try { console.log('CLI_OUT=' + String(dove('version --json')).trim().slice(0, 200)); }",
      "catch (e) { console.log('CLI_ERR=' + String(e.message).slice(0, 160)); }",
    ].join("\n"),
  });
  const realOut = String((real.runScript ?? {}).stdout ?? "");
  console.log("  stdout:\n" + realOut.split("\n").map((l) => "    | " + l).join("\n"));
  // 真跑通的话，CLI 回的是 JSON（cli/kernel/port）——port 必须是**本实例**的端口：
  // 那证明 DOVE_PORT 被钉死成本进程监听的端口，脚本里的 dove() 不会打到别的内核上
  const okReal = /CLI_OUT=\{.*"cli"/.test(realOut) && realOut.includes('"port":' + PORT);
  const clearStub = /CLI_ERR=.*dove CLI 不可用/.test(realOut);
  check(okReal || clearStub, "dove() 要么真跑通（拿到 CLI JSON 且端口 = " + PORT + "），要么给出「不可用」的明确错误 —— 不许静默", realOut.slice(0, 300));
  console.log("  → " + (okReal ? "走的是真 CLI 分支" : "走的是桩分支（CLI 未上线）"));

  // 桩分支：把 DOVE_BIN 指到一个不存在的命令，必须报「dove CLI 不可用」而不是无声无息
  process.env.DOVE_BIN = "/nonexistent/dove-cli-not-installed";
  const stub = await runTurn(thread.id, "脚本里调一个不存在的 CLI", {
    code: [
      "try { console.log('CLI_UNEXPECTED=' + dove('version')); }",
      "catch (e) { console.log('CLI_ERR=' + String(e.message).slice(0, 200)); }",
    ].join("\n"),
  });
  delete process.env.DOVE_BIN;
  const stubOut = String((stub.runScript ?? {}).stdout ?? "");
  console.log("  stdout:\n" + stubOut.split("\n").map((l) => "    | " + l).join("\n"));
  check(/CLI_ERR=.*dove CLI 不可用/.test(stubOut), "CLI 不在时 dove() 明确报「不可用」（桩不静默）", stubOut.slice(0, 300));
  check(!/CLI_UNEXPECTED/.test(stubOut), "桩分支没有假装成功返回空串", stubOut.slice(0, 300));
}

console.log("\n=== ⑨ language=javascript：同一套 preamble 在 .mjs 里也跑得起来 ===");
{
  const cap = await runTurn(thread.id, "用 JavaScript 写一段脚本", {
    code: [
      "const g = await doveTool('Glob', { pattern: 'alpha.txt' });",
      "console.log('JS_OK=' + g.count);",
      "console.log('JS_TOOLS=' + (await listTools()).length);",
    ].join("\n"),
    language: "javascript",
  });
  const r = cap.runScript ?? {};
  const stdout = String(r.stdout ?? "");
  console.log("  stdout:\n" + stdout.split("\n").map((l) => "    | " + l).join("\n"));
  check(String(r.scriptPath ?? "").endsWith("script.mjs"), "language 真的生效（脚本落成 .mjs）", r.scriptPath);
  check(r.exitCode === 0, "javascript 脚本正常退出（preamble 里不能有 TS 语法）", { exitCode: r.exitCode, stderr: r.stderr });
  check(/JS_OK=1/.test(stdout), "javascript 里 doveTool 同样拿得到内核结果", stdout.slice(0, 200));
  check(/JS_TOOLS=\d+/.test(stdout), "javascript 里 listTools() 也能用", stdout.slice(0, 200));
}

console.log("\n" + (failures === 0 ? "全部通过 ✓" : failures + " 项失败 ✗"));
server.close();
finish(svc, failures === 0 ? 0 : 1);
