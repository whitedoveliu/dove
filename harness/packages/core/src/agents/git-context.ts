/**
 * `<git-context>` 任务前缀（子代理开工前的一小段现场说明）。
 *
 * 为什么需要：调查类子代理最容易走错的两件事 —— 不知道自己在哪个分支、
 * 不知道别人刚改了什么。给它这三行（分支 / 最近提交 / 脏文件）比让它自己先跑 4 条 git 命令便宜得多。
 *
 * ⚠️ 铁律：拼在**任务 prompt** 上，绝不进系统提示词。
 *    系统提示词一动，provider 的前缀缓存整段作废（agent/wire-history.ts 铁律二：
 *    缓存命中的长度 = 与历史请求逐字节相同的前缀长度，差一个字节就从那里开始全价重付）。
 *    而任务 prompt 每次都不一样，本来就是「新内容」，加它零成本。
 *
 * ⚠️ 纪律：**绝不能让 git 卡住一个子代理**。
 *    每条命令都有几百毫秒级的超时（SIGKILL），整段还有总预算；任何失败/超时/没装 git
 *    都静默退化成 `<git-context status="unavailable" .../>` —— 少一段背景，不欠一次事故。
 */
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

/** 单条 git 命令超时：几百毫秒级（大仓库上 git status 也可能很慢，超了就不要它） */
export const GIT_CONTEXT_TIMEOUT_MS = 500;
/** 整段的总预算：4 条命令最坏 4×500ms，超了就地收尾（宁缺勿慢） */
export const GIT_CONTEXT_TOTAL_BUDGET_MS = 1_200;
export const GIT_CONTEXT_MAX_DIRTY = 20;
export const GIT_CONTEXT_MAX_COMMITS = 3;
export const GIT_CONTEXT_LINE_MAX_CHARS = 200;
/** 只有这些 host 的 remote 才写出来（自建 git / 内网域名的 URL 可能带内部信息，不外传） */
export const GIT_REMOTE_ALLOWED_HOSTS: readonly string[] =
  ["github.com", "gitlab.com", "gitee.com", "bitbucket.org", "codeberg.org"];

export interface GitContextOptions {
  /** git 可执行文件（测试用：可以指向一个假 git，验证超时路径） */
  gitBin?: string;
  timeoutMs?: number;
  totalBudgetMs?: number;
  /** 环境（默认在 process.env 上补几条「别卡住」的开关） */
  env?: NodeJS.ProcessEnv;
}

type FailReason = "not-a-repo" | "no-git" | "timeout" | "error";
interface GitRun { ok: boolean; out: string; reason?: FailReason }

function safeEnv(over?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (over) return over;
  return {
    ...process.env,
    // 凭证提示会让 git 在等输入里静默挂住 —— 这是唯一一种「超时也救不回来」的卡法，必须关掉
    GIT_TERMINAL_PROMPT: "0",
    // 只读命令不要碰 index.lock（别在别人的仓库里留下锁）
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  };
}

/** 一行：压掉控制字符与多余空白，截到 200 字符 */
export function oneLine(s: string, n = GIT_CONTEXT_LINE_MAX_CHARS): string {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function runGit(gitBin: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): GitRun {
  try {
    const r = spawnSync(gitBin, args, {
      cwd, env, timeout: timeoutMs, maxBuffer: 256 * 1024,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      // SIGKILL：SIGTERM 交到 git 手里还能被它拖一会儿，而我们要的是「到点必死」
      killSignal: "SIGKILL",
    });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      return { ok: false, out: "", reason: code === "ENOENT" ? "no-git" : code === "ETIMEDOUT" ? "timeout" : "error" };
    }
    if (r.status !== 0) return { ok: false, out: "", reason: "not-a-repo" };
    return { ok: true, out: String(r.stdout ?? "") };
  } catch {
    // spawnSync 自己抛（cwd 不存在、参数非法）：绝不让它冒泡打断一个子代理
    return { ok: false, out: "", reason: "error" };
  }
}

function host(url: string): string | undefined {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]/.exec(url.trim());
  return m ? m[1]!.toLowerCase() : undefined;
}

