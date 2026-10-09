/**
 * 老契约：会话日志路由（control-panel 的日志视图用）
 *
 * 前端 session-log-view.tsx 监听的是**命名事件**的 SSE：
 *   id: {seq}\nevent: record\ndata: {json}\n\n
 * 和 chat 流的匿名 data: 帧不是一回事，别搞混。
 *
 * ## 按项目过滤
 * 磁盘上是**按天一个全局文件**（logs/2026-10-05.jsonl），各项目的事件交错写在一起。
 * 但前端的日志视图是「某个项目的日志」，所以这里要过滤。
 *
 * 做法：**先过滤再分页** —— offset 的含义从「全局行号」变成「过滤后第 N 条」。
 * 对前端完全透明（它只是拿着 offset 往下翻），代价是每次要读整个文件。
 * 桌面端一天的日志也就几百 KB，够用；真要大了再上索引。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, watchFile } from "node:fs";
import { join } from "node:path";
import type { Services } from "../bootstrap.ts";
import { json, projectIdToPort, portToProject } from "./server.ts";
import { toolInfoLine } from "./sse-compat.ts";

/** 内核事件类型 → 前端认识的类型 */
const TYPE_MAP: Record<string, string> = {
  turn_start: "turn_start",
  turn_end: "turn_end",
  step_start: "step_start",
  assistant_text: "assistant_text",
  tool_call: "tool_call",
  tool_result: "tool_result",
  error: "error",
  // 前端没有对应类型，统一归到「系统」组的 agent_log
  compaction: "agent_log",
  repair: "agent_log",
  policy: "agent_log",
  redacted: "agent_log",
  task_injection: "agent_log",
  tool_approval: "ask_user",
};

/** data 字段改名：前端按固定的 key 读（读错就不显示） */
function mapData(type: string, d: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case "turn_start": return { message: d.userText ?? "" };
    case "step_start": return { label: "第 " + (d.step ?? "?") + " 步" };
    case "assistant_text": return { text: d.delta ?? d.text ?? "" };
    // ⚠️ 字段名必须对齐**内核实际发的**，不能凭想当然：
    //    内核 tool_call 发的是 { tool, toolCallId, input } —— 没有 info/args
    //    内核 tool_result 发的是 { tool, toolCallId, ok, preview } —— 没有 result
    //    映射写错的表现是「日志里 info/result 全是空」，但**不报错**，
    //    而且聊天区（走另一条 SSE 路径）是正常的，所以很难发现。实测踩过。
    case "tool_call": return { tool: d.tool ?? "", info: toolInfoLine((d.input ?? {}) as Record<string, unknown>) };
    case "tool_result": {
      const ok = d.ok !== false;
      const body = typeof d.preview === "string" ? d.preview : JSON.stringify(d.preview ?? "");
      return { result: (ok ? "" : "✗ ") + body.slice(0, 500) };
    }
    case "turn_end": return { status: d.reason ?? d.status ?? "done", duration_ms: d.durationMs ?? 0 };
    case "error": return { message: d.message ?? d.content ?? "未知错误" };
    default: return { text: typeof d === "object" ? JSON.stringify(d).slice(0, 400) : String(d) };
  }
}

interface RawRecord {
  v?: number; seq?: number; ts?: string; session?: string; project?: string;
  type?: string; data?: Record<string, unknown>;
  run?: string; turn?: number; step?: number;
}

/** 内核记录 → 前端记录 */
function toFrontend(r: RawRecord, project: string): RawRecord & { seq: number } {
  const raw = r.type ?? "agent_log";
  return {
    v: 1,
    seq: r.seq ?? 0,
    ts: r.ts ?? new Date().toISOString(),
    session: r.session ?? new Date().toISOString().slice(0, 10),
    run: r.run ?? "",
    project: r.project ?? project,
    turn: r.turn ?? 0,
    step: r.step ?? 0,
    type: TYPE_MAP[raw] ?? "agent_log",
    data: mapData(raw, r.data ?? {}),
  };
}

function logsDir(svc: Services): string {
  return join(svc.cfg.configDir, "logs");
}

function parseLines(text: string): RawRecord[] {
  return text.split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try { return [JSON.parse(l) as RawRecord]; } catch { return []; }
  });
}

/**
 * 这个项目相关的记录。
 * projectId 为空 = 不过滤（看全部）。
 */
function recordsFor(svc: Services, projectId: string, session: string): RawRecord[] {
  const p = join(logsDir(svc), session.replace(/[^A-Za-z0-9._\-]/g, "") + ".jsonl");
  if (!existsSync(p)) return [];
  const all = parseLines(readFileSync(p, "utf8"));
  if (!projectId) return all;
  return all.filter((r) => (r.project ?? "") === projectId);
}

