/**
 * 文件层 L1：SOUL / USER / MEMORY / HEARTBEAT + 每日日记（memory/YYYY-MM-DD.md）
 * 全部走原子写：临时文件写盘并 fsync 后再 rename，避免半截文件被注入 prompt。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const CORE_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"] as const;
export type CoreFileName = (typeof CORE_FILES)[number];

/** 注入下限：有意义的正文短于该长度，视为空文件 / 模板，跳过注入 */
export const MIN_INJECT_CHARS = 40;
export const MIN_DAILY_INJECT_CHARS = 16;

export interface PromptFiles {
  soul: string;
  user: string;
  memory: string;
  /**
   * [昨天, 今天]，空的已剔除。
   *
   * ⚠️ 带 date 是必须的 —— 消费方（assemble-adapter）要靠它拼出
   * `memory/<date>.md` 这个路径给模型看。原来只给内容字符串，
   * 适配器却按 { content, date } 解构，**daily 非空时必抛**
   * "Cannot read properties of undefined (reading 'trim')"，
   * 整个提示词装配退回降级版。而 daily 一直是空的（日记没写），
   * 所以这段代码从没执行过、也从没报过错 —— 直到日记功能上线。
   */
  daily: { date: string; content: string }[];
}

// ── 默认模板（Dove 人设；只在文件缺失时创建，绝不覆盖用户内容） ──

export const DEFAULT_SOUL: string =
  [
    "# SOUL · Dove",
    "",
    "> 灵魂文件：定义我是谁、怎么说话、怎么做事。每次对话都会注入，直接改。",
    "",
    "## 我是谁",
    "我是 Dove，一只常驻在工作台上的创意搭子：安静、可靠、有审美，把活干完再说话。",
    "",
    "## 怎么说话",
    "- 中文为主，短句，先给结论再给理由。",
    "- 不谄媚、不堆形容词；不确定就直说。",
    "- 少用感叹号，不用 emoji。",
    "",
    "## 怎么做事",
    "- 先读代码再改代码，先跑一遍再下结论。",
    "- 交付物优先：能跑、能看、能打开。",
    "- 记住偏好，不重复问同一个问题。",
    "- 破坏性操作先确认。",
    "",
    "## 不做的事",
    "- 不编造事实，不虚构文件内容。",
    "- 不为了讨好而附和。",
  ].join("\n") + "\n";

export const DEFAULT_USER: string =
  [
    "# USER · 关于我的主人",
    "",
    "> 只写长期有效的稳定事实与偏好；临时状态请写进每天的记忆日记。",
    "",
    "## 基本",
    "- 称呼：",
    "- 常用语言：中文",
    "",
    "## 偏好",
    "- （例：喜欢低饱和配色、克制的留白）",
    "",
    "## 禁忌",
    "- （例：不喜欢被反复追问同一件事）",
  ].join("\n") + "\n";

export const DEFAULT_MEMORY: string =
  [
    "# MEMORY · 长期记忆",
    "",
    "> 跨会话有效的结论与决定。只追加，不删除；过期内容由睡眠流水线归档。",
    "",
    "## 决定",
    "",
    "## 事实",
    "",
    "## 线索",
  ].join("\n") + "\n";

export const DEFAULT_HEARTBEAT: string =
  [
    "# HEARTBEAT · 主动性检查单",
    "",
    "> 每次心跳醒来时按这份清单自检；没事做就安静待着，不要刷存在感。",
    "",
    "- 有没有没跑完的任务？",
    "- 有没有值得主动汇报的进展？",
    "- 有没有快到期的事情需要提醒？",
  ].join("\n") + "\n";

// ── 日期工具（本地时区） ─────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 本地时区 YYYY-MM-DD */
export function localDate(d: Date = new Date()): string {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/** 相对今天偏移若干天的日期串 */
export function shiftDate(days: number, from: Date = new Date()): string {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + days);
  return localDate(d);
}

/** 剥掉 markdown 装饰与 HTML 注释，只留下真正有信息量的正文 */
export function meaningfulText(content: string): string {
  return (content ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s*/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/, "")
        .replace(/^\s*\d+[.)]\s+/, ""),
    )
    .join("\n")
    .replace(/[\s\u3000]+/g, "")
    .trim();
}

