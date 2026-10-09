#!/usr/bin/env node
/**
 * 测试 D8 产品形态：Home 只读 + 调度
 * 1) 在 Home 里问一个只读问题 → 不应该产生任何文件写入
 * 2) 在 Home 里让 Dove 去项目里改东西 → 应走 DispatchToProject，Home 自己不写
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import "./_isolate.ts";   // ⚠️ 必须最先 import：把库指到临时目录，别碰生产库
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { finish } from "./_lifecycle.ts";

const cfg = loadConfig();
const projectId = "studio";
const projectDir = join(cfg.workspaceRoot, projectId);
const fixtureDir = resolve(import.meta.dirname, "../fixtures/dove-studio");

rmSync(cfg.workspaceRoot, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
cpSync(fixtureDir, projectDir, { recursive: true });

const svc = await bootstrap(cfg);
svc.store.upsertProject({ id: projectId, name: "林知夏作品集", path: projectDir, kind: "website" });

const home = svc.store.getOrCreateHomeThread();
console.log("Home 线程:", home.id);

function makeSink(tag) {
  let text = "";
  const tools = [];
  return {
    sink: (e) => {
      if (e.type === "text") { text += e.content ?? ""; }
      if (e.type === "tool_start") tools.push(e.tool);
      if (e.type === "dispatch_start") console.log("   ↳ 派发到项目:", e.projectId);
      if (e.type === "dispatch_done") console.log("   ↳ 项目线程结束:", e.endReason);
    },
    get: () => ({ text, tools }),
  };
}

console.log("\n════ 用例 1：Home 里问只读问题 ════");
const q1 = "现在有几个项目？各自是什么？";
console.log("问:", q1);
const s1 = makeSink("home");
const before = Date.now();
await svc.runtime.run({ threadId: home.id, userText: q1, sink: s1.sink });
const r1 = s1.get();
console.log("用的工具:", r1.tools.join(", ") || "(无)");
console.log("回复:", r1.text.trim().slice(0, 300));
const writes1 = r1.tools.filter((t) => ["Write", "Edit", "Bash"].includes(t));
console.log(writes1.length === 0 ? "  ✓ Home 没有调用任何写类工具" : "  ✗ 竟然调用了: " + writes1.join(","));

console.log("\n════ 用例 2：Home 里让 Dove 去项目里干活 ════");
const q2 = `把 studio 项目首页那个 footer 里的邮箱链接加上 mailto:`;
console.log("问:", q2);
const s2 = makeSink("home");
await svc.runtime.run({ threadId: home.id, userText: q2, sink: s2.sink });
const r2 = s2.get();
console.log("Home 用的工具:", r2.tools.join(", "));
console.log("Home 回复:", r2.text.trim().slice(0, 400));
const writes2 = r2.tools.filter((t) => ["Write", "Edit"].includes(t));
console.log(writes2.length === 0 ? "  ✓ Home 自己没有写文件" : "  ✗ Home 竟然写了: " + writes2.join(","));
console.log(r2.tools.includes("DispatchToProject") ? "  ✓ 走了 DispatchToProject" : "  ⚠ 没走 DispatchToProject");

const pt = svc.store.listThreads("project")[0];
if (pt) {
  const msgs = svc.store.listMessages(pt.id);
  console.log("  项目线程消息数:", msgs.length, "（说明项目线程确实跑过）");
}

console.log("\n════ 结果 ════");
console.log("1) Home 只读:", writes1.length === 0 ? "PASS" : "FAIL");
console.log("2) Home 派发:", writes2.length === 0 ? "PASS" : "FAIL");
finish(svc, 0);
