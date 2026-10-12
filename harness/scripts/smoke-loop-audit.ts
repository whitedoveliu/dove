/**
 * 冒烟：循环与工具面纪律审计（Alma 两张硬性清单 → dove 逐条实测）
 *
 * 为什么单独一个脚本：这 19 条都是「只能按时间切才看得见」的顺序约束 —— 谁先谁后、哪条路径没弹窗、
 * 异常路径有没有收尾。单测和编译都证明不了，必须真的把一轮跑起来看事件、看落库、看审批计数。
 * 用脚本化 provider 驱动**真实**的 AgentRuntime / store / 事件日志 / 审批表 / 子代理宿主：
 * 只有「模型说什么」是假的，其余每一层都是生产代码。端口 8861 只用于 B① 的入站帧判别。
 */
import "./_isolate.ts";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { finish } from "./_lifecycle.ts";
import { AgentRuntime } from "../packages/core/src/agent/runtime.ts";
import { SseHub } from "../packages/server/src/sse.ts";
import { handle } from "../packages/server/src/routes.ts";
import { executeOne } from "../packages/core/src/loop/tool-exec.ts";
import { Watchdog } from "../packages/core/src/loop/watchdog.ts";
import { applyTailContext } from "../packages/core/src/loop/turn.ts";
import { classifyLocally } from "../packages/core/src/tools/approval.ts";
import { getTodos } from "../packages/core/src/tools/builtin/todo-write.ts";
import { bindPtcRuntime } from "../packages/core/src/tools/builtin/run-script.ts";
import {
  coreTools, systemTools, onDemandTools, currentActiveNames, activateTools, deactivateAll,
} from "../packages/core/src/tools/registry.ts";
import type { ChatMessage } from "../packages/core/src/providers/types.ts";
// 脚手架（假 provider / 事件收集 / 审批代答 / 跑一轮）在 _loop-audit-stub.ts ——
// 摆完那些就顶到 400 行硬约束了，这里只留用例与断言。
import { makeProvider, makeAuditEnv, res, errRes, call, collector, lastToolContent, sawInRequest } from "./_loop-audit-stub.ts";
import type { Ev } from "./_loop-audit-stub.ts";

// 审批等待上限压到 3 秒：万一哪次「面板侧的回答」没答上（脚本自己的 bug），宁可 3 秒后看到一条
// FAIL，也不要挂满默认的 5 分钟 —— 冒烟脚本必须能自动跑完。
process.env.DOVE_APPROVAL_TIMEOUT_MS = "3000";
const PORT = 8861;
let pass = 0, fail = 0;
function check(name: string, ok: boolean, note = ""): void {
  if (ok) { pass++; console.log("  PASS  " + name + (note ? "   [" + note + "]" : "")); }
  else { fail++; console.log("  FAIL  " + name + (note ? "   [" + note + "]" : "")); }
}

const svc = await bootstrap(loadConfig());
const proj = svc.projects.create({ name: "循环审计" });
const { base, runtimeWith, newThread, turn, answerLater, minimalExecDeps, logCount, lastAssistantText } = makeAuditEnv(svc, proj);

