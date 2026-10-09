/**
 * 冒烟：子代理过程能不能存下来、能不能取回去（A1 / A3 / A6）
 *
 * 为什么单独一个脚本：子代理的持久化是「点进去看它在干什么」的地基。
 * 在这之前过程完全不落盘，刷新就没 —— 而这条链路横跨
 * subagent-store → runtime → 路由 → partsToEvents 四层，
 * 任何一层断了都不会报错，只是界面上空着。必须端到端验。
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
function callRoute(svc: never, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const res = {
      writeHead(status: number) { (this as never as { _s: number })._s = status; return this; },
      end(payload: string) {
        const self = this as never as { _s: number };
        resolve({ status: self._s ?? 200, body: JSON.parse(payload || "{}") as Record<string, unknown> });
      },
    };
    const handled = handleSubagentRoutes(path, new URL("http://x" + path), { method: "GET" } as never, res as never, svc);
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
