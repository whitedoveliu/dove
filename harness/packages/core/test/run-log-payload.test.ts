/**
 * 双写门面的**载荷形状**契约（agent/run-log.ts）
 *
 * 钉两件会在真路径上静默失效的事：
 * ① 两份日志的载荷**故意不同** —— 按天日志给面板看（截断够用），journal 给模型找回细节（必须完整）。
 *    以前两边共用同一份截断载荷（tool_result 只有 800 字符的 preview），于是 journal 的
 *    「正文不截断 + 超长走 blob」这套机制在真路径上根本不成立，而 context/recovery-footer.ts
 *    的恢复指针正指着它说「完整内容在这份日志里」—— 承诺与事实不符。
 * ② journal 写失败**必须有出口**：以前是 catch 里静默吞掉，结果是恢复指针指着一份没写进去的日志，
 *    用户与模型都看不出任何异常。
 *
 * 用真 Store + 真 EventLog + 真 Journal + 真 runtime，落盘全在临时目录里。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { EventLog } from "../src/session/event-log.ts";
import { openJournal } from "../src/session/journal.ts";
import { PendingRegistry } from "../src/agent/pending.ts";
import { SteeringQueue } from "../src/loop/steering.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { makeRunLog } from "../src/agent/run-log.ts";
import { allTools } from "../src/tools/registry.ts";
import type { Journal } from "../src/session/journal.ts";
import type { Provider, StreamResult, StreamOptions } from "../src/providers/types.ts";
import type { Tool } from "../src/tools/types.ts";

const usage = () => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** 假工具：返回一大段正文（够长，能区分「完整」与「800 字符 preview」） */
const BIG_BODY = "B".repeat(5_000);
const bigTool: Tool = {
  name: "FakeBigResult",
  description: "测试用：回一大段正文",
  parameters: { type: "object", properties: {} },
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: async () => ({ body: BIG_BODY }),
};

/** 假 provider：第 1 步调一次工具，之后给文本 */
function provider(): Provider {
  let step = 0;
  return {
    id: "runlog-stub",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      step++;
      if (step === 1) {
        return {
          text: "", reasoning: [], toolCalls: [{ id: "c_log", type: "function", function: { name: "FakeBigResult", arguments: "{}" } }],
          finishReason: "tool_calls", usage: usage(),
        } as unknown as StreamResult;
      }
      opts.onTextDelta?.("收尾");
      return { text: "收尾", reasoning: [], toolCalls: [], finishReason: "stop", usage: usage() } as unknown as StreamResult;
    },
  } as unknown as Provider;
}

function harness(eventLog: EventLog, journal: Journal): { runtime: AgentRuntime; store: Store } {
  const db = new Db(":memory:");
  const store = new Store(db);
  store.createThread({ id: "th_log", kind: "project", title: "日志" });
  const tools = new Map<string, Tool>(allTools().map((t) => [t.name, t]));
  tools.set(bigTool.name, bigTool);
  const runtime = new AgentRuntime({
    provider: provider(), store, eventLog,
    journalFor: () => journal,
    pending: new PendingRegistry(), steering: new SteeringQueue(),
    tools,
    assemble: async () => ({ systemPrompt: "测试", tailContext: "", memoriesBlock: "", dualSystem: false }),
  });
  return { runtime, store };
}

test("tool_result：按天日志只有 800 字符 preview（面板够用），journal 拿到完整正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dove-runlog-"));
  const eventLog = new EventLog({ dir });
  const journal = openJournal(dir, "th_log", "2026-01-02");
  const { runtime } = harness(eventLog, journal);
  await runtime.run({ threadId: "th_log", userText: "跑那个大工具", sink: () => { /* 忽略 */ } });

  const daily = eventLog.readAll().find((r) => r.type === "tool_result")!;
  const rec = journal.readAll().find((r) => r.type === "tool_result")!;
  assert.ok(String(daily.data!.preview).length <= 802, "按天日志仍是截断的 preview（面板契约不变）");
  assert.equal(daily.data!.output, undefined, "按天日志里不该有完整正文（它会被 2000 字符截断，只会误导）");
  assert.ok(rec.data!.output, "journal 里必须有完整正文（恢复指针指的就是它）");
  // 完整正文远长于 preview：这一条正是「两边共用同一份截断载荷」时唯一会响的断言
  assert.ok(JSON.stringify(rec.data!.output).length > 2_000, `journal 的正文只有 ${JSON.stringify(rec.data!.output).length} 字符`);
  assert.equal((rec.data!.output as { body?: string }).body, BIG_BODY, "journal 里是逐字节完整的正文");
});

test("turn_start：超长用户输入在 journal 里落 blob（不截断），按天日志留 500 字符 + 省略标记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dove-runlog-u-"));
  const eventLog = new EventLog({ dir });
  const journal = openJournal(dir, "th_log", "2026-01-02");
  const { runtime } = harness(eventLog, journal);
  const pasted = "用户贴了一整篇：" + "字".repeat(20_000);
  await runtime.run({ threadId: "th_log", userText: pasted, sink: () => { /* 忽略 */ } });

  const daily = eventLog.readAll().find((r) => r.type === "turn_start")!;
  assert.match(String(daily.data!.userText), /字符已省略/, "截断必须留标记（否则读的人以为这就是全文）");
  const rec = journal.readAll().find((r) => r.type === "turn_start")!;
  const ref = rec.data!.userText as { blob: string; chars: number };
  assert.equal(ref.chars, pasted.length, "journal 里的正文一个字符都不许少（超长走 blob 指针，不是截断）");
});

test("journal 写失败：按天日志留一条出口（只在第一次），失败计数供以后暴露", () => {
  const dir = mkdtempSync(join(tmpdir(), "dove-runlog-fail-"));
  const eventLog = new EventLog({ dir });
  const broken = { append() { throw new Error("EACCES: 目录只读"); } } as unknown as Journal;
  const logs = makeRunLog({ eventLog, journal: broken });

  logs.append("turn_start", { userText: "一" });      // 第一次失败：记一条
  logs.append("turn_result", { ok: true });           // 之后不再刷屏
  logs.split("tool_result", { preview: "x" }, { output: "x" });   // split 走的是同一条 journal 出口

  const failed = eventLog.readAll().filter((r) => r.type === "journal_failed");
  assert.equal(failed.length, 1, "只记第一次（每次都记会把日志自己滚成一团）");
  assert.equal(failed[0]!.data!.type, "turn_start", "要写清是哪条记录写失败的");
  assert.match(String(failed[0]!.data!.error), /EACCES/, "要带上原因（否则等于换了个地方静默）");
  assert.equal(failed[0]!.data!.failures, 1);
  assert.equal(logs.journalFailures, 3, "失败计数只涨不清（供面板/诊断以后暴露）");
  assert.equal(eventLog.readAll().filter((r) => r.type === "turn_start").length, 1, "按天日志照旧要写（主流程不受影响）");
});
