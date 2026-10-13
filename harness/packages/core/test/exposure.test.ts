/**
 * 暴露轴（exposure）：能力裁剪不再必然打断 provider 前缀缓存。
 *
 * 为什么要单独一个文件：这条轴横跨三处 —— agent/tool-policy.ts 定策略 → tools/registry.ts 上 wire
 * → loop/tool-exec.ts 拦执行。任何一处漏掉都是**静默失效**：模型看得见工具却没人拦它（等于没裁），
 * 或者工具在表里却永远调不动。这里把两边都钉住。
 *
 * 默认（cut）行为一个字节都不许变：新轴由 DOVE_TOOL_EXPOSURE=visible 开启，而且**必须由 runtime
 * 把「可见性」与「执行拦截」两半一起打开** —— 只开可见性就是静默放行（见下面的开关测试）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyThreadPolicy, renderPolicyNotice, executionBlockedReason, exposureModeFromEnv } from "../src/agent/tool-policy.ts";
import { allTools, registerExternalTools, wireSchemas } from "../src/tools/registry.ts";
import { executeBatch, executeOne } from "../src/loop/tool-exec.ts";
import type { ExecDeps } from "../src/loop/tool-exec.ts";
import { defineTool, S } from "../src/tools/types.ts";
import type { Tool } from "../src/tools/types.ts";
import type { ToolCallPayload } from "../src/providers/types.ts";

// 环境变量是全局状态：先清干净，免得跑测试的机器上设了 DOVE_TOOL_EXPOSURE 干扰下面开关测试的预期
delete process.env.DOVE_TOOL_EXPOSURE;

/** 目录序（CORE → SYSTEM → ON_DEMAND → EXTERNAL）的完整工具表 —— 与 runtime 交给策略的是同一份形状 */
const fullMap = () => new Map<string, Tool>(allTools().map((t) => [t.name, t]));

