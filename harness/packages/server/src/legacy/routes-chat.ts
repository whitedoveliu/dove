/**
 * 老契约：对话相关路由（/api/chat 是核心）
 *
 * 与 python/agent_core.py 对齐的地方：
 *  - 事件词表与字段名（见 sse-compat.ts）
 *  - 「改了代码 → 提交 git → 自动构建 → preview_ready」这条尾巴
 *  - interrupted / locked 两个状态事件
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../bootstrap.ts";
import { json, readBody, projectIdToPort, portToProject, type LegacyProject } from "./server.ts";
import { toLegacy, sessionIdEvent, MODIFYING_TOOLS, type LegacyEvent } from "./sse-compat.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 项目里有没有可跑的构建脚本（没有就别假装构建失败） */
function hasBuildScript(dir: string): boolean {
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> };
      if (j.scripts?.build) return true;
    } catch { /* package.json 坏了也算没有 */ }
  }
  return existsSync(join(dir, "tools", "build.mjs"));
}

/** threadId → 中止控制器（/api/stop 用） */
const running = new Map<string, AbortController>();

/** projectId(port) → 用户对上次 ask_user 的回答（/api/user-input 用） */
const pendingAnswers = new Map<string, { toolCallId: string; answer: string }>();

export function getPendingAnswer(projectId: string): { toolCallId: string; answer: string } | undefined {
  return pendingAnswers.get(projectId);
}

function writeSse(res: ServerResponse, e: LegacyEvent): void {
  try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* 客户端断了 */ }
}