export function unavailable(reason: FailReason): string {
  return `<git-context status="unavailable" reason="${reason}"/>`;
}

/**
 * 渲染 <git-context>。**永不抛错**：任何异常都变成 unavailable。
 * 非 git 仓库 → `<git-context status="unavailable" reason="not-a-repo"/>`。
 */
export function renderGitContext(workdir: string, opts: GitContextOptions = {}): string {
  const gitBin = opts.gitBin ?? "git";
  const perCall = Math.max(50, opts.timeoutMs ?? GIT_CONTEXT_TIMEOUT_MS);
  const budget = Math.max(perCall, opts.totalBudgetMs ?? GIT_CONTEXT_TOTAL_BUDGET_MS);
  const env = safeEnv(opts.env);
  const t0 = Date.now();
  let lastFail: FailReason = "not-a-repo";

  const call = (args: string[]): GitRun => {
    const left = budget - (Date.now() - t0);
    if (left <= 0) { lastFail = "timeout"; return { ok: false, out: "", reason: "timeout" }; }
    const r = runGit(gitBin, args, workdir, Math.min(perCall, left), env);
    if (!r.ok) lastFail = r.reason ?? "error";
    return r;
  };

  const top = call(["rev-parse", "--show-toplevel"]);
  if (!top.ok) return unavailable(top.reason ?? lastFail);

  const repo = top.out.trim().split("\n")[0]!.trim();
  const branchRun = call(["branch", "--show-current"]);
  // 空仓库（还没有第一个提交）时 branch --show-current 是拿得到的；拿不到再退回 rev-parse
  const branch = branchRun.ok && branchRun.out.trim()
    ? branchRun.out.trim()
    : (call(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim() || "HEAD");

  const remoteRun = call(["remote", "get-url", "origin"]);
  let remote = remoteRun.ok ? remoteRun.out.trim() : "";
  if (!remote) {
    const first = call(["remote"]);
    const name = first.ok ? first.out.trim().split("\n")[0]!.trim() : "";
    if (name) remote = call(["remote", "get-url", name]).out.trim();
  }
  const remoteHost = remote ? host(remote) : undefined;

  const statusRun = call(["status", "--porcelain"]);
  const dirty = statusRun.ok ? statusRun.out.split("\n").map((l) => l.trimEnd()).filter(Boolean) : [];

  const logRun = call(["log", "--oneline", "--no-decorate", "-n", String(GIT_CONTEXT_MAX_COMMITS)]);
  // ⚠️ 必须写成 (l) => oneLine(l)：直接把 oneLine 交给 map 的话，第二个参数是**下标**，
  //    会被当成截断长度 —— 第一条 commit（下标 0）会被截成「…」（踩过，排查了半天）
  const commits = logRun.ok ? logRun.out.split("\n").map((l) => oneLine(l)).filter(Boolean) : [];

  const lines = [
    "<git-context>",
    "Working directory: " + workdir,
    ...(remoteHost && GIT_REMOTE_ALLOWED_HOSTS.includes(remoteHost) ? ["Remote: " + oneLine(remote)] : []),
    "Project: " + (basename(repo) || repo),
    "Branch: " + oneLine(branch),
    "Dirty files: " + dirty.length,
    ...dirty.slice(0, GIT_CONTEXT_MAX_DIRTY).map((l) => "- " + oneLine(l)),
    ...(dirty.length > GIT_CONTEXT_MAX_DIRTY ? ["- … and " + (dirty.length - GIT_CONTEXT_MAX_DIRTY) + " more"] : []),
    ...(commits.length > 0 ? ["Recent commits:", ...commits.map((c) => "- " + c)] : []),
    "</git-context>",
  ];
  return lines.join("\n");
}

/** 把 <git-context> 拼在任务 prompt **前面**（不是系统提示词 —— 见文件头铁律） */
export function withGitContext(prompt: string, workdir: string, opts: GitContextOptions = {}): string {
  return renderGitContext(workdir, opts) + "\n\n" + prompt;
}
