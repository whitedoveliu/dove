/**
 * 原生「选择文件夹」（packages/server/src/legacy/folder-picker.ts）—— 每条出口都必须**可读**。
 *
 * 为什么值得单独测：这条链坏过一次，症状是「点了没反应」——
 *   桌面壳里 Tauri 命令被 ACL 拒（面板是远程源，capabilities 没写 remote.urls）
 *   → 退到内核的桩路由（永远返回「没有原生选择器」）
 *   → 面板 `if (!picked.success) return` 吞掉 → 用户看不到任何东西。
 * 所以这里钉的是：成功给路径、取消给 cancelled、其余每种失败都要有 message；
 * 空输出**不许**当成功（那是最阴的一种假成功）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickFolder, type PickRunner } from "../../server/src/legacy/folder-picker.ts";

/**
 * **平台显式钉成 darwin**：不传平台会吃宿主 process.platform —— Linux CI 上每一条都会走进
 * 「非 darwin」分支（这条真被 CI 抓过一次，红在 assertion 上）。
 * 非 darwin 那条用例自己传 "linux"。
 */
const pick = (runner: PickRunner, platform: NodeJS.Platform = "darwin") => pickFolder(runner, platform);

const runnerOf = (r: { code: number; stdout?: string; stderr?: string }): PickRunner =>
  async () => ({ code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });

test("成功：osascript 打印的 POSIX 路径原样给出（首尾空白去掉）", async () => {
  const r = await pick(runnerOf({ code: 0, stdout: "/Users/me/我的 项目\n" }));
  assert.equal(r.success, true);
  assert.equal(r.path, "/Users/me/我的 项目");
  assert.equal(r.cancelled, undefined);
});

test("取消：AppleScript 的 -128 → cancelled:true（面板据此静默返回）", async () => {
  for (const stderr of [
    "execution error: User canceled. (-128)",
    "execution error: 用户已取消。(-128)",
  ]) {
    const r = await pick(runnerOf({ code: 1, stderr }));
    assert.equal(r.success, false);
    assert.equal(r.cancelled, true, stderr);
  }
});

test("空输出：退出码 0 但没有路径 —— **不许**当成功，要给可读原因", async () => {
  const r = await pick(runnerOf({ code: 0, stdout: "   \n" }));
  assert.equal(r.success, false);
  assert.equal(r.path, undefined);
  assert.ok((r.message ?? "").length > 0, "必须有 message");
  assert.equal(r.cancelled, undefined, "空输出不是「用户取消」");
});

test("超时：被我们杀掉（code -2）→ 失败 + 提示再点一次", async () => {
  const r = await pick(runnerOf({ code: -2, stderr: "" }));
  assert.equal(r.success, false);
  assert.match(r.message ?? "", /超时/);
});

test("起不来（spawn ENOENT）：原因原样带出来，不是「退出码 1」这种废话", async () => {
  const r = await pick(runnerOf({ code: 1, stderr: "spawn osascript ENOENT" }));
  assert.equal(r.success, false);
  assert.match(r.message ?? "", /ENOENT/);
});

test("非 darwin：不假装能选，直接说清楚要手动给路径（且不调用 runner）", async () => {
  let called = false;
  const r = await pick(async () => { called = true; return { code: 0, stdout: "/x", stderr: "" }; }, "linux");
  assert.equal(r.success, false);
  assert.equal(called, false, "非 darwin 不该真去跑 osascript");
  assert.match(r.message ?? "", /linux/);
});

test("单飞：同一个选择框没关之前，第二次点击立刻拿到「已经有一个在等你」", async () => {
  let release!: (v: { code: number; stdout: string; stderr: string }) => void;
  const pending = new Promise<{ code: number; stdout: string; stderr: string }>((res) => { release = res; });
  const first = pick(() => pending);
  const second = await pick(runnerOf({ code: 0, stdout: "/不该走到这" }));
  assert.equal(second.success, false);
  assert.match(second.message ?? "", /已经有一个/);
  release({ code: 0, stdout: "/Users/me/picked", stderr: "" });
  const r = await first;
  assert.equal(r.success, true);
  assert.equal(r.path, "/Users/me/picked");
  // 解锁后单飞状态要复位：下一次还能正常弹
  const again = await pick(runnerOf({ code: 0, stdout: "/Users/me/second", stderr: "" }));
  assert.equal(again.path, "/Users/me/second");
});
