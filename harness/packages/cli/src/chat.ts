/**
 * `dove chat` —— 交互式 REPL：同一个线程连着聊多轮
 *
 * 为什么是「同一个线程」而不是每轮新建：内核的记忆、审批档、目标都挂在**线程**上，
 * 每轮换线程 = 每轮失忆，用户会以为模型变笨了。
 *
 * Ctrl+C 的语义要分两种（不然用户按一下就把整场对话弄没了）：
 *   正在跑 -> 停这一轮，留在 REPL；在提示符上 -> 退出。
 *
 * ⚠️ readline 必须用 `node:readline/promises` 那一份：回调版的 `question()` 返回 undefined，
 *    `await` 出来的是空值，`.trim()` 会抛错 —— 表现是 REPL 一进去就打印「再见」然后退出。
 */
import { createInterface } from "node:readline/promises";
import { flagBool, type Args } from "./args.ts";
import { api, type Target } from "./client.ts";
import { dim, cyan, red, EXIT, note, out } from "./out.ts";
import { streamTurn, inlineAllowed } from "./run.ts";
import { createThread, listThreads, resolveThread, NoThreadError, type ThreadInfo } from "./threads.ts";

const HELP = [
  "/exit            退出",
  "/new [标题]      另起一个线程接着聊",
  "/threads         列出线程",
  "/stop            停掉当前线程正在跑的回合（在别的终端也能用）",
  "/help            这页",
].join("\n");

export async function cmdChat(t: Target, a: Args): Promise<number> {
  if (!process.stdin.isTTY) {
    note(red("✗ ") + "dove chat 需要交互式终端。非交互场景请用：dove run \"消息\"");
    return EXIT.usage;
  }

  let current: ThreadInfo;
  try {
    current = await resolveThread(t, a, "CLI 会话");
  } catch (e) {
    if (e instanceof NoThreadError) {
      note(red("✗ ") + e.message);
      for (const h of e.hints) note(dim("   " + h));
      return EXIT.fail;
    }
    throw e;
  }

  const quiet = flagBool(a, "quiet");
  const verbose = flagBool(a, "verbose");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let busy = false;
  let ac: AbortController | null = null;

  rl.on("SIGINT", () => {
    if (busy && ac) {
      note("\n" + dim("正在停止这一轮…"));
      const conn = ac;
      // 先让内核停这一轮，再收自己这条连接 —— 顺序反了内核会继续跑完整个回合：
      // 客户端断开**不会**中止 runtime.run（只有 /api/stop 会），用户看到的是「按了 Ctrl+C 还在烧 token」。
      void api(t, "/api/stop", { body: { threadId: current.id }, timeoutMs: 3_000 })
        .catch(() => { /* 停不掉也得把自己的连接收掉，不然 REPL 卡在这儿 */ })
        .finally(() => conn.abort());
      return;
    }
    note("");
    rl.close();
  });

  note(cyan("Dove") + dim(` · 线程 ${current.id}（${current.title}）`));
  note(dim("直接输入消息即可；/help 看命令，/exit 退出。"));

  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question(dim("› "))).trim();
      } catch { break; }        // rl 被关掉（EOF / Ctrl+D / /exit）
      if (!line) continue;

      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.split(/\s+/);
        const arg = rest.join(" ").trim();
        if (cmd === "/exit" || cmd === "/quit") break;
        if (cmd === "/help") { note(HELP); continue; }
        if (cmd === "/new") {
          current = await createThread(t, { title: arg || "CLI 会话", kind: flagBool(a, "home") ? "home" : "project" });
          note(dim(`→ 新线程 ${current.id}（${current.title}）`));
          continue;
        }
        if (cmd === "/threads") {
          for (const th of await listThreads(t)) {
            const mark = th.id === current.id ? cyan("● ") : "  ";
            out(`${mark}${th.id}  ${dim(th.kind)}  ${th.title}`);
          }
          continue;
        }
        if (cmd === "/stop") {
          const r = await api<{ stopped?: boolean }>(t, "/api/stop", { body: { threadId: current.id }, timeoutMs: 5_000 });
          note(r.stopped ? "已停。" : dim("这个线程当前没有在跑的回合。"));
          continue;
        }
        note(dim(`不认识 /${cmd}，/help 看命令。`));
        continue;
      }

      busy = true;
      ac = new AbortController();
      try {
        const r = await streamTurn({
          target: t, threadId: current.id, message: line,
          quiet, verbose, interrupt: ac.signal, inline: inlineAllowed(a),
        });
        if (r.sawError) note(red("✗ ") + (r.errorText ?? "回合失败"));
      } catch (e) {
        note(red("✗ ") + (e instanceof Error ? e.message : String(e)));
      } finally {
        busy = false;
        ac = null;
        note("");
      }
    }
  } finally {
    rl.close();
  }
  note(dim("再见。"));
  return EXIT.ok;
}