console.log("=== 清单 B⑫：回合结束是唯一的收尾触发点（有产出 / 没产出 / 抛异常）===");
{
  // ①-a 工具调用之后模型不再说话：就是日志里那条「发了消息什么都没发生」
  const before = logCount("turn_end");
  const { c, r, th } = await turn([() => res("", [call("CurrentTime", {})]), () => res("")], "现在几点");
  const note = String(c.ev("interrupted")[0]?.note ?? "");
  check("无产出回合被自报为 silent", r.silent === true, "endReason=" + r.endReason);
  check("发了 interrupted 事件（不是静默结束）", c.ev("interrupted").length === 1, JSON.stringify(c.ev("interrupted")[0] ?? {}));
  check("说明文案是人话（没有 endReason= 这类内核黑话）", /没有产出答复/.test(note) && !/endReason=/.test(note), note);
  check("说明文案也落库了（刷新不能又变空白）", lastAssistantText(th).includes("没有产出答复"));
  check("turn_end 落进事件日志（收尾触发点真的开了火）", logCount("turn_end") === before + 1);
}
{
  // ①-b 客户端断开：endReason 停在 tool_calls —— 日志里真实出现过的那条
  const ctrl = new AbortController();
  const { c, r } = await turn([
    () => { queueMicrotask(() => ctrl.abort("client-gone")); return res("", [call("CurrentTime", {})]); },
    () => res("不该到这里"),
  ], "现在几点", { signal: ctrl.signal });
  const ev = c.ev("interrupted")[0] ?? {};
  // aborted 只能从事件里拿：run() 的返回值是给 HTTP 层用的 {assistantMessageId,endReason,usage,silent}
  check("断开时 endReason 停在 tool_calls（复现日志形态）", r.endReason === "tool_calls", "endReason=" + r.endReason);
  check("仍然发了 interrupted，且说清是「被中断」", /被中断/.test(String(ev.note ?? "")), String(ev.note ?? ""));
  check("机器可读的原因没丢（事件里带 endReason / aborted）", ev.endReason === "tool_calls" && ev.aborted === true);
}
{
  // ①-c provider 抛异常（网络层）—— 修前异常会穿过整个 runTurn，收尾那一段全被跳过
  const before = logCount("turn_end");
  let threw = "";
  let silent: boolean | undefined;
  let c!: { ev: (t: string) => Ev[] }; let th = "";
  try {
    const r = await turn([() => { throw new Error("fetch failed: ECONNREFUSED"); }], "在吗");
    c = r.c; th = r.th; silent = r.r.silent;
  } catch (e) { threw = String(e); }
  check("provider 抛异常不再把整轮炸出去（循环层兜住）", threw === "", threw.slice(0, 80));
  check("异常路径仍然写了 turn_end（收尾触发点没被跳过）", logCount("turn_end") === before + 1);
  check("异常路径也发了 interrupted", c.ev("interrupted").length === 1);
  check("异常路径仍然落了 assistant 消息", silent === true && lastAssistantText(th).length > 0);
}
{
  // ①-d 流内错误：说明文案不能是「endReason=error」这种内核字段名
  const { c } = await turn([() => errRes("HTTP 401: invalid api key")], "在吗");
  const ev = c.ev("interrupted")[0] ?? {};
  check("流内错误也给明确说明（不是沉默）", c.ev("interrupted").length === 1);
  check("说明文案没有人话之外的黑话", /出错/.test(String(ev.note ?? "")) && !/endReason=/.test(String(ev.note ?? "")), String(ev.note ?? ""));
  check("真实原因是机器可读字段（endReason=error），没丢", ev.endReason === "error");
}