/** 空文件 / 纯模板（无有效正文）判定 */
export function isTemplateOnly(content: string, min: number = MIN_INJECT_CHARS): boolean {
  return meaningfulText(content).length < min;
}

// ── MemoryFiles ──────────────────────────────────────────────

export class MemoryFiles {
  #dir: string;
  #dailyDir: string;

  constructor(configDir: string) {
    this.#dir = configDir;
    this.#dailyDir = join(configDir, "memory");
  }

  get dir(): string {
    return this.#dir;
  }

  get dailyDir(): string {
    return this.#dailyDir;
  }

  path(name: string): string {
    return join(this.#dir, name);
  }

  dailyPath(date: string | Date = new Date()): string {
    const d = typeof date === "string" ? date : localDate(date);
    return join(this.#dailyDir, d + ".md");
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
  }

  read(name: string): string {
    const p = this.path(name);
    if (!existsSync(p)) return "";
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  }

  /** 原子覆盖写 */
  write(name: string, content: string): void {
    this.#atomic(this.path(name), content);
  }

  /** 读取 + 原子重写（文件很小，简单可靠优先） */
  append(name: string, content: string): void {
    const cur = this.read(name);
    const sep = cur && !cur.endsWith("\n") ? "\n" : "";
    const tail = content.endsWith("\n") ? "" : "\n";
    this.#atomic(this.path(name), cur + sep + content + tail);
  }

  readDaily(date: string | Date = new Date()): string {
    const p = this.dailyPath(date);
    if (!existsSync(p)) return "";
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  }

  today(): string {
    return this.readDaily(new Date());
  }

  yesterday(): string {
    return this.readDaily(shiftDate(-1));
  }

  /** 首次运行创建默认模板与目录（已存在的文件不动） */
  ensureDefaults(): void {
    if (!existsSync(this.#dir)) mkdirSync(this.#dir, { recursive: true });
    if (!existsSync(this.#dailyDir)) mkdirSync(this.#dailyDir, { recursive: true });
    const seeds: [CoreFileName, string][] = [
      ["SOUL.md", DEFAULT_SOUL],
      ["USER.md", DEFAULT_USER],
      ["MEMORY.md", DEFAULT_MEMORY],
      ["HEARTBEAT.md", DEFAULT_HEARTBEAT],
    ];
    for (const [name, body] of seeds) {
      if (!existsSync(this.path(name))) this.write(name, body);
    }
  }

  /** 组装注入用的文件内容；空的或太短的模板直接返回空串（不注入） */
  loadForPrompt(): PromptFiles {
    const daily = [
      // 注意 shiftDate(-1) 已返回 "YYYY-MM-DD" 字符串，不要再套 localDate
      { date: shiftDate(-1), content: this.yesterday() },
      { date: localDate(new Date()), content: this.today() },
    ]
      .map((d) => ({ date: d.date, content: isTemplateOnly(d.content, MIN_DAILY_INJECT_CHARS) ? "" : d.content.trim() }))
      .filter((d) => d.content.length > 0);
    return {
      soul: this.#pick("SOUL.md", MIN_INJECT_CHARS),
      user: this.#pick("USER.md", MIN_INJECT_CHARS),
      memory: this.#pick("MEMORY.md", MIN_INJECT_CHARS),
      daily,
    };
  }

  /** 追加到今天的日记 */
  captureDaily(content: string): void {
    const text = (content ?? "").trim();
    if (!text) return;
    const at = new Date();
    const body = text.startsWith("-") ? text : "- " + pad2(at.getHours()) + ":" + pad2(at.getMinutes()) + " " + text;
    const p = this.dailyPath(at);
    const cur = existsSync(p) ? this.readDaily(at) : "# " + localDate(at) + "\n\n";
    this.#atomic(p, cur.replace(/\n*$/, "\n\n") + body + "\n");
  }

  #pick(name: string, min: number): string {
    const raw = this.read(name);
    return isTemplateOnly(raw, min) ? "" : raw.trim();
  }

  #atomic(target: string, content: string): void {
    const d = dirname(target);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const tmp = target + "." + process.pid + "." + randomUUID().slice(0, 8) + ".tmp";
    try {
      const fd = openSync(tmp, "w");
      try {
        writeFileSync(fd, content, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, target);
    } catch (e) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // 清理失败可忽略
      }
      throw e;
    }
  }
}
