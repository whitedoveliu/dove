/**
 * P0 能力测试（子代理控制面 / 定时任务 / 上下文余量 / 看图链路）
 *
 * 为什么单独一个文件：core.test.ts 已经贴着 400 行硬约束。
 * 这里的重点是**真实路径**，不是纯函数：
 *  - 看图：真实渲染 PNG → ReadImage → ImageRelay 落库 → convertMessages / toWireHistory 装配
 *    → 断言最终出现 image_url content block（还断言 assistant.tool_calls 与 role:"tool" 仍然配对）；
 *  - 子代理：真实 Store + TaskRegistry + 真正的 runSubagent 循环（只有一个假 provider）；
 *  - cron：真实 CronScheduler + makeCronOps 端口，含一次真实触发；
 *  - 上下文：真实 makeContextStats（与 compact.ts 同一套阈值口径）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { EventLog } from "../src/session/event-log.ts";
import { PendingRegistry } from "../src/agent/pending.ts";
import { SteeringQueue } from "../src/loop/steering.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { SubagentHost } from "../src/agent/subagent-host.ts";
import { TaskRegistry } from "../src/agents/task-registry.ts";
import { makeContextStats, compactThresholdFor } from "../src/agent/context-stats.ts";
import { allTools, getTool } from "../src/tools/registry.ts";
import { convertMessages } from "../src/context/convert.ts";
import { toWireHistory } from "../src/agent/wire-history.ts";
import { hydrateImages, MAX_IMAGE_BYTES } from "../src/context/images.ts";
import { renderTextImage } from "../src/activity/ocr.ts";
import { CronScheduler } from "../src/scheduler/cron.ts";
import { makeCronOps } from "../src/scheduler/cron-ops.ts";
import { defineTool, S } from "../src/tools/types.ts";
import type { Tool, ToolContext, ToolServices } from "../src/tools/types.ts";
import type { ChatMessage, ContentBlock, Provider, StreamOptions, StreamResult } from "../src/providers/types.ts";

const zeroUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

function streamResult(text: string, toolCalls: StreamResult["toolCalls"] = []): StreamResult {
  return { text, reasoning: "", toolCalls, usage: { ...zeroUsage }, finishReason: toolCalls.length > 0 ? "tool_calls" : "stop" };
}

function hasImageBlock(msgs: ChatMessage[]): string | undefined {
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type === "image_url" && b.image_url?.url) return b.image_url.url;
    }
  }
  return undefined;
}

function ctxWith(services: ToolServices): ToolContext {
  return {
    toolCallId: "call-1", threadId: "th-test", workdir: process.cwd(), outputsDir: tmpdir(),
    emit: () => { /* 测试不关心事件 */ },
    requestApproval: async () => ({ approved: true, decision: "allow" }),
    services,
  };
}

function tempDir(tag: string): string { return mkdtempSync(join(tmpdir(), "dove-p0-" + tag + "-")); }

