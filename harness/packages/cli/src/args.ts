/**
 * 命令行参数解析（零依赖）
 *
 * 为什么要有**显式的旗标表**，而不是「后面跟的 token 不像旗标就吃成值」：
 * 那种启发式在 `dove run --new "标题"` 上会把标题吃成 --new 的值，
 * 于是消息丢了、`--new` 变成了 true，用户只看到一句没头没尾的报错。
 * 布尔旗标和取值旗标必须分开写清楚，代价是维护一张表，收益是这类 bug 不会出现。
 */

/** 收值的旗标（全命令共用一张；名字不冲突就够了，不值得为每个子命令各配一套） */
const VALUE_FLAGS = new Set([
  "port", "thread", "id", "tool-call-id", "reason", "title", "kind", "model",
  "limit", "tail", "level", "objective", "max-rounds", "timeout", "workspace", "text",
]);

/** 纯开关 */
const BOOL_FLAGS = new Set([
  "help", "json", "quiet", "verbose", "home", "new", "all", "allow", "deny", "yes",
  "force", "no-color", "no-inline-approve", "local", "clear", "pause", "resume", "complete", "blocked", "follow",
]);

/** 单字母别名（只留最常用的几个，避免了 -p 这种一眼看不出来的暗号扩散） */
const SHORT: Record<string, string> = { h: "help", n: "limit", q: "quiet", t: "thread", y: "yes" };

/** 用法错误 —— main 会把它变成退出码 2（和「运行失败」区分开，脚本能据此判断是不是自己调错了） */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Args {
  /** 第一个位置参数 = 子命令（没有就是空串） */
  cmd: string;
  /** 第二个位置参数 = 子命令的动作，如 threads list 里的 list */
  sub: string;
  /** 其余位置参数（多个词的消息就是它们 join(" ")） */
  rest: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | boolean>();
  let literal = false;      // `--` 之后全部按位置参数处理（消息里带 - 开头的文本时用）

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (literal) { pos.push(a); continue; }
    if (a === "--") { literal = true; continue; }

    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2 && !/^\d$/.test(a.slice(1)))) {
      let name = a.replace(/^--?/, "");
      let value: string | undefined;
      const eq = name.indexOf("=");
      if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
      if (a.length === 2) { const full = SHORT[name]; if (!full) throw new UsageError(`不认识这个旗标：${a}`); name = full; }

      if (value !== undefined) { flags.set(name, value); continue; }
      if (VALUE_FLAGS.has(name)) {
        // 只看「下一个是不是另一个 --旗标」：值本身可能以 - 开头（`--text "-x"`），
        // 所以不能用「以 - 开头就当成旗标」这种宽判据，那会把合法的值也拒掉。
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} 需要一个值`);
        flags.set(name, next);
        i++;
        continue;
      }
      if (BOOL_FLAGS.has(name)) { flags.set(name, true); continue; }
      throw new UsageError(`不认识这个旗标：--${name}`);
    }

    pos.push(a);
  }

  return { cmd: pos[0] ?? "", sub: pos[1] ?? "", rest: pos.slice(2), flags };
}

export function flagStr(a: Args, name: string): string | undefined {
  const v = a.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function flagNum(a: Args, name: string): number | undefined {
  const v = flagStr(a, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} 需要一个数字，收到的是「${v}」`);
  return n;
}

export function flagBool(a: Args, name: string): boolean {
  return a.flags.get(name) === true;
}

/**
 * 「命令 + 整段文本」型子命令的正文（run / answer / steer 都是这个形状）：
 * 第二个位置参数就是正文本身，`--` 之后或分多次写的词继续接在后面。
 * 空 -> undefined，让调用方给用法提示，而不是发一条空消息。
 */
export function freeText(a: Args): string | undefined {
  const t = [a.sub, ...a.rest].join(" ").trim();
  return t.length ? t : undefined;
}

/**
 * 「命令 + 动作 + 整段文本」型子命令的正文（threads new <标题> / goal create <目标>）：
 * 动作已经占掉了第二个位置参数，正文从第三个开始。
 */
export function restText(a: Args): string | undefined {
  const t = a.rest.join(" ").trim();
  return t.length ? t : undefined;
}
