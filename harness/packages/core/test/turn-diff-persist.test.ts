/**
 * 回合净 diff 的**持久化**端到端测试
 *
 * 用户要求「每一轮创建的文件需要在每个会话结束后展示出来」—— 关键是**会话结束后还在**：
 * 内核原本只在 SSE 里发一次 `turn_diff` 事件，刷新/重开就没了，面板没法列出历史回合的产物。
 * 现在把它写进 assistant 消息的 metadata（`Message.turnDiff`，落 `messages.metadata` JSON）。
 *
 * 这里用真库文件（不是 :memory:）跑一轮真 Write，然后**新开一个 Store 指向同一个库**读回来 ——
 * 「重启后还在」只有这样才算证明过。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { EventLog } from "../src/session/event-log.ts";
import { PendingRegistry } from "../src/agent/pending.ts";
import { SteeringQueue } from "../src/loop/steering.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { allTools } from "../src/tools/registry.ts";
import type { Provider, StreamResult, StreamOptions } from "../src/providers/types.ts";
import type { Tool } from "../src/tools/types.ts";

const ROOT = mkdtempSync(join(tmpdir(), "dove-tdp-"));
const usage = () => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** 假 provider：第 1 步让模型写一个文件，之后给文本 */
function writerProvider(filePath: string): Provider {
  let step = 0;
  return {
    id: "tdp-stub",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      step++;
      if (step === 1) {
        return {
          text: "", reasoning: "", finishReason: "tool_calls", usage: usage(),
          toolCalls: [{ id: "call_w", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: filePath, content: "hello\n" }) } }],
        } as unknown as StreamResult;
      }
      opts.onTextDelta?.("写好了");
      return { text: "写好了", reasoning: "", toolCalls: [], finishReason: "stop", usage: usage() } as unknown as StreamResult;
    },
  } as unknown as Provider;
}

function mkRuntime(dbFile: string, provider: Provider) {
  const db = new Db(dbFile);
  const store = new Store(db);
  // ⚠️ runtime 的 workdir = 项目根（`proj?.path ?? listProjects()[0]?.path ?? process.cwd()`），
  //    不是「测试临时目录」。不建项目的话 Write 会落到 process.cwd()（一开始就写进了 harness/ 里，
  //    这条测试第一次跑就把仓库弄脏了）。所以必须先建一个 path=ROOT 的项目。
  db.run("INSERT OR REPLACE INTO projects(id,name,path,port,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    "prj_tdp", "tdp", ROOT, 3000, "website", Date.now(), Date.now());
  const runtime = new AgentRuntime({
    provider, store, eventLog: new EventLog({ dir: ROOT }),
    pending: new PendingRegistry(), steering: new SteeringQueue(),
    tools: new Map<string, Tool>(allTools().map((t) => [t.name, t])),
    assemble: async () => ({ systemPrompt: "测试", tailContext: "", memoriesBlock: "", dualSystem: false }),
  });
  return { runtime, store, db };
}

test("回合净 diff 会落进 assistant 消息，并且换个 Store 指同一个库还读得到", async () => {
  const dbFile = join(ROOT, "persist.db");
  const { runtime, store } = mkRuntime(dbFile, writerProvider("out.txt"));
  const th = store.createThread({ id: "th_tdp", kind: "project", projectId: "prj_tdp", title: "t" });
  const seenEvents: { type: string }[] = [];

  await runtime.run({ threadId: th.id, projectId: "prj_tdp", userText: "写个文件", sink: (e) => { seenEvents.push(e as { type: string }); } });

  // ① 文件真的写出来了
  assert.equal(readFileSync(join(ROOT, "out.txt"), "utf8"), "hello\n");
  // ② 消息上带了净 diff
  const last = store.listMessages(th.id).at(-1)!;
  assert.equal(last.role, "assistant");
  const files = last.turnDiff?.files ?? [];
  assert.equal(files.length, 1, "应当恰好一条文件记录，实际：" + JSON.stringify(last.turnDiff));
  assert.equal(files[0]!.path, "out.txt");
  assert.equal(files[0]!.created, true, "新文件要标成 created");
  assert.ok(files[0]!.added >= 1, "至少加了一行");
  // ③ 事件照旧发（面板实时渲染靠它，落库只是补历史）
  assert.ok(seenEvents.some((e) => e.type === "turn_diff"), "turn_diff 事件不该因为落库就不发了");

  // ④ 「重启后还在」：新开 Store 指同一个库文件
  const reopened = new Store(new Db(dbFile));
  const again = reopened.listMessages(th.id).at(-1)!;
  assert.deepEqual(again.turnDiff, last.turnDiff, "换一个 Store 读回来必须一模一样");
});

test("没有文件变化的一轮：不产生空的 turnDiff（别让面板渲染空块）", async () => {
  const dbFile = join(ROOT, "nofile.db");
  const provider: Provider = {
    id: "tdp-plain",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      opts.onTextDelta?.("只是聊了两句");
      return { text: "只是聊了两句", reasoning: "", toolCalls: [], finishReason: "stop", usage: usage() } as unknown as StreamResult;
    },
  } as unknown as Provider;
  const { runtime, store } = mkRuntime(dbFile, provider);
  const th = store.createThread({ id: "th_tdp2", kind: "project", projectId: "prj_tdp", title: "t2" });
  await runtime.run({ threadId: th.id, projectId: "prj_tdp", userText: "聊两句", sink: () => { /* 忽略 */ } });
  const last = store.listMessages(th.id).at(-1)!;
  assert.equal(last.turnDiff, undefined, "没改文件就不该有 turnDiff");
});
