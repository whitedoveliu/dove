#!/usr/bin/env node
/**
 * 「切走再回来还能看到那轮推理」的自测：`GET /api/stream` 的 attach / 重放 / 广播。
 * 运行：cd harness && node --no-warnings scripts/smoke-stream.ts
 *
 * 为什么要有它：面板的 SSE 原来只活在 `POST /api/chat` 那次连接上 —— 换任务、标签页切后台
 * 再回来，那轮推理（thinking / delta / 工具行）就再也看不到（消息历史要等回合结束才落库）。
 * 用户报的「切到其他页面，返回来就 bug 了」就是它。这里钉住三条契约：
 *   ① attach 帧（running / lastSeq）先到，且**不带 seq**（带了会把重放整个跳过去）；
 *   ② 晚挂上来的客户端能补到「它还看之前」的帧（after 过滤），之后跟着广播看增量；
 *   ③ 回合结束后再挂：running=false，但最近一回合的帧还在（客户端自己决定要不要用）。
 *
 * 起的是**进程内**内核（临时库 + 端口 8885），不碰用户正在跑的内核。
 * ⚠️ 验不了什么：真实浏览器里「面板切走/切回」的接线（那是面板侧的事）；
 *    runtime 是**桩**（真模型那一轮由 smoke-turn 之类的脚本覆盖）。
 */
import "./_isolate.ts";
import { createServer, request as httpRequest, type Server } from "node:http";
import { loadConfig, bootstrap, type Services } from "../packages/server/src/bootstrap.ts";
import { handle } from "../packages/server/src/routes.ts";
import { SseHub } from "../packages/server/src/sse.ts";
import { loadOrMintToken } from "../packages/server/src/local-token.ts";
import { startLegacyServer } from "../packages/server/src/legacy/server.ts";
import { finish } from "./_lifecycle.ts";

/** 8885：verify.sh 第 0 步的端口预检里也点名了它 */
const PORT = 8885;
process.env.DOVE_PORT = String(PORT);

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
  else { failed++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
};
const section = (t: string): void => { console.log("\n=== " + t + " ==="); };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame { event: Record<string, unknown>; seq: number | null }

/** 读一个 SSE 响应，收集帧（带 seq 的记下来，attach 这类不带 seq 的记 null） */
async function readSse(res: import("node:http").IncomingMessage, ms: number): Promise<Frame[]> {
  const frames: Frame[] = [];
  let buffer = "";
  let lastSeq: number | null = null;
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      const idLine = block.split("\n").find((l) => l.startsWith("id: "));
      if (dataLine !== undefined) {
        let event: Record<string, unknown> = {};
        try { event = JSON.parse(dataLine.slice(6)) as Record<string, unknown>; } catch { /* 忽略坏帧 */ }
        lastSeq = idLine === undefined ? null : Number(idLine.slice(4));
        frames.push({ event, seq: lastSeq });
      }
      idx = buffer.indexOf("\n\n");
    }
  };
  res.on("data", onData);
  await sleep(ms);
  res.off("data", onData);
  return frames;
}

const get = (path: string, headers: Record<string, string> = {}): Promise<import("node:http").IncomingMessage> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path, method: "GET", headers }, resolve);
    req.on("error", reject);
    req.end();
  });

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<import("node:http").IncomingMessage> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      { host: "127.0.0.1", port: PORT, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers } },
      resolve,
    );
    req.on("error", reject);
    req.end(payload);
  });

let svc: Services | null = null;
let server: Server | null = null;

