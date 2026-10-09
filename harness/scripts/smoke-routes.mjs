#!/usr/bin/env node
/**
 * 路由冒烟：把**每一个** HTTP 端点都打一遍，断言没有 5xx、没有 error 字段。
 *
 * 为什么需要它：路由拆分时漏传参数（比如 url）不会让服务起不来，
 * 只会让某一个端点静默返回 {"error":"ReferenceError: ..."}。
 * 这种 bug 只有"逐个打一遍"才发现得了。
 *
 * 用法：先起内核，再 node scripts/smoke-routes.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:8790";

const GETS = [
  "/api/health", "/api/threads", "/api/config", "/api/memory", "/api/projects",
  "/api/emotion", "/api/fatigue", "/api/cron", "/api/cron/history", "/api/mcp",
  "/api/activity/status", "/api/activity/stats", "/api/logs?limit=5",
  "/api/pending", "/api/config/file?name=SOUL.md",
];

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; failures.push(name + " — " + detail); console.log("  ✗ " + name + " — " + detail); }
}

async function hit(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 也算通过，只要不是 5xx */ }
  return { status: res.status, text, json };
}

console.log("=== GET 端点 ===");
for (const p of GETS) {
  try {
    const r = await hit("GET", p);
    const isErr = r.json && typeof r.json === "object" && "error" in r.json && r.json.error;
    check(p, r.status < 500 && !isErr, `status=${r.status} ${isErr ? "error=" + String(r.json.error).slice(0, 80) : ""}`);
  } catch (e) {
    check(p, false, "请求抛错: " + (e instanceof Error ? e.message : String(e)));
  }
}

console.log("=== 带参数的端点（这类最容易在重构时漏参数） ===");
{
  const r = await hit("GET", "/api/threads");
  const th = Array.isArray(r.json) ? r.json[0] : null;
  if (!th) { check("取一个线程", false, "没有线程可测"); }
  else {
    const id = encodeURIComponent(th.id);
    for (const p of [`/api/threads/${id}/messages`, `/api/threads/${id}/messages?limit=5`]) {
      const rr = await hit("GET", p);
      const isErr = rr.json && typeof rr.json === "object" && "error" in rr.json;
      check(p.replace(id, "<id>"), rr.status < 500 && !isErr, `status=${rr.status} ${isErr ? String(rr.json.error).slice(0, 60) : ""}`);
    }
    const ro = await hit("POST", `/api/threads/${id}/readonly`, { enabled: false });
    check("POST /api/threads/<id>/readonly", ro.status < 500 && ro.json?.ok === true, "status=" + ro.status);
  }
}

console.log("=== 项目相关 ===");
{
  const created = await hit("POST", "/api/projects", { name: "路由冒烟" });
  const id = created.json?.id;
  check("POST /api/projects", created.status < 500 && !!id, "status=" + created.status);
  if (id) {
    for (const p of [`/api/projects/${id}/tree`, `/api/projects/${id}/versions`, `/api/files/${id}`]) {
      const rr = await hit("GET", p);
      const isErr = rr.json && typeof rr.json === "object" && "error" in rr.json;
      check(p.replace(id, "<id>"), rr.status < 500 && !isErr, `status=${rr.status}`);
    }
    const del = await hit("DELETE", `/api/projects/${id}`);
    check("DELETE /api/projects/<id>", del.status < 500 && del.json?.ok === true, "status=" + del.status);
    check("删除后从列表消失", !(await hit("GET", "/api/projects")).json?.some?.((x) => x.id === id), "仍在列表里");
  }
}

console.log("=== cron 全生命周期 ===");
{
  const c = await hit("POST", "/api/cron", { name: "冒烟任务", type: "every", schedule: "1h", mode: "isolated", prompt: "say hi" });
  const id = c.json?.id;
  check("POST /api/cron", c.status < 500 && !!id, "status=" + c.status);
  if (id) {
    const off = await hit("POST", `/api/cron/${id}/enable`, { enabled: false });
    check("停用", off.json?.ok === true && off.json?.enabled === false, JSON.stringify(off.json));
    const on = await hit("POST", `/api/cron/${id}/enable`, { enabled: true });
    check("启用", on.json?.ok === true && on.json?.enabled === true, JSON.stringify(on.json));
    const h = await hit("GET", `/api/cron/history?id=${id}`);
    check("历史", h.status < 500, "status=" + h.status);
    const d = await hit("DELETE", `/api/cron/${id}`);
    check("DELETE /api/cron/<id>", d.json?.ok === true, "status=" + d.status);
  }
}

console.log("=== 404 语义（不能崩） ===");
{
  const r = await hit("GET", "/api/definitely-not-a-route");
  check("未知路由返回 404", r.status === 404, "status=" + r.status);
  const t = await hit("GET", "/api/threads/not-exist/messages");
  check("不存在线程的消息", t.status < 500, "status=" + t.status);
}

console.log();
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log("失败清单："); for (const f of failures) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);