export async function handleChatRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  // ── POST /api/chat ─────────────────────────────────
  if (path === "/api/chat" && req.method === "POST") {
    const b = await readBody(req);
    const projectId = String(b.project_id ?? "");
    const message = String(b.message ?? "");
    const port = projectIdToPort(svc, projectId);
    const proj = port !== null ? portToProject(svc, port) : null;

    if (!proj) {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      writeSse(res, { type: "error", message: `找不到项目（project_id=${projectId}）。先在左侧新建一个任务。` });
      writeSse(res, { type: "done" });
      res.end();
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    const thread = svc.store.getOrCreateProjectThread(proj.id, proj.name);
    const ctrl = new AbortController();
    running.set(thread.id, ctrl);
    writeSse(res, sessionIdEvent(thread.id));

    let modified = false;
    let built = false;
    // ⚠️ 这个 ctx 必须**跨事件复用**（不能每次新建）—— 它带着工具调用的
    //    批次状态，每事件新建会让批处理失效，聊天区又变成一屏工具行。
    const legacyCtx = { hasBuilt: false, toolBurst: false };
    const sink = (e: { type: string; [k: string]: unknown }): void => {
      if (e.type === "tool_start" && MODIFYING_TOOLS.has(String(e.tool ?? ""))) modified = true;
      if (e.type === "tool:build" && e.ok === true) built = true;
      legacyCtx.hasBuilt = built;
      for (const le of toLegacy(e as never, legacyCtx)) {
        if (le.type === "build_error") built = false;
        writeSse(res, le);
      }
    };

    try {
      await svc.runtime.run({
        threadId: thread.id, userText: message, projectId: proj.id,
        model: b.model ? String(b.model) : undefined,
        signal: ctrl.signal, sink,
      });

      // 尾巴：改了代码 → 提交版本 → 自动构建 → preview_ready
      // （对齐 Python 版的 "if self.is_modified:" 那一段）
      if (modified) {
        try {
          const snap = await svc.projects.snapshot(proj.id, message.slice(0, 60) || "对话修改");
          if (snap.ok && snap.version) writeSse(res, { type: "commit", commit_hash: snap.version });
        } catch { /* 快照失败不影响对话 */ }

        if (!built) {
          // 项目还没有构建脚本（刚建的空项目）→ 安静跳过，
          // 别往前端丢 build_error 让用户看到没有意义的红条
          if (hasBuildScript(proj.path)) {
            writeSse(res, { type: "build_start" });
            writeSse(res, { type: "log", content: "🔨 正在构建预览..." });
            try {
              const r = await svc.projects.ops(proj.id).build();
              if (r.ok) {
                writeSse(res, { type: "log", content: "✅ 预览构建完成" });
                writeSse(res, { type: "preview_ready" });
              } else {
                writeSse(res, { type: "log", content: "⚠️ 预览构建失败，请检查代码" });
                writeSse(res, { type: "build_error", error: r.output.slice(-1_500) });
              }
            } catch (e) {
              writeSse(res, { type: "build_error", error: e instanceof Error ? e.message : String(e) });
            }
          } else {
            writeSse(res, { type: "preview_ready" });
          }
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) writeSse(res, { type: "interrupted" });
      else writeSse(res, { type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      running.delete(thread.id);
      writeSse(res, { type: "done" });
      try { res.end(); } catch { /* ignore */ }
    }
    return true;
  }

  // ── POST /api/stop ─────────────────────────────────
  // ⚠️ 老契约里这个接口**没有参数**（全局停）—— 前端连 body 都不发，
  //    而且页面关闭时走的是 sendBeacon({}) + Content-Type: text/plain，
  //    所以这里**绝不能强制解析 JSON body**，否则页面关闭时的停止会失败。
  if (path === "/api/stop" && req.method === "POST") {
    // 老契约里这个接口**没有参数**，会中止所有线程。
    // 但现在支持同时跑多个会话 —— 在 B 点停止不该把 A 也停了。
    // 所以加一个可选的 project_id：给了就只停它，没给保持老行为（全停）。
    let only: string | null = null;
    try {
      const b = await readBody(req);
      const key = String(b.project_id ?? b.session_id ?? "");
      if (key) {
        const port = projectIdToPort(svc, key);
        const proj = port !== null ? portToProject(svc, port) : null;
        if (proj) only = svc.store.getOrCreateProjectThread(proj.id, proj.name).id;
      }
    } catch { /* 没有 body 或解析失败 → 走全停（老行为） */ }

    let n = 0;
    for (const [threadId, c] of running) {
      if (only && threadId !== only) continue;
      c.abort("user"); running.delete(threadId); n++;
    }
    json(res, 200, { success: true, message: `已发送终止信号到 ${n} 个活动会话` });
    return true;
  }

  // ── POST /api/user-input（回答 ask_user）─────────────
  // 老契约请求体是 {session_id, answer} —— session_id 就是第一条 session_id 事件给的线程 id
  if (path === "/api/user-input" && req.method === "POST") {
    const b = await readBody(req);
    const sessionId = String(b.session_id ?? "");
    const answer = String(b.answer ?? "");
    if (!sessionId) { json(res, 404, { success: false, message: "缺少 session_id" }); return true; }

    // AnswerResolver 按线程路由；新内核的 AskUserQuestion 按 toolCallId 索引，
    // 这里取该线程当前在等的那一个问题来配平。
    let ok = false;
    // ① 先看是不是**工具审批**的回答（tool_approval 映射成了带「允许/拒绝」的 ask_user）
    try {
      const approvals = svc.pending.listPendingApprovals?.() ?? [];
      if (approvals.length > 0) {
        // 只有一个待审批时直接用；多个就按提交顺序取第一个
        const target = approvals[0]!;
        const yes = /^(允许|同意|allow|yes|ok|y)$/i.test(answer.trim());
        ok = svc.pending.resolveApproval(target.toolCallId, yes, yes ? undefined : answer);
      }
    } catch { ok = false; }
    // ② 不是审批 → 按 AskUserQuestion 处理
    if (!ok) {
      try {
        const q = svc.pending.listPendingQuestions?.() ?? [];
        const first = q.find((x) => !("threadId" in x) || (x as { threadId?: string }).threadId === sessionId) ?? q[0];
        if (first) ok = svc.pending.answer(first.questionId, answer);
      } catch { ok = false; }
    }
    json(res, 200, { success: true, message: ok ? "用户输入已提交" : "用户输入已提交（当前没有等待中的问题）" });
    return true;
  }

  // ── POST /api/retry（重试上一条）────────────────────
  if (path === "/api/retry" && req.method === "POST") {
    json(res, 200, { success: false, message: "重试请直接在对话框里再发一次（新内核按轮次处理）" });
    return true;
  }

  // ── POST /api/browser_result（浏览器回传，新内核用 BrowserConsole 工具，这里吞掉）──
  if (path === "/api/browser_result" && req.method === "POST") {
    await readBody(req);
    json(res, 200, { success: true });
    return true;
  }

  return false;
}

export type { LegacyProject };
