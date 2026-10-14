/**
 * 冒烟：子代理过程能不能存下来、能不能取回去（A1 / A3 / A6 / A7）
 *
 * 为什么单独一个脚本：子代理的持久化是「点进去看它在干什么」的地基。
 * 在这之前过程完全不落盘，刷新就没 —— 而这条链路横跨
 * subagent-store → runtime → 路由 → partsToEvents 四层，
 * 任何一层断了都不会报错，只是界面上空着。必须端到端验。
 *
 * A7 起还验「后台 Agent」那两条：按页签过滤、卡片字段（模型 / 路径 / 用时）、
 * 过程条目**带工具结果**、以及重启后那条永远停在 running 的记录要判成 stale。
 */
import "./_isolate.ts";
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { finish } from "./_lifecycle.ts";
import { handleSubagentRoutes } from "../packages/server/src/legacy/routes-subagents.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, note = ""): void {
  if (ok) { pass++; console.log("  PASS  " + name + (note ? "   [" + note + "]" : "")); }
  else { fail++; console.log("  FAIL  " + name + (note ? "   [" + note + "]" : "")); }
}

/** 造一个假的 req/res 来直接调路由（不启 HTTP 服务） */
function callRoute(svc: never, rawPath: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const url = new URL("http://x" + rawPath);
    const res = {
      writeHead(status: number) { (this as never as { _s: number })._s = status; return this; },
      end(payload: string) {
        const self = this as never as { _s: number };
        resolve({ status: self._s ?? 200, body: JSON.parse(payload || "{}") as Record<string, unknown> });
      },
    };
    // 和真实服务一致：第一个参数是 url.pathname（查询串只走第二个参数）
    const handled = handleSubagentRoutes(url.pathname, url, { method: "GET" } as never, res as never, svc);
    void Promise.resolve(handled).then((h) => { if (!h) resolve({ status: 0, body: {} }); });
  });
}

console.log("=== 子代理过程持久化 ===");
const svc = await bootstrap(loadConfig());
// 先建一个项目：/subagents 路由是按项目查的，隔离库里没有项目会必然 404（那是测试的问题不是代码的）
const proj = svc.projects.create({ name: "子代理冒烟" });
const th = svc.store.getOrCreateProjectThread(proj.id, proj.name);

const seenIds = new Set<string>();
try {
  await svc.runtime.run({
    threadId: th.id,
    userText: "用 Task 派一个子代理，让它用 Bash 跑 echo hello，然后只回复：完成",
    sink: (e) => {
      if (e.subagentId && String(e.type).startsWith("subagent_")) seenIds.add(String(e.subagentId));
    },
  });
} catch (e) {
  check("回合跑完（子代理链路不炸）", false, String(e).slice(0, 120));
}

const subs = svc.store.listThreads("subagent");
check("子代理线程已建立", subs.length > 0, subs.length + " 条");
check("事件里带了 subagentId", seenIds.size > 0, [...seenIds].join(","));