console.log("=== 清单 A⑤ / B⑤：子代理的审批路径（两条路径必须一致）===");
activateTools(["Task"]);   // Task 是按需工具；先激活，让它像真实路径一样在 wire 上
for (const allow of [true, false]) {
  const dir = join(proj.path, allow ? "sub-allow" : "sub-deny");
  mkdirSync(dir, { recursive: true });
  const approvals: string[] = [];
  const { c } = await turn(
    [
      () => res("", [call("Task", { prompt: "用 Bash 删掉这个目录：" + dir, label: "删除目录" })]),
      () => res("子代理跑完了", [call("AttemptCompletion", { summary: "完成" })]),
      () => res("完成"),
    ],
    "派个子代理删掉那个目录",
    {
      child: [
        () => res("", [call("Bash", { command: `rm -rf "${dir}"` })]),
        (_n, opts) => res("我拿到的工具结果是：" + lastToolContent(opts)),
      ],
      onEvent: (e) => { if (e.type === "tool_approval") { approvals.push(String(e.toolCallId)); answerLater(String(e.toolCallId), allow); } },
    },
  );
  const taskOut = JSON.stringify(c.ev("tool_result").find((e) => e.tool === "Task")?.result ?? "");
  const tag = allow ? "允许" : "拒绝";
  check(`子代理里的写操作**确实弹了审批**（${tag}路径，不是静默放行）`, approvals.length === 1, "approvals=" + approvals.length);
  // 审批 id 是脚本给子代理那条 Bash 起的 —— 证明弹窗来自子代理，不是父线程自己的调用
  check(`弹窗来自子代理那条 Bash（${tag}）`, approvals[0]?.startsWith("c_Bash_") === true, String(approvals[0]));
  if (allow) {
    check("允许之后命令**真的执行了**（审批不是装饰）", !existsSync(dir));
    check("子代理看到了执行结果（结论带回父线程）", /exit_code/.test(taskOut), taskOut.slice(0, 90));
  } else {
    check("被拒后命令没有执行（工作区里目录还在）", existsSync(dir));
    check("子代理收到的是结构化拒绝（不是一句莫名失败）", /用户拒绝了这次操作/.test(taskOut), taskOut.slice(0, 130));
  }
}
{
  // A⑤ 的另一半：Alma「子 agent 的 Bash 永不弹窗、只有 run_script 会弹」的非对称在 dove 里双向
  // 不成立 —— ① 子代理能调到的每个工具都走同一条 resolveApproval + 同一份 ctxBase（#childDeps 只换
  // signal + 收窄 services，不碰审批），上面两个方向已验；② 子代理的工具表是 agents/subagent.ts 的
  // 白名单，**根本没有 RunScript**（本地代码执行不下放），也没有再派活的入口。
  let childThread = "";
  const { p, th } = await turn([
    () => res("", [call("Task", { prompt: "记一条待办，再看看你的工具表", label: "探针" })]),
    () => res("好", [call("AttemptCompletion", { summary: "完成" })]), () => res("完"),
  ], "派个子代理看看工具", {
    child: [
      () => res("", [call("TodoWrite", { todos: [{ content: "子代理记的", status: "pending" }] })]),
      (_n, opts) => res("确认完毕：" + lastToolContent(opts).slice(0, 40)),
    ],
    onEvent: (e) => { if (e.type === "tool:todos") childThread = String(e.threadId); },
  });
  const child = p.log.find((l) => l.role === "child")!;
  check("子代理的工具跑在**父线程**的上下文里（两条路径审批元数据一致的根因）", childThread === th, childThread);
  check("子代理的工具表是白名单裁过的，不是主线程那张（27 项）", child.wire.length < 15, child.wire.length + " 项：" + child.wire.join(","));
  check("子代理拿不到 RunScript / BashOutput（代码执行与后台读取都不下放）",
    !child.wire.includes("RunScript") && !child.wire.includes("BashOutput"));
  check("子代理拿不到派活类工具（不能自己再派子代理）", !child.wire.includes("Task") && !child.wire.includes("DispatchToProject"));
  check("子代理有 Bash —— 所以上面那条审批断言测的是真实路径", child.wire.includes("Bash"));
}

console.log("=== 清单 B⑤：权限闸门短路 —— 拒绝之后模型必须被告知（闸门③）===");
{
  const keep = join(proj.path, "keep.txt");
  writeFileSync(keep, "keep");
  let sawDenialInToolResult = false, sawDenialInReminder = false;
  // 第 2 步**故意不给文本**：工具被拒后模型直接收尾 —— 这才轮得到闸门③开火。闸门在内层循环退出来
  // 之后才评估，所以「被拒的同一回合里模型看到什么」与「闸门提醒送到哪一步」是两个不同的请求，
  // 必须分开断言（混在一个请求上断的是一个不存在的时序）。
  const { c, th } = await turn([
    () => res("", [call("Bash", { command: `rm -f "${keep}"` })]),
    (_n, opts) => { sawDenialInToolResult = sawInRequest(opts, /用户拒绝/); return res(""); },
    (_n, opts) => {
      sawDenialInReminder = sawInRequest(opts, /被用户拒绝/);
      return res("我看到被拒了，换个不越界的方式", [call("AttemptCompletion", { summary: "改走别的办法" })]);
    },
    () => res("好"),
  ], "删掉 keep.txt", { onEvent: (e) => { if (e.type === "tool_approval") answerLater(String(e.toolCallId), false); } });
  const gates = (c.ev("stats")[0]?.gates ?? []) as { gate: string }[];
  check("闸门③ permission-continue 真的开火了（以前写死 false，是死代码）", gates.some((g) => g.gate === "permission-continue"), JSON.stringify(gates));
  check("模型在工具结果里就看到了拒绝（第一时间的告知）", sawDenialInToolResult);
  check("闸门③的提醒也真的送到了模型（下一步请求里带着它）", sawDenialInReminder);
  check("被拒的命令没有执行", existsSync(keep));
  check("这一轮不是空回合（模型给出了替代方案）", lastAssistantText(th).includes("换个不越界"));
}

