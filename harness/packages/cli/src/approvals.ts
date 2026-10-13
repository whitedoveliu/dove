/**
 * 审批与提问：`dove approve` / `dove answer`（外加 `dove pending` 的别名）
 *
 * 为什么这是 GUI 之外最实用的一条：工具审批在内核里是**阻塞等待**的（默认 5 分钟超时，
 * 超时按拒绝处理）。用户在终端里跑 `dove run`，模型要装依赖 / 越界写文件时，
 * 面板可能根本没开 —— 没有这个命令，那一轮就只能等超时白干。
 * 所以这里必须能在纯终端里把审批放行掉，且要能一次放行全部（挂机任务连放三个审批是常态）。
 */
import { createInterface } from "node:readline";
import { flagBool, flagStr, freeText, type Args } from "./args.ts";
import { api, type Target } from "./client.ts";
import { bold, cyan, dim, EXIT, note, out, red, yellow } from "./out.ts";
import { lastQuestion } from "./state.ts";

interface Pending {
  toolCallId: string;
  request?: { title?: string; message?: string; riskLevel?: string };
}

function describe(p: Pending): string {
  const q = p.request ?? {};
  return `${bold(p.toolCallId)}  ${yellow(String(q.riskLevel ?? "?"))}  ${String(q.title ?? "")}` +
    (q.message ? "\n    " + dim(String(q.message).replace(/\s+/g, " ").slice(0, 240)) : "");
}

/** 投一次审批决定。内核回 ok:false = 这条已经不在等待表里了（超时/已被处理） */
/**
 * @param remember 只对 approved 有意义：「同意并**记住**」——
 *   内核会把这次调用的参数模式（工具自报的 approvalRule）记进会话规则表，之后同形状的调用直接放行。
 *   默认 false：不问自记等于偷偷扩大授权，必须由用户显式要求。
 */
export async function decideApproval(t: Target, id: string, approved: boolean, reason?: string, remember?: boolean): Promise<boolean> {
  const r = await api<{ ok?: boolean }>(t, "/api/approve", {
    body: { toolCallId: id, approved, ...(reason ? { reason } : {}), ...(remember && approved ? { remember: true } : {}) }, timeoutMs: 8_000,
  });
  return r.ok === true;
}

export async function cmdApprove(t: Target, a: Args): Promise<number> {
  const list = await api<Pending[]>(t, "/api/pending", { timeoutMs: 8_000 });
  const listAll = Array.isArray(list) ? list : [];
  const one = flagStr(a, "tool-call-id") ?? flagStr(a, "id");
  const reason = flagStr(a, "reason");

  if (one) {
    const approved = !flagBool(a, "deny");
    const ok = await decideApproval(t, one, approved, reason, flagBool(a, "remember"));
    if (flagBool(a, "json")) { out(JSON.stringify({ toolCallId: one, approved, ok })); return ok ? EXIT.ok : EXIT.fail; }
    if (!ok) {
      note(red("✗ ") + `内核里没有 ${one} 这条待审批（可能已超时或被处理过）`);
      note(dim("  看一眼还有哪些：dove approve"));
      return EXIT.fail;
    }
    out(`${approved ? "已允许" : "已拒绝"} ${one}`);
    return EXIT.ok;
  }

  if (flagBool(a, "json")) { out(JSON.stringify(listAll)); return EXIT.ok; }

  if (listAll.length === 0) {
    out(dim("没有待审批的请求。"));
    return EXIT.ok;
  }

  const force = flagBool(a, "allow") || flagBool(a, "all");
  const denyAll = flagBool(a, "deny");

  // 显式给了 --allow/--deny：不问，直接批量处理（无人值守脚本要的就是这个）
  if (force || denyAll) {
    let n = 0;
    for (const p of listAll) if (await decideApproval(t, p.toolCallId, force, reason)) n++;
    out(`${force ? "已允许" : "已拒绝"} ${n}/${listAll.length} 条`);
    return n === listAll.length ? EXIT.ok : EXIT.fail;
  }

  if (!process.stdin.isTTY) {
    out(`${listAll.length} 条待审批：`);
    for (const p of listAll) out("  " + describe(p));
    note(dim("非交互模式：用 --allow / --deny / --tool-call-id <id> --deny 表态"));
    return EXIT.ok;
  }

  // 交互：一条一条问。s = 跳过（留给面板处理），q = 不问了
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let decided = 0;
  try {
    const answerAll = await new Promise<string>((resolve) => rl.question("全部允许？[a=全部允许 / n=逐条看] ", resolve));
    if (/^a/i.test(answerAll.trim())) {
      let n = 0;
      for (const p of listAll) if (await decideApproval(t, p.toolCallId, true, reason)) n++;
      out(`已允许 ${n}/${listAll.length} 条`);
      return EXIT.ok;
    }
    for (const p of listAll) {
      const ans = await new Promise<string>((resolve) => rl.question(describe(p) + "\n  允许？[y=允许 / n=拒绝 / s=跳过 / q=退出] ", resolve));
      const v = ans.trim().toLowerCase();
      if (v === "q") break;
      if (v === "s" || v === "") continue;
      const approved = v === "y" || v === "yes";
      if (await decideApproval(t, p.toolCallId, approved, reason)) { decided++; out(approved ? "  已允许" : "  已拒绝"); }
      else out(red("  这条已经不在等待表里了（超时或被别处处理）"));
    }
  } finally {
    rl.close();
  }
  out(dim(`处理了 ${decided} 条`));
  return EXIT.ok;
}