const sub = subs[0];
if (sub) {
  const msgs = svc.store.listMessages(sub.id);
  const parts = msgs.flatMap((m) => m.parts as { type: string }[]);
  check("过程已落盘为消息", msgs.length > 0, msgs.length + " 条");
  check("parts 非空", parts.length > 0, parts.length + " 个");
  check(
    "parts 里有过程内容（reasoning/text/tool 之一）",
    parts.some((p) => p.type === "reasoning" || p.type === "text" || p.type.startsWith("tool-")),
    [...new Set(parts.map((p) => p.type))].join(","),
  );
  check("线程状态已收尾", String(sub.metadata?.status ?? "") !== "running", String(sub.metadata?.status));
  check("记了父线程", String(sub.metadata?.parentThreadId ?? "") === th.id);

  console.log("=== 路由取回 ===");
  const listRes = await callRoute(svc as never, "/api/projects/" + proj.id + "/subagents");
  check("GET /subagents 有响应（按项目 id 查）", listRes.status === 200, "status=" + listRes.status);
  const listed = (listRes.body.subagents as { id: string }[] | undefined) ?? [];
  check("列表里有这个子代理", listed.some((s) => s.id === sub.id), listed.map((s) => s.id).join(",") || "(空)");

  // 三键查找：按端口再查一次，结果应当一致
  const byPort = await callRoute(svc as never, "/api/projects/" + String(proj.port) + "/subagents");
  check("按端口查也认（三键查找）", byPort.status === 200, "status=" + byPort.status);

  const msgRes = await callRoute(svc as never, "/api/threads/" + sub.id + "/messages");
  check("GET /threads/{id}/messages 有响应", msgRes.status === 200, "status=" + msgRes.status);
  const evs = (msgRes.body.messages as { events: unknown[] }[] | undefined)?.flatMap((m) => m.events) ?? [];
  check("回放出的 events 非空", evs.length > 0, evs.length + " 条");

  // ── 「后台 Agent」列表（A7）：每行要够画一张卡片 ────────────
  console.log("=== 后台 Agent 列表 ===");
  type Row = {
    id: string; label: string; status: string; model: string | null; projectPath: string | null;
    startedAt: number; finishedAt: number | null; durationMs: number | null; usage: unknown;
  };
  const rows = (listRes.body.subagents as Row[] | undefined) ?? [];
  const row = rows.find((r) => r.id === sub.id);
  check("卡片字段齐全", !!row && typeof row.label === "string" && row.status === "done", row ? row.status : "(缺行)");
  check("带项目路径（卡片上那行仓库路径）", row?.projectPath === proj.path, String(row?.projectPath));
  check("记下了用的模型（不是未记录）", !!row?.model, String(row?.model));
  check("用时可供显示（结束了的行有毫秒数）", typeof row?.durationMs === "number" && row.durationMs >= 0, String(row?.durationMs));

  const doneRows = (await callRoute(svc as never, "/api/projects/" + proj.id + "/subagents?status=done")).body
    .subagents as Row[] | undefined;
  check("?status=done 里能找到它", (doneRows ?? []).some((r) => r.id === sub.id), (doneRows ?? []).map((r) => r.id).join(","));
  const runRows = (await callRoute(svc as never, "/api/projects/" + proj.id + "/subagents?status=running")).body
    .subagents as Row[] | undefined;
  check("?status=running 里没有它（已经跑完了）", !(runRows ?? []).some((r) => r.id === sub.id), (runRows ?? []).length + " 条");

  // 造一条「还在跑」的：页签过滤 + running 标记都要认（真跑的没法停在中间）
  svc.store.createThread({
    id: "sub_running_test", kind: "subagent", projectId: proj.id, title: "正在跑的子代理",
    metadata: {
      parentThreadId: th.id, label: "正在跑的子代理", status: "running", model: "deepseek-flash",
      ownerPid: process.pid,
    },
  });
  // 再造一条「记录说在跑，但那是**上一个进程**写的」—— 重启后的僵尸，必须判成 stale
  svc.store.createThread({
    id: "sub_zombie_test", kind: "subagent", projectId: proj.id, title: "重启前没跑完的",
    metadata: {
      parentThreadId: th.id, label: "重启前没跑完的", status: "running", model: "deepseek-flash",
      ownerPid: process.pid + 1,
    },
  });
  const runningRows = (await callRoute(svc as never, "/api/projects/" + proj.id + "/subagents?status=running")).body
    .subagents as Row[] | undefined;
  check("?status=running 认这一条", (runningRows ?? []).some((r) => r.id === "sub_running_test"), (runningRows ?? []).length + " 条");
  check("还在跑的：用时是 null（不假装已经跑完）",
    (runningRows ?? []).find((r) => r.id === "sub_running_test")?.durationMs === null,
    String((runningRows ?? []).find((r) => r.id === "sub_running_test")?.durationMs));
  check("重启后的僵尸不算「进行中」（判成 stale）", !(runningRows ?? []).some((r) => r.id === "sub_zombie_test"),
    (runningRows ?? []).map((r) => r.id).join(","));
  const zombie = ((await callRoute(svc as never, "/api/projects/" + proj.id + "/subagents")).body.subagents as Row[] | undefined ?? [])
    .find((r) => r.id === "sub_zombie_test");
  check("僵尸在「全部」里看得到，状态是 stale（界面显示「已中断」）", zombie?.status === "stale", String(zombie?.status));

  // ── 过程条目（点进去看它干了什么）────────────────────────
  console.log("=== 后台 Agent 过程 ===");
  type Entry = { kind: string; text?: string; tool?: string; info?: string; result?: string; ok?: boolean };
  const detail = await callRoute(svc as never, "/api/projects/" + proj.id + "/subagents/" + sub.id);
  check("GET /subagents/{id} 有响应", detail.status === 200, "status=" + detail.status);
  check("元信息对得上", (detail.body.subagent as Row | undefined)?.id === sub.id);
  check("跑完的：running=false", detail.body.running === false, String(detail.body.running));
  const entries = (detail.body.entries as Entry[] | undefined) ?? [];
  check("过程条目非空", entries.length > 0, entries.length + " 条");
  check("条目形状认得（kind 只有三种）", entries.every((e) => e.kind === "reasoning" || e.kind === "text" || e.kind === "tool"),
    [...new Set(entries.map((e) => e.kind))].join(","));
  const toolRows = entries.filter((e) => e.kind === "tool");
  check("过程里有工具调用行", toolRows.length > 0, toolRows.map((r) => r.tool).join(",") || "(空)");
  check("工具调用带结果（不是悬空的调用）",
    toolRows.length > 0 && toolRows.every((r) => !!r.result), toolRows.map((r) => (r.result ?? "").slice(0, 40)).join(" | "));
  check("工具行有参数摘要（和实时流同一个 toolInfoLine）", toolRows.every((r) => typeof r.info === "string"),
    toolRows.map((r) => r.info).join(" | "));
  // Bash echo hello 的结果应当在里面 —— 顺序也是有的（工具行在它那次调用之后）
  check("过程里留下了工具的原始输出", entries.some((e) => (e.result ?? "").includes("hello")),
    entries.filter((e) => e.result).map((e) => (e.result ?? "").slice(0, 30)).join(" | "));

  const runningDetail = await callRoute(svc as never, "/api/projects/" + proj.id + "/subagents/sub_running_test");
  check("还在跑的：running=true，过程为空（实时过程走 SSE）",
    runningDetail.body.running === true && ((runningDetail.body.entries as Entry[] | undefined) ?? []).length === 0,
    String(runningDetail.body.running) + " / " + String((runningDetail.body.entries as unknown[] | undefined)?.length));

  const nope = await callRoute(svc as never, "/api/projects/" + proj.id + "/subagents/sub_不存在");
  check("不存在的 id → 404", nope.status === 404, "status=" + nope.status);
}

console.log("=== 级联删除 ===");
const pThread = svc.store.getOrCreateProjectThread(proj.id, proj.name);
const sub2 = svc.store.createThread({
  id: "sub_cascade_test", kind: "subagent", projectId: proj.id, title: "临时子代理",
  metadata: { parentThreadId: pThread.id, status: "done" },
});
check("测试用子代理线程已建", svc.store.getThread(sub2.id) !== undefined);

// 复刻删除路由的查询：按 project_id 取线程
const ids = svc.db.all("SELECT id FROM threads WHERE project_id = ?", proj.id).map((r) => String(r.id));
check("级联查询覆盖到子代理线程", ids.includes(sub2.id), ids.join(","));

console.log("\n" + "=".repeat(56));
console.log(fail === 0 ? `全部通过（${pass}）` : `失败 ${fail} / ${pass + fail}`);
finish(svc, fail === 0 ? 0 : 1);