console.log("=== 清单 A① / B③：ToolSearch 与「第 0 步」 ===");
deactivateAll();
{
  // 不变量：本回合**第一次生成**的工具表在请求发出的那一刻就定死了，里面不可能有「检索来的」
  // 工具 —— 等价于 Alma 的 stepNumber > 0（它同样是等到第 1 步才在 prepareStep 里动手）。
  const coreSystemNames = [...coreTools(), ...systemTools()].map((t) => t.name);
  const p = makeProvider({ parent: [() => res("你好")] });
  await runtimeWith(p.provider).run({ threadId: newThread(), userText: "在吗", sink: collector().sink });
  const first = p.log.find((l) => l.role === "parent")!;
  check("ToolSearch 在第 0 步不生效：第一次请求的 wire 里没有任何按需工具",
    onDemandTools().every((t) => !first.wire.includes(t.name)), first.wire.length + " 项");
  check("第 0 步的 wire 前导 = CORE+SYSTEM（顺序即缓存前缀，不能重排）",
    JSON.stringify(first.wire.slice(0, coreSystemNames.length)) === JSON.stringify(coreSystemNames));
  check("第 0 步的 wire 没有重复项", new Set(first.wire).size === first.wire.length, first.wire.length + " 项");
}
{
  // 「第 0 步没有工具结果 → 无从判断搜索意图」在 dove 上的等价物：**没有关键词就不搜**。
  // 必须拦在工具里 —— registry.searchTools("") 的兜底是「按需工具的前 limit 个」= 盲激活。
  const before = currentActiveNames();
  const out = await executeOne(call("ToolSearch", { query: "   " }), minimalExecDeps(svc.tools));
  const payload = (out.output ?? {}) as { activated?: string[]; note?: string };
  check("无关键词的检索不激活任何工具（不盲开）", out.ok === true && (payload.activated ?? []).length === 0, JSON.stringify(payload.activated));
  check("并且明确告诉模型「没有激活」", /没有激活任何工具/.test(String(payload.note ?? "")), String(payload.note ?? "").slice(0, 50));
  check("registry 的全局激活集合没被污染", JSON.stringify(currentActiveNames()) === JSON.stringify(before));
}
{
  const { p } = await turn([
    () => res("", [call("ToolSearch", { query: "终端" })]),
    () => res("检索到了", [call("AttemptCompletion", { summary: "看到了终端工具" })]), () => res("好"),
  ], "我要开一个常驻终端");
  const [c1, c2] = p.log.filter((l) => l.role === "parent");
  // 第 0 步**允许**发起检索（用户第一句就可能是「开个终端」），但激活只对下一次请求生效：带检索
  // 调用的那次请求里一个按需工具都没有 —— 这就是「第 0 步不生效」在 dove 的落点。
  check("第 0 步发起的检索，在这一步自己的请求里不生效（工具表已冻结）",
    c1!.wire.includes("ToolSearch") && onDemandTools().every((t) => !c1!.wire.includes(t.name)));
  check("下一步（= 已经有工具结果的那一步）才在 wire 上看到它",
    c2!.wire.includes("TerminalOpen"), c2!.wire.filter((n) => n.startsWith("Terminal")).join(","));
  check("激活是**追加**的：已有前缀一字不动（缓存纪律）",
    JSON.stringify(c2!.wire.slice(0, c1!.wire.length)) === JSON.stringify(c1!.wire));
  check("激活的工具确实在尾部（不重排）", c2!.wire.length > c1!.wire.length);
  deactivateAll();
}
{
  // 重复检索是正常路径（激活是进程级的，第二次全是 already active）——这时给模型的必须是
  // 「本来就在」，不能是一个空名单 + 一句空承诺。
  await executeOne(call("ToolSearch", { query: "终端" }), minimalExecDeps(svc.tools));
  const again = await executeOne(call("ToolSearch", { query: "终端" }), minimalExecDeps(svc.tools));
  const pl = (again.output ?? {}) as { activated?: string[]; note?: string };
  check("重复检索：不说「已激活：。」这种空承诺，而是说清本来就在工具表里",
    (pl.activated ?? []).length === 0 && /本来就已经在你的工具表里/.test(String(pl.note ?? "")), String(pl.note ?? "").slice(0, 70));
  deactivateAll();
}