// ── 1. ReadImage：真实读取 → 落库 → 装配出 image_url ─────────────
test("ReadImage：真实 PNG 走完整链路，模型最终看到 image_url block", async () => {
  const dir = tempDir("img");
  const png = join(dir, "line.png");
  const rendered = await renderTextImage(png, "DOVE-42");
  assert.ok(rendered.ok, "renderTextImage 失败，真实图像链路无法验证：" + (rendered.error ?? "未知"));

  // 假 provider：第一步要求 ReadImage，之后的每一步检查「有没有收到图」
  let step = 0;
  let imageUrl: string | undefined;
  const provider: Provider = {
    id: "stub-image",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      step++;
      const seen = hasImageBlock(opts.messages);
      if (seen) imageUrl = seen;
      if (step === 1) {
        return streamResult("", [{
          id: "call_img", type: "function",
          function: { name: "ReadImage", arguments: JSON.stringify({ file_path: png }) },
        }]);
      }
      return streamResult(seen ? "我看到了图片。" : "还没看到图。");
    },
  };

  const db = new Db(":memory:");
  const store = new Store(db);
  const tools = new Map<string, Tool>(allTools().map((t) => [t.name, t]));
  const runtime = new AgentRuntime({
    provider, store, tools,
    eventLog: new EventLog({ dir: tempDir("log") }),
    pending: new PendingRegistry(), steering: new SteeringQueue(),
    assemble: async () => ({ systemPrompt: "测试", tailContext: "", memoriesBlock: "", dualSystem: false }),
  });
  store.createThread({ id: "th_img", kind: "project", title: "看图" });
  await runtime.run({ threadId: "th_img", userText: "看看这张图里写了什么", sink: () => { /* 忽略 */ } });

  // ① 模型在**同一轮**就看到了图（下一步注入）
  assert.ok(imageUrl, "模型始终没收到 image_url block");
  assert.match(imageUrl!, /^data:image\/png;base64,/);
  // ② 落库：图片作为一条 user 消息进了库里，且存的是**路径引用**不是 base64
  const msgs = store.listMessages("th_img");
  const imgMsg = msgs.find((m) => m.parts.some((p) => p.type === "image"));
  assert.ok(imgMsg, "库里没有带 image part 的消息");
  assert.equal(String((imgMsg!.parts.find((p) => p.type === "image") as { url: string }).url), png);
  assert.ok(!JSON.stringify(msgs).includes("base64,"), "库里不该出现 base64（引用只在装配时水化）");
  // ③ convertMessages 装配：image_url block + 引用重水化
  const wire = convertMessages(msgs, {
    resolveImageUrl: (url) => hydrateImages([url]).blocks[0]?.image_url?.url,
  });
  assert.ok(hasImageBlock(wire), "convertMessages 没装配出 image_url");
  // ④ 配对纪律：assistant.tool_calls 与 role:"tool" 数量一致
  const calls = wire.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []).length;
  const results = wire.filter((m) => m.role === "tool").length;
  assert.equal(calls, results, "tool_calls 与 tool 结果必须配对");
  assert.equal(typeof wire.find((m) => m.role === "tool")!.content, "string", "role:tool 的 content 必须是字符串");
  // ⑤ 真实运行路径（runtime 用的是 toWireHistory，不是 convertMessages）
  const realWire = toWireHistory(msgs, "", "th_img", true);
  assert.ok(hasImageBlock(realWire), "toWireHistory（真实装配路径）没装配出 image_url");

  console.log("  证据：image_url 前缀 " + String(imageUrl).slice(0, 30)
    + " | 落库消息 " + msgs.length + " 条 | convertMessages " + wire.length + " 条 | 配对 " + calls + "=" + results);
  db.close();
});

test("ReadImage：文件不存在 / 格式不支持 / 超过上限 → 结构化错误，不抛", async () => {
  const dir = tempDir("img-err");
  const tool = getTool("ReadImage")!;
  const ctx = ctxWith({});

  const missing = await tool.execute({ file_path: join(dir, "nope.png") }, ctx);
  assert.equal(missing.attached, false);
  assert.match(String(missing.error), /文件不存在/);

  const txt = join(dir, "note.txt");
  writeFileSync(txt, "not an image");
  const badType = await tool.execute({ file_path: txt }, ctx);
  assert.match(String(badType.error), /不支持的图片格式/);
  assert.deepEqual(badType.supported, [".png", ".jpg", ".jpeg", ".webp", ".gif"]);

  const big = join(dir, "big.png");
  writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 4096, 7));
  const tooBig = await tool.execute({ file_path: big }, ctx);
  assert.match(String(tooBig.error), /图片过大/);
  // 同一张图在装配侧也必须被拒（两处必须共用一个上限，否则「工具说读到了、装配时静默跳过」）
  const hydrated = hydrateImages([big]);
  assert.equal(hydrated.blocks.length, 0);
  assert.match(hydrated.notes.join(" "), /超过单图上限/);

  const noService = await tool.execute({ file_path: txt }, ctxWith({}));
  assert.ok(noService.error, "没有服务时也要有结构化错误");
});