try {
  svc = await bootstrap(loadConfig());
  const token = loadOrMintToken(svc.cfg.configDir);
  const hub = new SseHub();

  // runtime 只**覆写 run 一个方法**（慢桩），其余原样保留 ——
  // 兼容层那条路会走 runWithGoalContinuation，它还要读 runtime 上的其它字段；
  // 把整个 runtime 换成 {run} 会当场炸（"Cannot read properties of undefined (reading 'goals')"，冒烟抓到过）。
  const emittedBeforeAttach: string[] = [];
  const realRuntime = svc.runtime as unknown as { run: (...args: unknown[]) => Promise<{ assistantMessageId: string; endReason: string }> };
  realRuntime.run = async (args: unknown) => {
    const { threadId, sink, signal } = args as {
      threadId: string;
      sink: (e: Record<string, unknown>) => void;
      signal: AbortSignal;
    };
    for (let i = 1; i <= 6; i += 1) {
      if (signal.aborted) return { assistantMessageId: "stub", endReason: "aborted" };
      const text = `第${i}拍`;
      if (i <= 2) emittedBeforeAttach.push(text);
      sink({ type: "thinking", content: text });
      await sleep(120);
    }
    sink({ type: "text", content: `线程 ${threadId} 跑完了` });
    return { assistantMessageId: "stub-assistant", endReason: "stop" };
  };

  // ⚠️ running 必须是**同一个** Map：每个请求各传一个新的，等于 `/api/chat` 写进去的
  // 「这轮在跑」和 `/api/stream` 查的「在跑没跑」不是同一份状态（冒烟自己踩过：attach 永远 false）。
  const running = new Map<string, AbortController>();
  server = createServer((req, res) => {
    handle(req, res, { svc: svc!, hub, controlPanelDir: "", running, token })
      .catch(() => { try { res.writeHead(500); res.end(); } catch { /* ignore */ } });
  });
  await new Promise<void>((r) => server!.listen(PORT, "127.0.0.1", () => r()));

  const AUTH = { "X-Dove-Token": token };
  const threadId = "th_smoke_stream";

  // ── 1. 回合跑着的时候挂上来：attach + 重放 + 广播 ────────────────
  section("1. 中途挂上来（切走再回来）");
  const chat = await post("/api/chat", { threadId, message: "数到六" }, AUTH);
  chat.resume();                       // 不读它，但别让 socket 堵住
  await sleep(300);                    // 让桩先吐两拍（= 用户切走前已经看到的那部分）

  const attached = await get(`/api/stream?threadId=${threadId}`, AUTH);
  check("GET /api/stream 200 + text/event-stream",
    attached.statusCode === 200 && String(attached.headers["content-type"] ?? "").includes("text/event-stream"),
    "status=" + attached.statusCode);

  const frames = await readSse(attached, 1_400);
  const attach = frames[0]?.event;
  check("第一帧是 attach 且 running=true",
    attach?.type === "attach" && attach?.running === true,
    JSON.stringify(attach));
  check("attach 帧**不带 seq**（带了会把重放跳过去）", frames[0]?.seq === null);

  const replayed = frames.filter((f) => f.event.type === "thinking").map((f) => String(f.event.content));
  check("补到了「挂上来之前」那两拍（重放）",
    emittedBeforeAttach.length === 2 && emittedBeforeAttach.every((t) => replayed.includes(t)),
    "重放=" + replayed.join(","));
  check("也收到了挂上来之后的增量（广播）", replayed.length > emittedBeforeAttach.length,
    "总拍数=" + replayed.length);

  const seqs = frames.filter((f) => f.seq !== null).map((f) => f.seq as number);
  check("带 seq 的帧 seq 单调递增", seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), seqs.join(","));

  await sleep(900);                    // 等它跑完（桩总共约 720ms + text）
  const tail = await readSse(await get(`/api/stream?threadId=${threadId}&after=${seqs[seqs.length - 1] ?? 0}`, AUTH), 300);
  check("回合结束后再挂：running=false",
    tail[0]?.event.type === "attach" && tail[0]?.event.running === false,
    JSON.stringify(tail[0]?.event));
  check("after=<已看过的 seq> 只补后面的帧（不重复）",
    tail.slice(1).every((f) => (f.seq ?? 0) > (seqs[seqs.length - 1] ?? 0)),
    "补了 " + (tail.length - 1) + " 帧");

  // ── 2. 检查重放帧里含有结束帧（晚到的客户端知道"这轮完了"）────────
  section("2. 结束帧与重放边界");
  const replayAll = await readSse(await get(`/api/stream?threadId=${threadId}&after=0`, AUTH), 300);
  const kinds = replayAll.map((f) => String(f.event.type));
  check("最近一回合的帧里含 done（不是只有增量）", kinds.includes("done"), kinds.join(","));
  check("重放里也能看到那轮的正文本", replayAll.some((f) => f.event.type === "text"));

  const other = await readSse(await get("/api/stream?threadId=th_never_ran", AUTH), 250);
  check("没跑过的线程：attach(running=false) + 没有别的帧",
    other.length === 1 && other[0]?.event.type === "attach" && other[0]?.event.running === false,
    "帧数=" + other.length);

  const noId = await get("/api/stream", AUTH);
  check("缺 threadId → 400", noId.statusCode === 400, "status=" + noId.statusCode);
  noId.resume();

  // ── 3. 面板真正走的那条路：8008 兼容层发起 → 8790 重放 ─────────────
  // 这一节是**结构性问题**的回归：面板的 /api/chat 打在 8008 上（兼容层），而帧缓冲在 8790 的 hub 里。
  // 兼容层不往同一个 hub 记帧、不写同一份 running，这条 attach 就会永远 running=false、一帧都补不到。
  section("3. 兼容层（8008）发起，内核（8790）重放");
  const proj = svc!.projects.create({ name: "smoke-stream-proj" });
  const legacy = await startLegacyServer(svc!, 0, token, { hub, running });
  check("兼容层起得来（复用同一个 hub + running）", legacy !== null);
  if (legacy !== null) {
    const legacyPost = (path: string, body: unknown): Promise<import("node:http").IncomingMessage> =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = httpRequest(
          { host: "127.0.0.1", port: legacy.port, path, method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...AUTH } },
          resolve,
        );
        req.on("error", reject);
        req.end(payload);
      });
    const chat2 = await legacyPost("/api/chat", { message: "从兼容层发起", project_id: proj.port });
    // 200 不等于「跑起来了」：兼容层的「找不到项目」也是 200 + error 帧。
    // 所以这里把前几百毫秒的**帧**读下来，失败时贴出来（这一段是排障用的，不参与断言）。
    let seen = "";
    {
      chat2.setEncoding("utf8");
      const collect = (c: string): void => { seen += c; };
      chat2.on("data", collect);
      await sleep(400);
      chat2.off("data", collect);
    }
    check("兼容层 /api/chat 接受请求（200）", chat2.statusCode === 200, "status=" + chat2.statusCode + " " + seen.slice(0, 200));
    check("兼容层没有回错误帧（说明真的开跑了）", !seen.includes('"type":"error"'), seen.slice(0, 200).replace(/\n/g, " "));
    await sleep(300);
    const threadRow = svc!.store.getOrCreateProjectThread(proj.id, proj.name);
    const attached2 = await readSse(await get(`/api/stream?threadId=${threadRow.id}`, AUTH), 1_400);
    check("兼容层起的回合：8790 的 attach 也报 running=true",
      attached2[0]?.event.type === "attach" && attached2[0]?.event.running === true,
      JSON.stringify(attached2[0]?.event));
    const kinds2 = attached2.map((f) => String(f.event.type));
    check("重放的是**面板词表**的帧（兼容层记的那份）",
      kinds2.includes("thinking") || kinds2.includes("text"),
      kinds2.join(","));
    check("没有把内核词表混进来（例如 tool:build 这种不该直接给面板）",
      !kinds2.some((k) => k.startsWith("tool:")), kinds2.join(","));
    await sleep(900);
    const after2 = await readSse(await get(`/api/stream?threadId=${threadRow.id}&after=0`, AUTH), 300);
    check("跑完之后再挂：running=false 且帧还在",
      after2[0]?.event.type === "attach" && after2[0]?.event.running === false && after2.length > 1,
      "帧数=" + after2.length);
    legacy.close();
  }
} catch (e) {
  failed++;
  console.log("  ❌ 冒烟脚本自己抛了：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  try { server?.close(); } catch { /* ignore */ }
}
section("结果");
console.log("  通过 " + passed + " / 失败 " + failed);
console.log(failed === 0 ? "✅ 回合重挂（attach / 重放 / 广播）全部通过" : "❌ 有失败项，见上面");
finish(svc, failed === 0 ? 0 : 1);