/** 有该项目的记录才算「这个项目的日志」 */
function listSessionsFor(svc: Services, projectId: string): { id: string; file: string; size: number; modified: number; turns: number; last_type: string; last_ts: string; last_run: string }[] {
  const d = logsDir(svc);
  if (!existsSync(d)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(d).filter((f) => f.endsWith(".jsonl") && !f.startsWith("runtime-"));
  } catch { return []; }

  const out = [];
  for (const f of files) {
    const full = join(d, f);
    let st; try { st = statSync(full); } catch { continue; }
    const mine = projectId ? parseLines(readFileSync(full, "utf8")).filter((r) => (r.project ?? "") === projectId) : [];
    // 有项目过滤时，没记录的分片直接不列（否则会列出一堆空日志）
    if (projectId && mine.length === 0) continue;
    const last = mine[mine.length - 1];
    out.push({
      id: f.replace(".jsonl", ""),
      file: f,
      size: st.size,
      modified: Math.floor(st.mtimeMs / 1000),
      turns: mine.filter((r) => r.type === "turn_start").length,
      last_type: last ? (TYPE_MAP[last.type ?? ""] ?? "agent_log") : "",
      last_ts: last?.ts ?? "",
      last_run: last?.run ?? "",
    });
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

export async function handleLogRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  // 端口 → 项目 id（事件里记的是 id，不是端口）
  const resolve = (raw: string): { id: string; port: string } | null => {
    const port = portToProject(svc, Number(raw));
    return port ? { id: port.id, port: String(raw) } : null;
  };

  // ── GET /api/projects/{port}/sessions ──────────────
  const sMatch = /^\/api\/projects\/([^/]+)\/sessions$/.exec(path);
  if (sMatch && req.method === "GET") {
    const proj = resolve(sMatch[1]!);
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }
    const sessions = listSessionsFor(svc, proj.id);
    const today = new Date().toISOString().slice(0, 10);
    json(res, 200, {
      success: true, port: proj.port, dir: logsDir(svc),
      active_sessions: [], today, latest: sessions[0]?.id ?? today,
      sessions,
    });
    return true;
  }

  // ── GET /api/projects/{port}/session-log ───────────
  const lMatch = /^\/api\/projects\/([^/]+)\/session-log$/.exec(path);
  if (lMatch && req.method === "GET") {
    const proj = resolve(lMatch[1]!);
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }
    const sessions = listSessionsFor(svc, proj.id);
    const session = url.searchParams.get("session") ?? sessions[0]?.id ?? "";
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 5000);

    const mine = recordsFor(svc, proj.id, session);
    const slice = mine.slice(offset, offset + limit);
    const records = slice.map((r) => toFrontend(r, proj.id));
    const next = offset + slice.length;

    json(res, 200, {
      success: true, port: proj.port, session: session || null,
      path: join(logsDir(svc), session + ".jsonl"),
      records, offset: next, eof: next >= mine.length, size: mine.length,
      total: mine.length,
      ...(records.length === 0 ? { message: "该项目暂无会话日志" } : {}),
    });
    return true;
  }

  // ── GET /api/projects/{port}/session-log/stream（SSE，命名事件）──
  const stMatch = /^\/api\/projects\/([^/]+)\/session-log\/stream$/.exec(path);
  if (stMatch && req.method === "GET") {
    const proj = resolve(stMatch[1]!);
    if (!proj) { json(res, 404, { success: false, message: "项目不存在" }); return true; }
    const sessions = listSessionsFor(svc, proj.id);
    const session = url.searchParams.get("session") ?? sessions[0]?.id ?? "";
    const sinceSeq = Number(url.searchParams.get("since_seq") ?? req.headers["last-event-id"] ?? 0);
    const filePath = join(logsDir(svc), session.replace(/[^A-Za-z0-9._\-]/g, "") + ".jsonl");

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected " + filePath + " project=" + proj.id + " since_seq=" + sinceSeq + "\n\n");

    let pos = 0;
    let seq = sinceSeq;
    // 只发这个项目的；靠 seq 单调去重
    const push = (): void => {
      if (!existsSync(filePath)) return;
      try {
        const st = statSync(filePath);
        if (st.size < pos) pos = 0;
        if (st.size === pos) return;
        const buf = readFileSync(filePath);
        const chunk = buf.subarray(pos).toString("utf8");
        pos = st.size;
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          let rec: RawRecord;
          try { rec = JSON.parse(line) as RawRecord; } catch { continue; }
          if ((rec.seq ?? 0) <= sinceSeq) continue;
          if ((rec.project ?? "") !== proj.id) continue;   // ★ 只推本项目的
          const s = rec.seq ?? seq;
          seq = s;
          res.write("id: " + s + "\nevent: record\ndata: " + JSON.stringify({ ...toFrontend(rec, proj.id), seq: s }) + "\n\n");
        }
      } catch { /* ignore */ }
    };

    push();
    const timer = setInterval(push, 800);
    const stop = (): void => { clearInterval(timer); try { res.end(); } catch { /* ignore */ } };
    req.on("close", stop);
    req.on("error", stop);
    watchFile(filePath, { interval: 800 }, push);
    return true;
  }

  return false;
}