// ── 2. 子代理控制面：注入 / 中断 / 续跑 ─────────────────────────
/** 轮询等待（不 sleep 固定时长，避免 flaky） */
async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

test("子代理控制面：追加消息真注入、中断只掐一个、结束后能续跑", async () => {
  const db = new Db(":memory:");
  const store = new Store(db);
  const tasks = new TaskRegistry(db);
  store.createThread({ id: "th_parent", kind: "project", title: "父线程" });

  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve = (): void => { /* 占位 */ };
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  };
  let gate = deferred();
  let hold = true;
  let seenInjected = "";

  // ⚠️ 工具名必须在 GENERAL_PURPOSE_TOOLS 白名单里（子代理的工具表会被 runSubagent 过滤），
  //    所以这里借用 "Read" 这个名字。
  const HoldTool = defineTool({
    name: "Read", description: "测试用：卡住直到放行或被中断", parameters: S.obj({}), outputTier: "exact",
    approval: "never", concurrencySafe: false,
    execute: async (_input, ctx) => {
      if (hold) {
        // ⚠️ 已经 abort 的 signal **不会**补发 abort 事件 —— 不先查一次就会永远卡住。
        //    （这条写错时子代理永远收不了尾，还会留下一个 10 分钟的工具超时定时器把进程钉住）
        if (!ctx.signal?.aborted) {
          await Promise.race([
            gate.promise,
            new Promise<void>((r) => ctx.signal?.addEventListener("abort", () => r(), { once: true })),
          ]);
        }
      }
      return { ok: true, aborted: ctx.signal?.aborted === true };
    },
  });

  const provider: Provider = {
    id: "stub-subagent",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      const injected = opts.messages
        .filter((m) => m.role === "user" && typeof m.content === "string" && String(m.content).includes("补充："))
        .map((m) => String(m.content));
      if (injected.length > 0) seenInjected = injected[injected.length - 1]!;
      // 每次运行先调一次工具（占住时间），拿到工具结果后才给结论
      if (!opts.messages.some((m) => m.role === "tool")) {
        return streamResult("", [{
          id: "call_hold", type: "function",
          function: { name: "Read", arguments: JSON.stringify({ file_path: "hold" }) },
        }]);
      }
      return streamResult("结论：完成了" + (seenInjected ? "（看到了补充消息）" : ""));
    },
  };

  const host = new SubagentHost({
    provider, model: "deepseek-flash", tools: new Map<string, Tool>([[HoldTool.name, HoldTool]]),
    execDeps: {
      ctxBase: { threadId: "th_parent", workdir: process.cwd(), outputsDir: tmpdir(), emit: () => { /* 忽略 */ }, services: {} },
      resolveApproval: async () => ({ approved: true }),
    },
    store, tasks, parentThreadId: "th_parent", sink: () => { /* 忽略 */ }, services: {},
  });

  // 后台派一个：立刻能列出来，状态 running、background=true、带 taskId
  const a = await host.spawn("做点慢活", "慢任务", true);
  assert.equal(a.status, "running");
  assert.ok(a.taskId, "后台派活应当返回 taskId");
  const rowA = host.list().find((x) => x.taskId === a.taskId);
  assert.ok(rowA, "ListAgents 看不到刚派的子代理");
  assert.equal(rowA!.status, "running");
  assert.equal(rowA!.background, true);
  assert.ok(rowA!.startedAt > 0);
  assert.ok(await waitFor(() => host.list().some((x) => x.id === rowA!.id && x.status === "running")));

  // 运行中追加 → 真注入（子代理下一步读到）
  const injected = await host.send(rowA!.id, "补充：请顺便报一下时间");
  assert.equal(injected.mode, "injected");
  gate.resolve();
  assert.ok(await waitFor(() => host.list().find((x) => x.id === rowA!.id)?.status !== "running"), "子代理没有跑完");
  assert.match(seenInjected, /补充：请顺便报一下时间/, "注入的消息没有被子代理读到");

  // 结束后追加 → 带着旧结论新起一个子代理续跑
  hold = false;
  const resumed = await host.send(rowA!.id, "再补一个点");
  assert.equal(resumed.mode, "resumed");
  assert.match(String(resumed.output), /结论：完成了/, "续跑没有产出结论");
  assert.notEqual(resumed.subagentId, rowA!.id, "续跑应当是新的子代理");

  // 中断：只掐一个，兄弟不受影响
  hold = true;
  gate = deferred();
  const b = await host.spawn("另一个慢活", "慢任务2", true);
  const rowB = host.list().find((x) => x.taskId === b.taskId)!;
  // interrupt() 只承诺「信号已发出」；真正停下要等它收尾 —— 这里断言的是**真的停了**
  const stopped = host.interrupt(rowB.id);
  assert.equal(stopped.ok, true);
  assert.ok(await waitFor(() => host.list().find((x) => x.id === rowB.id)?.status === "canceled"),
    "被中断的子代理状态应当是 canceled，实际 " + String(host.list().find((x) => x.id === rowB.id)?.status));
  assert.ok(host.list().find((x) => x.id === rowB.id)?.finishedAt, "被中断的子代理应当有结束时间");
  assert.equal(host.list().find((x) => x.id === rowA!.id)?.status, "done", "中断不应影响别的子代理");
  // 已经停下来的子代理可以续跑（走 resumed）
  hold = false;
  const afterStop = await host.send(rowB.id, "把已经查到的部分接着做完");
  assert.equal(afterStop.mode, "resumed");

  // 边界：重复中断 / 不存在的 id → 结构化错误
  assert.equal(host.interrupt(rowB.id).ok, false);
  const ghost = host.interrupt("sub_不存在");
  assert.equal(ghost.ok, false);
  assert.match(String(ghost.error), /找不到/);
  const ghostSend = await host.send("sub_不存在", "喂");
  assert.equal(ghostSend.ok, false);

  console.log("  证据：列表 " + host.list().length + " 条 | 注入=" + injected.mode
    + " | 续跑=" + resumed.mode + " | 中断后=" + String(host.list().find((x) => x.id === rowB.id)?.status));
  db.close();
});

