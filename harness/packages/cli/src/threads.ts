/**
 * 线程相关：解析「这次操作哪个线程」+ `dove threads` 子命令
 *
 * 「哪个线程」这件事在 run / chat / steer / stop / goal 里都要做一遍，
 * 而且默认值的坑是踩过的：用户不写 --thread 时如果随手挑一个最近更新的线程，
 * 会莫名其妙跑进某个项目的会话里。所以默认值**只能是 home**
 * （它是常驻调度线程，本来就是「没有指定项目时的落脚点」）。
 */
import type { Args } from "./args.ts";
import { flagBool, flagStr, restText } from "./args.ts";
import { api, type Target } from "./client.ts";
import { bold, cyan, dim, EXIT, oneLine, out, shortTime } from "./out.ts";

export interface ThreadInfo {
  id: string;
  kind: string;
  title: string;
  projectId?: string | null;
  model?: string;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export async function listThreads(t: Target): Promise<ThreadInfo[]> {
  // GET /api/threads 顺带会 getOrCreateHomeThread()，所以拿到的一定有 home
  const list = await api<ThreadInfo[]>(t, "/api/threads", { timeoutMs: 8_000 });
  return Array.isArray(list) ? list : [];
}

export async function findThread(t: Target, id: string): Promise<ThreadInfo | undefined> {
  return (await listThreads(t)).find((x) => x.id === id);
}

export async function homeThread(t: Target): Promise<ThreadInfo | undefined> {
  return (await listThreads(t)).find((x) => x.kind === "home");
}

export async function createThread(
  t: Target, opts: { title: string; kind?: "home" | "project"; projectId?: string },
): Promise<ThreadInfo> {
  return api<ThreadInfo>(t, "/api/threads", {
    body: { kind: opts.kind ?? "project", title: opts.title, ...(opts.projectId ? { projectId: opts.projectId } : {}) },
    timeoutMs: 8_000,
  });
}

export class NoThreadError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[]) {
    super(message);
    this.name = "NoThreadError";
    this.hints = hints;
  }
}

/**
 * 按 --thread / --new / --home / 默认 home 定出目标线程。
 * `newTitle` 只在 --new 时用（run 会把消息开头的几个字当标题）。
 */
export async function resolveThread(
  t: Target, a: Args, newTitle?: string, options: { allowCreate?: boolean } = {},
): Promise<ThreadInfo> {
  const explicit = flagStr(a, "thread");
  if (explicit) {
    const th = await findThread(t, explicit);
    if (!th) {
      throw new NoThreadError(`线程 ${explicit} 不存在`, [
        "列出所有线程：dove threads list",
        "建一个新线程再跑：dove run --new \"你的消息\"",
      ]);
    }
    return th;
  }

  const wantNew = flagBool(a, "new");
  if (wantNew && options.allowCreate !== false) {
    const th = await createThread(t, {
      title: newTitle?.trim() || "CLI 会话",
      kind: flagBool(a, "home") ? "home" : "project",
    });
    return th;
  }

  const home = await homeThread(t);
  if (!home) throw new NoThreadError("内核里还没有 home 线程，而且这次也不让建", ["dove threads new --home \"标题\""]);
  return home;
}

// ── dove threads ────────────────────────────────────────────────

function showThread(th: ThreadInfo): string {
  const kind = th.kind === "home" ? cyan("home") : dim(th.kind);
  const when = th.updatedAt ? dim("  " + shortTime(th.updatedAt)) : "";
  return `${bold(th.id)}  ${kind}  ${th.title}${when}`;
}

export async function cmdThreads(t: Target, a: Args): Promise<number> {
  const action = a.sub || "list";

  if (action === "list" || action === "ls") {
    const list = await listThreads(t);
    if (flagBool(a, "json")) {
      out(JSON.stringify(list));
      return EXIT.ok;
    }
    if (list.length === 0) { out(dim("（没有线程）")); return EXIT.ok; }
    for (const th of list) out(showThread(th));
    return EXIT.ok;
  }

  if (action === "show") {
    const id = a.rest[0];
    if (!id) throw new Error("用法：dove threads show <id> [--limit 20]");
    const limit = Number(flagStr(a, "limit") ?? 20);
    const msgs = await api<unknown[]>(t, `/api/threads/${encodeURIComponent(id)}/messages?limit=${limit}`, { timeoutMs: 8_000 });
    if (flagBool(a, "json")) { out(JSON.stringify(msgs)); return EXIT.ok; }
    const th = await findThread(t, id);
    if (th) out(showThread(th));
    else out(dim(`${id}（内核的线程表里没有它，但消息接口有响应）`));
    out("");
    for (const m of msgs) out(renderMessage(m));
    return EXIT.ok;
  }

  if (action === "new") {
    const title = restText(a) ?? "CLI 会话";
    const th = await createThread(t, { title, kind: flagBool(a, "home") ? "home" : "project" });
    if (flagBool(a, "json")) out(JSON.stringify(th));
    else out(showThread(th));
    return EXIT.ok;
  }

  if (action === "rm" || action === "delete") {
    const id = a.rest[0];
    if (!id) throw new Error("用法：dove threads rm <id>");
    await api(t, `/api/threads/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 8_000 });
    out(flagBool(a, "json") ? JSON.stringify({ ok: true, id }) : `已删除 ${id}`);
    return EXIT.ok;
  }

  throw new Error(`不认识的 threads 动作：${action}（list / show / new / rm）`);
}

/** 一条消息 → 一行可读文本（text part 原样，工具 part 只给个摘要） */
export function renderMessage(m: unknown): string {
  const o = (m ?? {}) as Record<string, unknown>;
  const role = String(o.role ?? "?");
  const parts = Array.isArray(o.parts) ? (o.parts as Record<string, unknown>[]) : [];
  const text = parts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join("");
  const tools = parts.filter((p) => String(p.type).startsWith("tool-"))
    .map((p) => {
      const name = String(p.toolName ?? String(p.type).slice(5));
      const state = p.state === "output-available" ? "✓" : "…";
      return `${state}${name}`;
    });
  const head = role === "user" ? cyan("你") : role === "assistant" ? bold("Dove") : dim(role);
  const when = o.createdAt ? dim(shortTime(Number(o.createdAt))) : "";
  const body = [oneLine(text, 500), tools.length ? dim("[" + tools.join(" ") + "]") : ""].filter(Boolean).join(" ");
  return `${head} ${when}  ${body || dim("（无文本产出）")}`;
}