console.log("=== 清单 A⑥ / B⑦：输出溢出先裁剪落盘、再把路径写回正文 ===");
{
  const big = join(proj.path, "big.txt");
  writeFileSync(big, "x".repeat(50_000));
  // 用 cat（只读白名单 → safe）而不是 node -e：后者本地判不了、要走审批，没有审批窗口时会被拒
  // —— 于是这条链路**根本没被跑到**，断言看着像在测落盘，其实测的是拒绝。
  const { c } = await turn([
    () => res("", [call("Bash", { command: `cat ${big}` })]),
    () => res("输出很长", [call("AttemptCompletion", { summary: "看完了" })]), () => res("完成"),
  ], "跑一条输出很长的命令");
  const tr = c.ev("tool_result").find((e) => e.tool === "Bash");
  const spillPath = String(tr?.spillPath ?? "");
  const body = JSON.stringify(tr?.result ?? {});
  const spilled = spillPath !== "" && existsSync(spillPath) ? readFileSync(spillPath, "utf8").length : -1;
  check("超限结果给出了存档路径", spillPath !== "" && existsSync(spillPath), spillPath);
  check("存档里是**完整**原文（不是截断后的）", spilled >= 50_000, spilled + " 字符");
  check("正文里写回了路径 + 三要素截断说明", body.includes("_spillPath") && body.includes("不完整的输出") && /KB/.test(body), body.slice(0, 100));
  check("正文本身被压到预算内（不会撑爆上下文）", body.length < 6_000, body.length + " 字符");
  check("工具部件把 spillPath 带进落库（面板/刷新后仍能找回原文）", tr?.spillPath === spillPath);
}

console.log("=== 清单 B④ / B⑪：注册表外的工具、数组字段必须是真数组 ===");
{
  const p = makeProvider({ parent: [
    () => res("", [call("zzz_unknown_tool_zzz", {})]),
    (_n, opts) => res(/未知工具/.test(lastToolContent(opts)) ? "知道了" : "没收到错误", [call("AttemptCompletion", { summary: "换工具" })]),
    () => res("好"),
  ] });
  const c = collector();
  const out = await runtimeWith(p.provider).run({ threadId: newThread(), userText: "调用一个不存在的工具", sink: c.sink });
  const tr = c.ev("tool_result").find((e) => e.tool === "zzz_unknown_tool_zzz");
  check("注册表里没有的工具不进执行（结构化拒绝，不抛）", tr?.ok === false && /未知工具/.test(String(tr?.error ?? "")), String(tr?.error ?? "").slice(0, 50));
  check("回合没被这个错误带崩（正常收尾）", out.endReason === "stop", out.endReason);
}
{
  // B⑪：数组字段写成 JSON **字符串**（tools/repair-call.ts 的 coerce）。能 parse 就展开；
  // parse 不动原样交回，让 schema 报「必须是数组」（改前一律包成 [v]，模型看到的是误导性的「第 1 项缺少 content」）。
  const stringy = await executeOne(call("TodoWrite", { todos: JSON.stringify([{ content: "a", status: "pending" }]) }), minimalExecDeps(svc.tools));
  const afterStringy = getTodos("th_audit_exec");   // 必须紧接着取：下一行就会覆盖状态
  check("JSON 字符串数组 → 展开成真数组（不误伤，状态写对）",
    stringy.ok === true && afterStringy.length === 1 && afterStringy[0]?.content === "a" && afterStringy[0]?.status === "pending",
    JSON.stringify(afterStringy).slice(0, 120));

  const real = await executeOne(call("TodoWrite", { todos: [{ content: "a", status: "pending" }] }), minimalExecDeps(svc.tools));
  check("真数组正常接受", real.ok === true && JSON.stringify(real.output ?? {}).includes("pending"), JSON.stringify(real.output ?? {}).slice(0, 60));

  const junk = await executeOne(call("TodoWrite", { todos: "这不是 JSON" }), minimalExecDeps(svc.tools));
  const junkErr = String(junk.errorText ?? (junk.output as { error?: string } | undefined)?.error ?? "");
  check("解析不动的字符串 → 报「必须是数组」，不是误导性的「第 1 项」", junkErr.length > 0 && /数组|array/i.test(junkErr) && !/第 1 项/.test(junkErr), junkErr.slice(0, 100));
}

