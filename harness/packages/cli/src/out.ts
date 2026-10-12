/**
 * 终端输出：颜色、退出码、收尾
 *
 * 两条纪律：
 *   1. `--json` 时必须输出**纯 NDJSON**，任何一处忘了关色都会让 `jq` 解析失败 —— 所以颜色开关
 *      是模块级的，由 main 在建任何输出之前一次性定死，不给零散的调用点留自作主张的余地。
 *   2. 退出码要能被脚本区分：用法错误 2、连不上内核 3、内核报错 4、中断 130，
 *      这样 CI 里「我的脚本调错了」和「内核挂了」不会混成同一个 1。
 */
let color = process.stdout.isTTY === true && !process.env.NO_COLOR;

export function setColor(on: boolean): void {
  color = on;
}

export const paint = (code: string, s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s: string): string => paint("2", s);
export const bold = (s: string): string => paint("1", s);
export const red = (s: string): string => paint("31", s);
export const green = (s: string): string => paint("32", s);
export const yellow = (s: string): string => paint("33", s);
export const cyan = (s: string): string => paint("36", s);

/** 退出码表（写进 --help，也是脚本的契约） */
export const EXIT = { ok: 0, fail: 1, usage: 2, noKernel: 3, api: 4, interrupted: 130 } as const;

/** stdout（+ 换行）。注意：stdout 只放「结果」，人体向的提示一律走 stderr */
export function out(line = ""): void {
  process.stdout.write(line + "\n");
}

/** 不带换行的原始输出（流式文本用它，免得每个增量都换行） */
export function raw(s: string): void {
  process.stdout.write(s);
}

/** 人体向的提示 / 进度，走 stderr —— 这样 `dove run --json > out.ndjson` 时提示不会污染结果 */
export function note(line = ""): void {
  process.stderr.write(line + "\n");
}

/**
 * 收尾退出。
 *
 * 为什么不能直接 `process.exit(code)`：管道里还有没落地的字节时直接退出会把最后几行砍掉
 * （`dove logs | head` 这种现象）。所以先写一个空串把队列冲干净，回调里再退；
 * 定时器兜底（unref，不会自己吊住进程）防止某些平台上回调不来。
 */
export function exitAfterFlush(code: number): never {
  let done = false;
  const go = (): void => {
    if (done) return;
    done = true;
    process.exit(code);
  };
  process.exitCode = code;
  try { process.stdout.write("", go); } catch { go(); }
  try { process.stderr.write("", () => { /* stderr 不参与退出时机的判定 */ }); } catch { /* ignore */ }
  const t = setTimeout(go, 1_000);
  t.unref?.();
  return undefined as never;
}

export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return Math.round(ms) + "ms";
  const s = ms / 1000;
  return s < 60 ? s.toFixed(1) + "s" : Math.floor(s / 60) + "m" + Math.round(s % 60) + "s";
}

export function shortTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => (n < 10 ? "0" + n : String(n));
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 长文本单行化 + 截断（工具输入输出、消息预览都用它） */
export function oneLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
