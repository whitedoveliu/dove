/**
 * 内置 hook 预设的回归：秘密路径的**全域兜底**
 *
 * 这条兜底覆盖的正是「没有护栏的那一类」—— MCP 工具（第三方文件系统 server 完全可能读任意路径）、
 * 用户自定义工具、以及将来忘了接护栏的新内置工具。
 * 同时它**必须不碰**已经有自己那套处理的工具：Read/Glob/Grep 是硬拒或过滤结果，
 * 在这里再 veto 一次会把「过滤掉敏感命中、其余照常返回」变成「整次调用失败」—— 那是变差。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHookRegistry } from "../src/loop/hooks.ts";
import { registerSecretPathGuard } from "../src/agent/hook-presets.ts";

function fireWith(toolName: string, args: Record<string, unknown>) {
  const hooks = createHookRegistry();
  registerSecretPathGuard(hooks);
  return hooks.fire("beforeToolExecute", { turn: 1, step: 1, toolName, args, call: { id: "c1" } });
}

test("兜底：MCP / 用户工具的敏感路径参数被 veto，理由指名规则", async () => {
  const r = await fireWith("mcp__fs__read_file", { path: "/Users/x/.ssh/id_rsa" });
  assert.ok(r.vetoed, "应当被拦下，实际：" + JSON.stringify(r));
  assert.match(String(r.vetoed), /敏感|凭据|私钥/);
  const r2 = await fireWith("MyCustomTool", { target: "/proj/.env" });
  assert.ok(r2.vetoed, ".env 也要拦");
});

test("兜底：嵌套数组/对象里的路径同样会被扫到", async () => {
  const r = await fireWith("mcp__fs__multi", { files: [{ p: "ok.txt" }, { p: "~/.aws/credentials" }] });
  assert.ok(r.vetoed, "嵌套一层就漏了，实际：" + JSON.stringify(r));
});

test("兜底：不碰已经有自己那套处理的工具（避免把「过滤」变成「整次失败」）", async () => {
  for (const name of ["Read", "Glob", "Grep", "ReadImage", "Present", "Bash", "TerminalSend", "RunScript", "Skill"]) {
    const r = await fireWith(name, { file_path: "/Users/x/.ssh/id_rsa", command: "cat ~/.aws/credentials" });
    assert.equal(r.vetoed, undefined, `${name} 不该被这条兜底拦（它有自己的路径）`);
  }
});

test("兜底：普通参数安静通过，不误伤", async () => {
  for (const args of [{ path: "src/index.ts" }, { path: "/tmp/x/notes.pem.md" }, { n: 1 }, { text: "读一下 README" }]) {
    const r = await fireWith("mcp__fs__read_file", args);
    assert.equal(r.vetoed, undefined, "误伤了：" + JSON.stringify(args));
  }
});

test("veto 真的短路：它后面的监听者不会跑", async () => {
  const hooks = createHookRegistry();
  registerSecretPathGuard(hooks);
  let laterRan = false;
  hooks.register("beforeToolExecute", () => { laterRan = true; return undefined; }, { id: "later" });
  const r = await hooks.fire("beforeToolExecute", { turn: 1, step: 1, toolName: "mcp__fs__read_file", args: { path: "/Users/x/.ssh/id_rsa" } });
  assert.ok(r.vetoed);
  assert.equal(laterRan, false, "veto 之后不该继续往下跑");
});