/** `dove pending` 只是 alias：列出待审批，不做决定 */
export async function cmdPending(t: Target, a: Args): Promise<number> {
  const list = await api<Pending[]>(t, "/api/pending", { timeoutMs: 8_000 });
  const items = Array.isArray(list) ? list : [];
  if (flagBool(a, "json")) { out(JSON.stringify(items)); return EXIT.ok; }
  if (items.length === 0) { out(dim("没有待审批的请求。")); return EXIT.ok; }
  out(`${items.length} 条待审批：`);
  for (const p of items) out("  " + describe(p));
  note(dim("表态：dove approve（交互） / dove approve --allow（全放行）"));
  return EXIT.ok;
}

export async function cmdAnswer(t: Target, a: Args): Promise<number> {
  const text = flagStr(a, "text") ?? freeText(a);
  let id = flagStr(a, "id") ?? flagStr(a, "tool-call-id");

  if (!id) {
    // 没给 id 就认「最近一次提问」—— 回答的人通常在另一个终端，不可能手抄 id
    const last = lastQuestion(t.port);
    if (last) {
      id = last.questionId;
      note(dim(`（回答最近一次提问：${last.brief || "(无正文)"}）`));
    }
  }
  if (!id) {
    note(red("✗ ") + "不知道该回答哪个问题");
    note(dim("  先跑 dove run，提问事件里会带 id；然后 dove answer --id <id> \"回答\""));
    return EXIT.usage;
  }
  if (!text) { note("用法：dove answer [--id <toolCallId>] \"回答内容\""); return EXIT.usage; }

  const r = await api<{ ok?: boolean }>(t, "/api/answer", { body: { questionId: id, answer: text }, timeoutMs: 8_000 });
  if (flagBool(a, "json")) { out(JSON.stringify({ questionId: id, answer: text, ok: r.ok === true })); return r.ok ? EXIT.ok : EXIT.fail; }
  if (!r.ok) {
    note(red("✗ ") + `内核里没有 ${id} 这个待答问题（可能已超时 —— 默认 5 分钟）`);
    note(dim("  正在等的问题会在 dove run 的输出里以「？提问」列出来"));
    return EXIT.fail;
  }
  out(`已投递回答（${cyan(id)}）`);
  return EXIT.ok;
}
