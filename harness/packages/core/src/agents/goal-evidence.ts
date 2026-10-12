/**
 * 取证 —— 把「这一轮到底动了什么」从**落库的事实**里抠出来，交给独立评估器。
 *
 * 为什么不能直接用模型的自我陈述：那正是要被独立核验的东西。这里的纪律是
 * 「谁说写了不算，盘上有没有才算」，所以：
 *   · 文件类证据 = 工具调用里出现过的路径 + **此刻磁盘上的真实内容**（读的时候再读一遍，
 *     模型可以在调用之后又把它删了/改了，评估器要看到的是现在的状态）；
 *   · 命令类证据 = 调用过的命令 + 它的 stdout/stderr/退出码；
 *   · 声称写过但盘上没有的文件，**照样进证据列表**（exists=false）—— 「说了没做」本身
 *     就是评估器最需要知道的事，过滤掉它等于帮模型圆谎。
 *
 * 取证只读消息 parts 与磁盘，不解析任何模型文本，所以这段没有可被模型左右的输入。
 */
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Message, ToolPart } from "../session/types.ts";
import { isToolPart } from "../session/types.ts";
import type { Store } from "../session/store.ts";

export interface EvidenceItem {
  kind: "file" | "command";
  /** 文件路径（绝对）或命令行 */
  ref: string;
  /** 文件类才有：此刻盘上是否存在 */
  exists?: boolean;
  /** 只报字节数，不把整份内容塞进提示词 */
  bytes?: number;
  detail: string;
}

export interface EvidenceOptions {
  workdir?: string;
  maxFiles?: number;
  maxCommands?: number;
  maxFileChars?: number;
  maxCmdChars?: number;
}

const DEFAULTS = { maxFiles: 12, maxCommands: 8, maxFileChars: 1500, maxCmdChars: 800 };

/** 写类工具 → 参数里哪个键是路径（各家模型给的键名不统一，这里全都认） */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATH_KEYS = ["file_path", "path", "filePath", "filename", "file"];

/** 读前 head 字节：自己算长度，避免一个 200MB 的产物把内核读爆 */
function readHead(p: string, max: number): { text: string; bytes: number } | null {
  try {
    const st = statSync(p);
    if (!st.isFile()) return null;
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(Math.min(max, st.size));
      if (buf.length > 0) readSync(fd, buf, 0, buf.length, 0);
      return { text: buf.toString("utf8"), bytes: st.size };
    } finally { closeSync(fd); }
  } catch { return null; }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function clip(s: string, n: number): string {
  const t = s.replace(/\r\n/g, "\n");
  return t.length > n ? t.slice(0, n) + "\n…（已截断，" + t.length + " 字符）" : t;
}

function pathOf(part: ToolPart): string | undefined {
  const input = asRecord(part.input);
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * 从消息里取证。**从后往前**扫，同一路径只留最后一次（最新内容才算数），
 * 这样长会话里同一个文件被改十遍也只占一条证据。
 */
export function collectEvidenceFromMessages(msgs: Message[], opts: EvidenceOptions = {}): EvidenceItem[] {
  const maxFiles = opts.maxFiles ?? DEFAULTS.maxFiles;
  const maxCommands = opts.maxCommands ?? DEFAULTS.maxCommands;
  const maxFileChars = opts.maxFileChars ?? DEFAULTS.maxFileChars;
  const maxCmdChars = opts.maxCmdChars ?? DEFAULTS.maxCmdChars;

  const files = new Map<string, EvidenceItem>();
  const commands: EvidenceItem[] = [];

  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (!isToolPart(p) || p.state === "permission-denied") continue;
      if (WRITE_TOOLS.has(p.toolName)) {
        // 写失败（output-error）→ 整条跳过：它没有任何落盘事实可核验，证据列表只放盘上真实存在的东西。
        // 但 **Bash 失败要留着**（见下面那个分支）：跑挂的测试输出正是评估器最该看到的证据。
        if (p.state === "output-error") continue;
        const raw = pathOf(p);
        if (!raw) continue;
        const abs = isAbsolute(raw) ? raw : resolve(opts.workdir ?? process.cwd(), raw);
        const head = readHead(abs, maxFileChars);
        files.set(abs, head
          ? { kind: "file", ref: abs, exists: true, bytes: head.bytes, detail: "写入 " + head.bytes + " 字节；当前磁盘内容（前 " + Math.min(maxFileChars, head.bytes) + " 字符）：\n```\n" + head.text + "\n```" }
          : { kind: "file", ref: abs, exists: false, detail: "模型调用过写工具，但此刻**磁盘上不存在这个文件**（声称写过 ≠ 写过）。" });
        continue;
      }
      if (p.toolName === "Bash") {
        const input = asRecord(p.input);
        const cmd = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
        if (!cmd) continue;
        const out = asRecord(p.output);
        const stdout = typeof out.stdout === "string" ? out.stdout : "";
        const stderr = typeof out.stderr === "string" ? out.stderr : "";
        const code = out.exit_code === undefined || out.exit_code === null ? "?" : String(out.exit_code);
        const body = [stdout.trim() ? "$ " + cmd + "\n" + clip(stdout.trim(), maxCmdChars) : "$ " + cmd].join("\n")
          + (stderr.trim() ? "\n[stderr] " + clip(stderr.trim(), maxCmdChars) : "")
          + "\n[exit_code] " + code;
        commands.push({ kind: "command", ref: cmd, detail: body });
        continue;
      }
    }
  }

  const fileList = [...files.values()].slice(-maxFiles);
  return [...fileList, ...commands.slice(-maxCommands)];
}

/**
 * 取「这一轮」的证据。
 *
 * sinceMessageId = 这一轮开跑之前线程里的最后一条消息 id。拿不到（被裁/被删）时退回
 * 尾部若干条 —— 宁可多带一点上一轮的痕迹，也不能因为拿不到锚点就交白卷（白卷会被判 FAIL，
 * 那是**证据不足**而不是没做事，两者对模型是完全不同的信号）。
 */
export function collectRoundEvidence(
  store: Store, threadId: string, opts: EvidenceOptions & { sinceMessageId?: string } = {},
): EvidenceItem[] {
  const msgs = store.recentMessages(threadId, 120);
  const idx = opts.sinceMessageId ? msgs.findIndex((m) => m.id === opts.sinceMessageId) : -1;
  const round = idx >= 0 ? msgs.slice(idx + 1) : msgs.slice(-40);
  return collectEvidenceFromMessages(round, opts);
}