const call = (name: string, args: Record<string, unknown> = {}): ToolCallPayload =>
  ({ id: "c_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } });

function depsFor(tools: Map<string, Tool>, blockedFromExecution?: (n: string) => string | undefined): ExecDeps {
  return {
    tools,
    ctxBase: {
      threadId: "th_exposure", workdir: process.cwd(), outputsDir: tmpdir(),
      emit: () => { /* 测试不关心事件 */ },
      services: {},
    },
    resolveApproval: async () => ({ approved: true, decision: "allow" }),
    blockedFromExecution,
  };
}

/** 执行器侧的拦截函数 —— 与 runtime.ts 接的应该是同一个写法 */
const policyBlocker = (names: readonly string[], reason: "home" | "read-only" = "home") => {
  const set = new Set(names);
  return (n: string) => executionBlockedReason(n, set, reason);
};

const probeTool = (name: string, exposure?: Tool["exposure"]): Tool => defineTool({
  name, description: "测试用假工具（只为断言 wire 行为，不在生产表里）",
  parameters: S.obj({ q: S.str("问题") }), outputTier: "exact", approval: "never", concurrencySafe: true,
  exposure, execute: async () => ({}),
});

// ── ① 策略层：cut 与 visible 的差别只有「删不删」 ──────────────────
test("cut（缺省）：被裁工具从表里删掉，blockedFromExecution 为空", () => {
  const full = fullMap();
  const r = applyThreadPolicy("home", full);
  assert.equal(r.exposure, "cut", "缺省必须是 cut");
  assert.equal(r.reason, "home");
  assert.ok(!r.tools.has("Bash") && !r.tools.has("Write") && !r.tools.has("RunScript"));
  assert.ok(r.tools.has("Read") && r.tools.has("DispatchToProject"), "只读 + 调度能力必须留着");
  assert.ok(r.blocked.includes("Bash") && r.blocked.includes("Write"));
  assert.equal(r.tools.size, full.size - r.blocked.length, "除 blocked 之外一个都不许少");
  assert.deepEqual(r.blockedFromExecution, [], "cut 下工具根本不在表里，执行器不需要拦");
});

test("visible：工具留在表里（连顺序都不动），blocked 与 blockedFromExecution 一致", () => {
  const full = fullMap();
  const r = applyThreadPolicy("home", full, { exposure: "visible" });
  assert.equal(r.exposure, "visible");
  assert.equal(r.tools.size, full.size, "visible 下一个工具都不许删 —— 删了前缀缓存就整段失效");
  assert.deepEqual([...r.tools.keys()], [...full.keys()], "顺序也必须一字不变（registry 顶部的缓存纪律）");
  assert.ok(r.tools.has("Bash") && r.tools.has("Write"), "写类工具必须还在表里 —— 只是执行不了");
  assert.ok(r.blocked.includes("Bash") && r.blocked.includes("Write"), "blocked 仍要列出它们（提示词与日志用）");
  assert.ok(r.blockedFromExecution.length > 0);
  assert.deepEqual([...r.blockedFromExecution].sort(), [...r.blocked].sort());
});

test("visible + 只读：更严的名单（Task/SendMessage/Cron*）同样只拦不删", () => {
  const full = fullMap();
  const r = applyThreadPolicy("project", full, { readOnly: true, exposure: "visible" });
  assert.equal(r.reason, "read-only");
  assert.equal(r.tools.size, full.size);
  for (const n of ["Bash", "Write", "Task", "SendMessage", "CronCreate"]) {
    assert.ok(r.tools.has(n), n + " 应留在表里");
    assert.ok(r.blockedFromExecution.includes(n), n + " 必须被拦");
  }
});

test("没有裁剪时两边都不受影响：工具表原样返回", () => {
  const full = fullMap();
  const r = applyThreadPolicy("project", full, { exposure: "visible" });
  assert.equal(r.tools, full, "没裁剪就不该复制 Map（历史行为）");
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.blockedFromExecution, []);
  assert.equal(r.reason, "none");
});

test("DOVE_TOOL_EXPOSURE 是开关：只认字面量 visible；且它**自己**不会让策略变 visible（防半接线）", () => {
  assert.equal(exposureModeFromEnv("visible"), "visible");
  for (const v of [undefined, "", "cut", "VISIBLE", "yes", "1"]) {
    assert.equal(exposureModeFromEnv(v), "cut", "取值不是字面量 visible 就必须保守回落");
  }
  // ⚠️ 关键的一半：可见性（工具留在表里）与执行拦截是一对，必须由 runtime **原子地**一起打开。
  //    环境变量单独生效 = 写类工具留在表里、又没人拦 = 静默把权限关掉，所以这里守着它。
  process.env.DOVE_TOOL_EXPOSURE = "visible";
  try {
    const notWired = applyThreadPolicy("home", fullMap());
    assert.equal(notWired.exposure, "cut");
    assert.ok(!notWired.tools.has("Bash"), "没人接执行侧时，环境变量也不许把写类工具放上表");
    // 接线之后（runtime 把 exposureModeFromEnv() 的结果传进来）：新轴才打开，且两半同时到位
    const wired = applyThreadPolicy("home", fullMap(), { exposure: exposureModeFromEnv() });
    assert.equal(wired.exposure, "visible");
    assert.ok(wired.tools.has("Bash") && wired.blockedFromExecution.includes("Bash"));
  } finally { delete process.env.DOVE_TOOL_EXPOSURE; }
});

// ── ② 提示词：措辞必须与行为一致 ──────────────────────────────
test("提示词：visible 的措辞不许说「不存在」（工具真在表里）", () => {
  const blocked = ["Write", "Edit", "Bash"];
  const cut = renderPolicyNotice("home", blocked, ["proj-a"], "home", "cut");
  const vis = renderPolicyNotice("home", blocked, ["proj-a"], "home", "visible");
  assert.ok(cut.includes("写类工具（Write、Edit、Bash）在你的工具表里**不存在**。"), "cut 的这句话是既有行为，一字不动");
  assert.doesNotMatch(cut, /存在但不可执行/);
  assert.notEqual(cut, vis, "两种模式的文案必须不同");
  assert.doesNotMatch(vis, /不存在/, "工具还在 wire 上，说「不存在」就是假话");
  assert.match(vis, /存在但不可执行/);
  assert.match(vis, /DispatchToProject/, "替代路径（派活）的意图要保留");
  assert.match(vis, /不要拿其中一个去绕另一个/, "visible 下还要堵住「用 Bash 绕 Write」这条路");

  const roCut = renderPolicyNotice("project", blocked, [], "read-only", "cut");
  const roVis = renderPolicyNotice("project", blocked, [], "read-only", "visible");
  assert.doesNotMatch(roCut, /存在但不可执行/);
  assert.doesNotMatch(roVis, /不存在/);
  assert.match(roVis, /存在但不可执行/);
  assert.match(roVis, /停下来问用户/, "只读的既有意图（不许自作主张）要保留");
  assert.equal(renderPolicyNotice("home", [], ["p"], "home", "visible"), "", "没裁掉东西就不该有提示");
});

test("executionBlockedReason：只对命中名字给理由，且明说「不是不存在」", () => {
  const set = new Set(["Bash", "Write"]);
  assert.equal(executionBlockedReason("Read", set, "home"), undefined);
  assert.equal(executionBlockedReason("Bash", set, "none"), undefined, "reason=none 时没有策略可谈");
  const home = executionBlockedReason("Bash", set, "home")!;
  assert.match(home, /权限策略/);
  assert.match(home, /不是不存在/);
  assert.doesNotMatch(home, /未知工具/);
  assert.match(home, /DispatchToProject/);
  const ro = executionBlockedReason("Write", set, "read-only")!;
  assert.match(ro, /只读/);
  assert.match(ro, /说明需要什么改动/);
});

// ── ③ 执行器：visible 下拦得住，cut 下照旧「未知工具」 ─────────────
test("执行器：visible 下 Bash 被拦成 ok:false（不是「未知工具」，也不置 denied）", async () => {
  const full = fullMap();
  const vis = applyThreadPolicy("home", full, { exposure: "visible" });
  const deps = depsFor(vis.tools, policyBlocker(vis.blockedFromExecution));
  const out = await executeOne(call("Bash", { command: "echo dove-exposure" }), deps);
  assert.equal(out.ok, false);
  assert.match(String(out.errorText), /权限策略/);
  assert.doesNotMatch(String(out.errorText), /未知工具/);
  assert.notEqual(out.denied, true, "置了 denied 会让闸门③（权限续跑）把回合重新拉起来");

  // 别名 / 小写会被 repair 成真名（shell → Bash）—— 修完必须再拦一次，否则这是条绕过路
  const aliased = await executeOne(call("shell", { command: "echo dove-exposure" }), deps);
  assert.equal(aliased.ok, false, "别名绕不过去");
  assert.match(String(aliased.errorText), /权限策略/);

  // 反向：没被裁的工具在 visible 下必须照常执行（别把整张表都拦了）
  const dir = mkdtempSync(join(tmpdir(), "dove-exposure-"));
  const file = join(dir, "note.txt");
  writeFileSync(file, "hello-exposure");
  const ok = await executeOne(call("Read", { file_path: file }), deps);
  assert.equal(ok.ok, true, "visible 只拦被裁名单里的工具");
});

test("对照：cut 模式下同一调用仍是既有的「未知工具」", async () => {
  const cut = applyThreadPolicy("home", fullMap());
  // ⚠️ 要连 BashOutput 一起拿掉：repair 的模糊匹配里 canonName("BashOutput") 以 "bash" 开头，
  //    只删 Bash 的话，一个叫 "Bash" 的调用会被静默「修好」成 BashOutput（那是另一个真工具）——
  //    这条既有行为不是本轴引入的，但会把对照测试带偏。
  const tools = new Map([...cut.tools].filter(([n]) => n !== "BashOutput"));
  const out = await executeOne(call("Bash", { command: "echo x" }), depsFor(tools));
  assert.equal(out.ok, false);
  assert.match(String(out.errorText), /未知工具/);
  assert.doesNotMatch(String(out.errorText), /权限策略/);
});

test("调度：被拦的调用不进调度、一次都不执行，也不拖住同批其它调用", async () => {
  let ran = 0;
  const probe = defineTool({
    name: "DoveProbeWrite", description: "测试用假写工具", parameters: S.obj({ file_path: S.str("路径") }, ["file_path"]),
    outputTier: "exact", approval: "never", concurrencySafe: false,
    accesses: (args) => ({ kind: "paths", paths: [{ path: String(args.file_path ?? "x"), operation: "write" }] }),
    execute: async () => { ran++; return { wrote: true }; },
  });
  const vis = applyThreadPolicy("home", new Map([...fullMap(), [probe.name, probe]]), { exposure: "visible" });
  const deps = depsFor(vis.tools, policyBlocker([...vis.blockedFromExecution, probe.name]));
  const dir = mkdtempSync(join(tmpdir(), "dove-exposure-batch-"));
  const file = join(dir, "note.txt");
  writeFileSync(file, "batch");
  const out = await executeBatch([
    call("DoveProbeWrite", { file_path: join(dir, "w.txt") }),
    call("Read", { file_path: file }),
  ], deps);
  assert.equal(out.length, 2);
  assert.equal(ran, 0, "被拦的工具一次都不许执行");
  assert.equal(out[0]!.ok, false);
  assert.match(String(out[0]!.errorText), /权限策略/);
  assert.equal(out[1]!.ok, true, "同批的其它调用照常执行（结果仍按调用顺序回填）");
});

// ── ④ 注册表：hidden 不上 wire，其余档位保持现状 ────────────────
test("registry：exposure=hidden 不上 wire；缺省（无 exposure）行为一字不变", () => {
  registerExternalTools([probeTool("DoveHiddenProbe", "hidden"), probeTool("DoveVisibleProbe")]);
  try {
    assert.deepEqual(
      // 顺序照目录序（CORE → … → EXTERNAL），不是 limitTo 的传入序
      wireSchemas(["DoveHiddenProbe", "DoveVisibleProbe", "Read"]).map((s) => s.function.name),
      ["Read", "DoveVisibleProbe"],
      "hidden 必须被滤掉（显式点名也不行）；没写 exposure 的工具原样上表",
    );
    assert.deepEqual(
      wireSchemas(["Read", "Write", "Bash"]).map((s) => s.function.name),
      ["Read", "Write", "Bash"],
      "默认档位（direct）的上表内容与顺序不许有任何变化",
    );
  } finally { registerExternalTools([]); }
  const names = wireSchemas().map((s) => s.function.name);
  assert.ok(names.includes("Read") && names.includes("Bash") && names.includes("CurrentTime"),
    "清掉外部工具后 activeTools() 这条路一个工具都没少");
});
