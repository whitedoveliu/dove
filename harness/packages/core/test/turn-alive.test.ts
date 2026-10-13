/**
 * 「通知给回合续命」（turn-alive）
 *
 * 场景：后台子代理/后台任务在**这一轮进行中**就绪时，结果不该等到下一次用户开口才被读进去。
 * 做法是复用了既有的 **steering（中途注入）通道**：
 *   runtime 在每次 step 开始前认领「已完成但未注回」的任务（`claimPendingInjections`，
 *   它原子地标记 injected —— 防重复注入的唯一入口），把结果推进 steering 队列；
 *   `loop/turn.ts` 的闸门① 见到待插话会把这一轮**续上**，于是模型在同一条回合里就看到结果。
 *
 * 为什么不去 append 进 `msgs`：中途注入必须落成 `injection` part 才能**原位置重放**（wire-history 铁律二），
 * 而 steering 通道已经是对的（步边界折叠 + `onUserInjection` 落库）。绕开它就会破坏前缀重建。
 *
 * 这个测试用假 provider 精确控制「任务在哪一刻完成」，所以不依赖真实计时 —— 没有 flaky。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/session/db.ts";
import { Store } from "../src/session/store.ts";
import { EventLog } from "../src/session/event-log.ts";
import { PendingRegistry } from "../src/agent/pending.ts";
import { SteeringQueue } from "../src/loop/steering.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { TaskRegistry } from "../src/agents/task-registry.ts";
import { allTools } from "../src/tools/registry.ts";
import type { Provider, StreamResult, StreamOptions, ChatMessage } from "../src/providers/types.ts";
import type { Tool } from "../src/tools/types.ts";

const TEMP = mkdtempSync(join(tmpdir(), "dove-turnalive-"));
const CALL = [{ id: "c_time", type: "function", function: { name: "CurrentTime", arguments: "{}" } }] as unknown as StreamResult["toolCalls"];

/** 假 provider：第 1 步给一个工具调用，之后给文本；并把每次收到的 messages 记下来（断言用） */
function makeProvider(hooks: { seen: ChatMessage[][] }): Provider {
  let step = 0;
  return {
    id: "turnalive-stub",
    stream: async (opts: StreamOptions): Promise<StreamResult> => {
      step++;
      hooks.seen.push(opts.messages);
      if (step === 1) {
        return { text: "先查个时间", reasoning: "", toolCalls: CALL, finishReason: "tool_calls", usage: emptyUsage() } as unknown as StreamResult;
      }
      const text = step === 2 ? "第一轮答复" : "看到了后台结果";
      opts.onTextDelta?.(text);
      return { text, reasoning: "", toolCalls: [], finishReason: "stop", usage: emptyUsage() } as unknown as StreamResult;
    },
  } as unknown as Provider;
}
const emptyUsage = () => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });

function harness(provider: Provider) {
  const db = new Db(":memory:");
  const store = new Store(db);
  const tasks = new TaskRegistry(db);
  const runtime = new AgentRuntime({
    provider, store, tasks,
    tools: new Map<string, Tool>(allTools().map((t) => [t.name, t])),
    eventLog: new EventLog({ dir: TEMP }),
    pending: new PendingRegistry(), steering: new SteeringQueue(),
    assemble: async () => ({ systemPrompt: "测试", tailContext: "", memoriesBlock: "", dualSystem: false }),
  });
  return { runtime, store, tasks };
}

const flat = (msgs: ChatMessage[]): string =>
  msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");

test("回合进行中就绪的后台任务：同一轮就送进上下文，并把这一轮续上", async () => {
  const seen: ChatMessage[][] = [];
  let taskId = "";
  const provider = makeProvider({ seen });
  const { runtime, store, tasks } = harness(provider);

  const th = store.getOrCreateHomeThread();
  const t = tasks.create({ threadId: th.id, prompt: "后台算个事", kind: "subagent" });
  taskId = t.id;
  // 在「第 1 步的流已经开始」这一刻把任务标成完成 —— 也就是**晚于**回合开头的认领，早于第 2 步。
  (provider as unknown as { stream: (o: StreamOptions) => Promise<StreamResult> }).stream = (() => {
    let step = 0;
    return async (opts: StreamOptions) => {
      step++;
      seen.push(opts.messages);
      if (step === 1) {
        tasks.finish(taskId, "后台结果：答案是 42");
        return { text: "先查个时间", reasoning: "", toolCalls: CALL, finishReason: "tool_calls", usage: emptyUsage() } as unknown as StreamResult;
      }
      const text = step === 2 ? "第一轮答复" : "看到了后台结果";
      opts.onTextDelta?.(text);
      return { text, reasoning: "", toolCalls: [], finishReason: "stop", usage: emptyUsage() } as unknown as StreamResult;
    };
  })();

  await runtime.run({ threadId: th.id, userText: "开始", sink: () => { /* 忽略 */ } });

  // ① 某一次请求里真的带上了后台结果（不是等到下一轮）—— 这条才是「续命」的实质证据。
  //    （别拿「调用次数 ≥3」当证据：完成守卫本来就会重试，次数会混进来。）
  assert.ok(seen.some((m) => flat(m).includes("后台结果：答案是 42")), "中途注入没有进上下文");
  assert.ok(seen.some((m) => flat(m).includes("后台任务有结果了")), "注入的标题文案丢了");
  // ③ 落库形态必须是 injection part（否则重建时这段凭空消失，前缀缓存从那一点断掉）
  const parts = store.listMessages(th.id).flatMap((m) => m.parts);
  assert.ok(parts.some((p) => p.type === "injection" && String((p as { text: string }).text).includes("答案是 42")),
    "注入必须落成 injection part，实际 parts：" + parts.map((p) => p.type).join(","));
  // ④ 只注入一次（claimPendingInjections 的 injected 标记是唯一入口）
  assert.equal(tasks.list(th.id).filter((x) => x.injected).length, 1);
});

test("对照：没有后台任务时不会凭空多一次模型调用", async () => {
  const seen: ChatMessage[][] = [];
  const provider = makeProvider({ seen });
  const { runtime, store } = harness(provider);
  const th = store.getOrCreateHomeThread();
  await runtime.run({ threadId: th.id, userText: "开始", sink: () => { /* 忽略 */ } });
  // 只断言「没有凭空冒出注回内容」—— 不拿调用次数当判据（完成守卫会自己重试，次数本来就 >2）
  assert.ok(!seen.some((m) => flat(m).includes("后台任务有结果了")), "没有任务却出现了注回文案");
  assert.ok(!seen.some((m) => flat(m).includes("答案是 42")));
});