// ── 3. 定时任务：CronCreate / CronList / CronDelete ─────────────
test("定时任务：三种类型 + 两种模式 + 真实触发一次", async () => {
  const dir = tempDir("cron");
  const db = new Db(":memory:");
  const ran: string[] = [];
  const sched = new CronScheduler({ db, configDir: dir, run: async (job) => { ran.push(job.name); return "跑了"; } });
  const ctx = ctxWith({ cron: makeCronOps(sched) });

  const created = await getTool("CronCreate")!.execute(
    { name: "早报", type: "every", schedule: "1h", prompt: "报时", mode: "isolated" }, ctx);
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.type, "every");
  assert.equal(created.mode, "isolated");
  assert.ok(String(created.next_run_at).length > 0, "应给出下次触发时间");

  // type 省略 → 推断（5 段 → cron）
  const inferred = await getTool("CronCreate")!.execute({ name: "工作日早报", schedule: "0 9 * * 1-5", prompt: "早报" }, ctx);
  assert.equal(inferred.ok, true);
  assert.equal(inferred.type, "cron");
  assert.match(String(inferred.type_inferred), /cron/);
  assert.equal(inferred.mode, "main", "默认模式是 main");

  // 非法 type / mode → 结构化错误（不能静默回落）
  const badType = await getTool("CronCreate")!.execute({ schedule: "1h", prompt: "x", type: "weekly" }, ctx);
  assert.equal(badType.ok, false);
  assert.ok(Array.isArray(badType.valid_types));
  const badMode = await getTool("CronCreate")!.execute({ schedule: "1h", prompt: "x", mode: "global" }, ctx);
  assert.equal(badMode.ok, false);
  // 烧钱告警：2 秒一次必须吼一声
  const hot = await getTool("CronCreate")!.execute({ name: "太频繁", type: "every", schedule: "2s", prompt: "x" }, ctx);
  assert.equal(hot.ok, true);
  assert.match(String(hot.warning), /每次都会真实调用模型/);

  const list = await getTool("CronList")!.execute({}, ctx);
  // 成功建了 3 个（早报 / 工作日早报 / 太频繁），另外两次是故意传错的
  assert.ok(Number(list.count) >= 3, "CronList 应当列出刚建的任务，实际 " + String(list.count));
  assert.ok(Number(list.enabled) >= 3);

  // 真跑一次：at 任务 1 秒后触发，触发后自动禁用
  const once = await getTool("CronCreate")!.execute({ name: "一次性", type: "at", schedule: "1s", prompt: "到点了" }, ctx);
  assert.equal(once.ok, true);
  await new Promise((r) => setTimeout(r, 1200));
  const ticked = await sched.tick();
  assert.equal(ticked.ran, 1, "应当有且只有一次性任务到期");
  assert.deepEqual(ran, ["一次性"]);
  const after = await getTool("CronList")!.execute({}, ctx);
  const onceRow = (after.jobs as { id: string; enabled: boolean }[]).find((j) => j.id === once.id)!;
  assert.equal(onceRow.enabled, false, "一次性任务触发后必须自动禁用");

  // 删除：删掉 → 再删同一个 → 结构化错误 + 现有 id
  const del = await getTool("CronDelete")!.execute({ id: created.id }, ctx);
  assert.equal(del.ok, true);
  const delAgain = await getTool("CronDelete")!.execute({ id: created.id }, ctx);
  assert.equal(delAgain.ok, false);
  assert.ok(Array.isArray(delAgain.known_ids));

  // 服务未接入
  const noSvc = await getTool("CronCreate")!.execute({ schedule: "1h", prompt: "x" }, ctxWith({}));
  assert.equal(noSvc.error, "CRON_UNAVAILABLE");
  console.log("  证据：真实触发 " + ran.join(",") + " | 列表 " + String(list.count) + " 条 | 删除=" + String(del.ok));
  db.close();
});

