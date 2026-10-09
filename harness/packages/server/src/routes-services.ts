/**
 * M6 / M7 的服务路由（情绪 / 疲劳 / 定时 / 心跳 / 感知）
 * 从 routes.ts 拆出来 —— 那一份已经接近 400 行上限，而这几组路由是相对独立的一块。
 * 约定：所有服务都是**可选**的，没接入时返回结构化提示，绝不抛错。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "./bootstrap.ts";

type Body = () => Promise<Record<string, unknown>>;
type Json = (res: ServerResponse, code: number, data: unknown) => void;

/** 返回 true 表示这个请求已被处理 */
export async function handleServiceRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse,
  svc: Services, json: Json, readBody: Body,
): Promise<boolean> {
  // ── 情绪 / 疲劳（M6） ──────────────────────────────
  if (path === "/api/emotion" && req.method === "GET") {
    if (!svc.emotion) { json(res, 200, { available: false }); return true; }
    json(res, 200, { available: true, ...svc.emotion.getState() });
    return true;
  }
  if (path === "/api/emotion" && req.method === "POST") {
    if (!svc.emotion) { json(res, 200, { ok: false, note: "情绪服务未接入" }); return true; }
    const b = await readBody(req);
    const patch = { label: b.label ? String(b.label) : undefined, valence: typeof b.valence === "number" ? b.valence : undefined };
    if (b.layer === "base") svc.emotion.setBase(patch);
    else svc.emotion.setContext(patch, b.chatId ? String(b.chatId) : undefined);
    json(res, 200, { ok: true, ...svc.emotion.getState() });
    return true;
  }
  if (path === "/api/fatigue" && req.method === "GET") {
    json(res, 200, svc.fatigue ? { available: true, ...svc.fatigue.get() } : { available: false });
    return true;
  }
  if (path === "/api/fatigue" && req.method === "POST") {
    if (!svc.fatigue) { json(res, 200, { ok: false }); return true; }
    const b = await readBody(req);
    const action = String(b.action ?? "");
    if (action === "sleep") svc.fatigue.sleep();
    else if (action === "wake") svc.fatigue.wake();
    else if (action === "rest") svc.fatigue.rest(Number(b.minutes ?? 20));
    json(res, 200, { ok: true, ...svc.fatigue.get() });
    return true;
  }

  // ── 定时任务（M6） ─────────────────────────────────
  if (path === "/api/cron" && req.method === "GET") {
    json(res, 200, svc.cron ? { available: true, jobs: svc.cron.list() } : { available: false, jobs: [] });
    return true;
  }
  if (path === "/api/cron" && req.method === "POST") {
    if (!svc.cron) { json(res, 400, { error: "定时服务未接入" }); return true; }
    json(res, 200, svc.cron.create(await readBody(req)));
    return true;
  }
  if (path === "/api/cron/history" && req.method === "GET") {
    json(res, 200, svc.cron ? svc.cron.history(url.searchParams.get("id") ?? undefined, Number(url.searchParams.get("limit") ?? 50)) : []);
    return true;
  }
  const cronMatch = /^\/api\/cron\/([^/]+)$/.exec(path);
  if (cronMatch && req.method === "DELETE") {
    json(res, 200, { ok: svc.cron ? svc.cron.remove(decodeURIComponent(cronMatch[1]!)) : false });
    return true;
  }
  const cronRun = /^\/api\/cron\/([^/]+)\/run$/.exec(path);
  if (cronRun && req.method === "POST") {
    json(res, 200, svc.cron ? await svc.cron.runNow(decodeURIComponent(cronRun[1]!)) : { ok: false });
    return true;
  }
  // 启用/停用：面板直接用这个，不要再 DELETE + 重建（会丢 runCount）
  const cronEnable = /^\/api\/cron\/([^/]+)\/enable$/.exec(path);
  if (cronEnable && req.method === "POST") {
    if (!svc.cron) { json(res, 400, { error: "定时服务未接入" }); return true; }
    const b = await readBody(req);
    const on = b.enabled !== false;
    const ok = svc.cron.enable(decodeURIComponent(cronEnable[1]!), on);
    json(res, ok ? 200 : 404, { ok, enabled: on });
    return true;
  }

  // ── 心跳（M6） ─────────────────────────────────────
  if (path === "/api/heartbeat" && req.method === "POST") {
    json(res, 200, svc.heartbeat ? await svc.heartbeat.tick() : { ran: false, reason: "未接入" });
    return true;
  }

  // ── 感知（M7） ─────────────────────────────────────
  if (path === "/api/activity/status" && req.method === "GET") {
    json(res, 200, svc.activity ? { available: true, ...svc.activity.stats() } : { available: false });
    return true;
  }
  if (path === "/api/activity/capture" && req.method === "POST") {
    json(res, 200, svc.activity ? await svc.activity.captureNow("manual") : { skipped: "未接入" });
    return true;
  }
  if (path === "/api/activity/snapshots" && req.method === "GET") {
    json(res, 200, svc.activity ? svc.activity.listSnapshots(url.searchParams.get("date") ?? undefined, Number(url.searchParams.get("limit") ?? 50)) : []);
    return true;
  }
  if (path === "/api/activity/stats" && req.method === "GET") {
    json(res, 200, svc.activity ? { available: true, ...svc.activity.stats() } : { available: false });
    return true;
  }
  if (path === "/api/activity/accessibility-settings" && req.method === "POST") {
    const m = await import("../../core/src/activity/input-monitor.ts");
    m.openAccessibilitySettings();
    json(res, 200, { ok: true });
    return true;
  }
  if (path === "/api/activity/permission-settings" && req.method === "POST") {
    if (svc.activity) {
      const m = await import("../../core/src/activity/capture.ts");
      m.openPermissionSettings();
    }
    json(res, 200, { ok: true });
    return true;
  }
  if (path === "/api/activity/report" && req.method === "GET") {
    const kind = url.searchParams.get("kind") ?? "daily";
    if (!svc.activity) { json(res, 200, { report: "", note: "感知服务未接入" }); return true; }
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const report = kind === "weekly" ? await svc.activity.weeklyReport() : await svc.activity.dailyReport(date);
    json(res, 200, { kind, date, report });
    return true;
  }

  // ── MCP host（T3.12） ──────────────────────────────
  if (path === "/api/mcp" && req.method === "GET") {
    json(res, 200, svc.mcp
      ? { available: true, servers: svc.mcp.listServers(), toolCount: svc.mcp.toolCount() }
      : { available: false, servers: [], note: "MCP host 未接入" });
    return true;
  }
  if (path === "/api/mcp/reload" && req.method === "POST") {
    if (!svc.mcp) { json(res, 200, { ok: false, note: "MCP host 未接入" }); return true; }
    json(res, 200, { ok: true, ...(await svc.mcp.reload()) });
    return true;
  }
  const mcpConnect = /^\/api\/mcp\/([^/]+)\/connect$/.exec(path);
  if (mcpConnect && req.method === "POST") {
    if (!svc.mcp) { json(res, 400, { ok: false, error: "MCP host 未接入" }); return true; }
    const name = decodeURIComponent(mcpConnect[1]!);
    const r = await svc.mcp.connect(name);
    json(res, r.ok ? 200 : 400, r);
    return true;
  }

  return false;
}