console.log("=== 清单 B⑤ / B⑥：Bash 三级判定 + 判不了时 fail-safe ===");
{
  check("safe：只读命令直接放行", classifyLocally("ls -la", proj.path) === "safe");
  check("low：工作区内的重定向放行", classifyLocally(`echo hi > ${join(proj.path, "a.txt")}`, proj.path) === "low");
  check("medium：rm 要审批", classifyLocally("rm -rf /tmp/audit-x", proj.path) === "medium");
  check("null：判不了的交出去（不自己下结论）", classifyLocally("node server.js", proj.path) === null);
  // fail-safe：判不了 + 没有分类器 → **要权限**，不是放行（这里踩过「静默全放行」）
  const approvals: { title: string }[] = [];
  const out = await executeOne(call("Bash", { command: "node server.js" }), minimalExecDeps(svc.tools, approvals));
  check("判不了且没有分类器 → 一律要权限（fail-safe 而不是 fail-open）", approvals.length === 1 && out.denied === true, "approvals=" + approvals.length);
}

console.log("=== 清单 A④ / B①：PTC 首轮就注入能力清单、入站帧判别 ===");
{
  // A④「PTC 首轮必须先注入 manifest」在 dove 上是**动态**版：脚本开头注入的 preamble 直接提供
  // doveTool / listTools / dove 三个全局（Alma 是一份静态 manifest），比 manifest 更不容易过期。
  // 真跑一段脚本验证（脚本只 console.log 类型，不碰网络；approve 是为了过 RunScript 的 always 审批）。
  const tools = svc.tools;
  // 安全带：脚本里真去调 doveTool 时必须打到**冒烟自己的**端口，绝不能落到用户在跑的
  // 8790 内核上（回显默认值就是 8790，这条环境变量是唯一的隔离点）。
  process.env.DOVE_PTC_API_URL = `http://127.0.0.1:${PORT}`;
  bindPtcRuntime("th_audit_exec", { tools, invoke: async () => ({ ok: true, output: {} }) });
  const approvals: { title: string }[] = [];
  const code = "console.log([typeof doveTool, typeof listTools, typeof dove].join(','))";
  const out = await executeOne(call("RunScript", { code, description: "探针" }), minimalExecDeps(tools, approvals, true));
  const r = (out.output ?? {}) as { stdout?: string; exitCode?: number };
  check("RunScript 首轮就弹审批（本地代码执行，approval=always）", approvals.length === 1 && /RunScript/.test(approvals[0]!.title), JSON.stringify(approvals));
  check("脚本真的跑起来了（exit 0）", out.ok === true && r.exitCode === 0, "exit=" + String(r.exitCode));
  check("preamble 注入的能力清单在首轮就可用了（doveTool/listTools/dove 都是函数）",
    r.stdout?.trim() === "function,function,function", JSON.stringify(r.stdout?.trim()));
}
{
  // B① 入站帧判别：dove 的「帧」是 HTTP 路由 —— /api/chat = generate_response，/api/steer = steer_generation。
  // 未知帧必须被明确拒绝，不能让「看不懂的请求」变成一次静默执行。
  const hub = new SseHub();
  const server = createServer((req, res) => {
    handle(req, res, { svc, hub, controlPanelDir: "", running: new Map() })
      .catch(() => { try { res.writeHead(500); res.end(); } catch { /* 客户端断了 */ } });
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
  const unknown = await fetch(`http://127.0.0.1:${PORT}/api/definitely-not-a-frame`);
  const bad = await post("/api/chat", { message: "没有 threadId" });
  const steer = await post("/api/steer", { threadId: "th_audit_steer", message: "插一句" });
  check("合法帧走通（/api/health）", health.status === 200, "status=" + health.status);
  check("未知帧被明确拒绝（404，不是静默忽略更不是执行）",
    unknown.status === 404 && (await unknown.json() as { error?: string }).error === "not found", "status=" + unknown.status);
  check("缺字段的 chat 帧被拒（400，不是拿空 message 跑一轮）",
    bad.status === 400 && /必填/.test(String((await bad.json() as { error?: string }).error)), "status=" + bad.status);
  check("steer 帧单独走插话队列（不与 chat 混一条路）",
    steer.status === 200 && svc.steering.pending("th_audit_steer"), "status=" + steer.status);
  svc.steering.clear("th_audit_steer");
  await new Promise<void>((r) => server.close(() => r()));
}

console.log("=== 清单 A② / A③：注入形态与 system 切分 ===");
{
  const msgs: ChatMessage[] = [
    { role: "user", content: "第一条" },
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
  ];
  const outMsg = applyTailContext(msgs, "now 2026-10-12", "## Memories\n1. 喜欢暖色");
  const blocks = outMsg[1]!.content as { type: string; text?: string }[];
  check("mt+记忆挂在**最后一条 user 消息**上（不是新插一条 system 消息）",
    outMsg.length === msgs.length && outMsg[1]!.role === "user" && outMsg.every((m) => m.role !== "system"), outMsg.map((m) => m.role).join(","));
  check("注入文本排在该消息最前面（缓存友好的前缀位置）",
    blocks[0]?.type === "text" && /^\[Context: now/.test(blocks[0]!.text ?? ""), JSON.stringify(blocks[0]).slice(0, 40));
  check("用户原文跟在注入之后（前缀 + 原文，不是覆盖）",
    String((blocks[1] as { text?: string } | undefined)?.text ?? "").includes("看图"), JSON.stringify(blocks[1]).slice(0, 40));
  // 不要求「并进第一个 text part」：一个 user 消息里带多个 text 块对 OpenAI 兼容端点合法，前缀位置
  // 也没变。Alma 那句约束的实质是「不许做独立 system 消息 + 前缀必须稳定」，上面两条钉住了；真正
  // 会坏事的是**把块状 content 压平成 JSON**（图片全丢），见下一条。
  check("图片块留在原位、没被压平成 JSON 文本", blocks.some((b) => b.type === "image_url"), JSON.stringify(blocks.map((b) => b.type)));
  check("历史消息不被污染", msgs[0]!.content === "第一条" && msgs[1]!.content !== outMsg[1]!.content);
}
{
  // A③：Anthropic/Bedrock 的 system 必须按 SYSTEM INFO 行切两段（易变内容排在缓存边界之后）。
  // dove 当前只接 OpenAI 兼容端点（bootstrap 传 dualSystem:false），所以这里把开关打开，断言
  // **真实装配出来的系统提示词**切得开 —— 否则哪天接上 Anthropic 才发现标记行没了。
  const p = makeProvider({ parent: [() => res("嗯")] });
  const rt = new AgentRuntime({
    ...base, provider: p.provider, memory: undefined, classifier: undefined,
    assemble: async (i) => ({ ...(await base.assemble(i)), dualSystem: true }),
  });
  await rt.run({ threadId: newThread(), userText: "在吗", sink: collector().sink });
  const systems = p.log.find((l) => l.role === "parent")!.messages.filter((m) => m.role === "system");
  check("dualSystem=true → system 真的切成两段", systems.length === 2, systems.length + " 段");
  check("第二段从 SYSTEM INFO 行开始（易变内容排在缓存边界之后）",
    /^SYSTEM INFO/.test(String(systems[1]?.content ?? "")), String(systems[1]?.content ?? "").slice(0, 30));
  check("第一段是稳定的冻结前缀（不含标记行，且不是空的）",
    !String(systems[0]?.content ?? "").includes("SYSTEM INFO") && String(systems[0]?.content ?? "").length > 200);
  const single = makeProvider({ parent: [() => res("嗯")] });
  await runtimeWith(single.provider).run({ threadId: newThread(), userText: "在吗", sink: collector().sink });
  const one = single.log.find((l) => l.role === "parent")!.messages.filter((m) => m.role === "system");
  check("对照：dualSystem 关闭时只有一段 system（不凭空多一段）", one.length === 1, one.length + " 段");
}

console.log("=== 看门狗兜底：进程边界 ===");
{
  // 看门狗：等待审批时暂停计量，但暂停自己必须有上限 —— 否则一次审批 = 整轮永久静音
  let capped = "", control = "";
  const a = new Watchdog((r) => { capped = r; }, 100, { maxPauseMs: 50 });
  const b = new Watchdog((r) => { control = r; }, 100, { maxPauseMs: 60_000 });
  a.start(); b.start(); a.pause(); b.pause();
  await new Promise((r) => setTimeout(r, 2_400));
  a.stop(); b.stop();
  check("暂停到上限后看门狗自己醒过来（兜底重新生效）", capped !== "", capped || "(一直没醒)");
  check("对照：暂停还在上限内时不误报", control === "", control || "(没错报)");
}

console.log("\n" + "=".repeat(56));
console.log(fail === 0 ? `全部通过（${pass}）` : `失败 ${fail} / ${pass + fail}`);
finish(svc, fail === 0 ? 0 : 1);