// ── 4. GetContextRemaining ──────────────────────────────────────
test("上下文余量：口径与 compact 一致，并注明是估算还是真实用量", async () => {
  assert.equal(compactThresholdFor(1_048_576), Math.min(1_048_576 - 32_000, Math.floor(1_048_576 * 0.8)));

  const estimate = makeContextStats({
    model: "deepseek-flash", systemPrompt: "x".repeat(400),
    toolDefs: () => [], usage: () => undefined, messages: () => [],
  })();
  assert.equal(estimate.contextWindow, 1_048_576);
  assert.equal(estimate.source, "estimate");
  assert.equal(estimate.wouldCompactNow, false);

  const real = makeContextStats({
    model: "deepseek-flash", systemPrompt: "x",
    toolDefs: () => [], usage: () => ({ inputTokens: 900_000, outputTokens: 1_000, cacheReadTokens: 0 }),
    messages: () => [],
  })();
  assert.equal(real.source, "usage");
  assert.equal(real.wouldCompactNow, true);
  assert.equal(real.nearCompact, true);

  const out = await getTool("GetContextRemaining")!.execute({}, ctxWith({ contextStats: () => real }));
  assert.equal(out.context_window, 1_048_576);
  assert.equal(out.compact_at, compactThresholdFor(1_048_576));
  assert.equal(out.would_compact_now, true);
  assert.match(String(out.note), /压缩线|压缩/);
  assert.match(String(out.used_source), /真实用量/);

  const est = await getTool("GetContextRemaining")!.execute({}, ctxWith({ contextStats: () => estimate }));
  assert.match(String(est.used_source), /估算/);
  assert.match(String(est.note), /估算/);

  const none = await getTool("GetContextRemaining")!.execute({}, ctxWith({}));
  assert.equal(none.error, "CONTEXT_STATS_UNAVAILABLE");
});
