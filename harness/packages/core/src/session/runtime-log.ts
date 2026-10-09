/**
 * 运行时日志 —— 把 console 输出接进日志系统。
 *
 * 为什么需要：内核启动时会打一堆诊断（[dove] 向量后端、[mcp] 配置、
 * [activity] 屏幕权限…），这些只去了 stdout。**在桌面 App 里 stdout 没人接，
 * 等于全丢了** —— 出问题时用户和开发者都看不到任何线索。
 *
 * 做法：包一层 console，把它同时写到
 *   ① 进程内环形缓冲（给 /api/logs/runtime 实时读）
 *   ② <configDir>/logs/runtime-YYYY-MM-DD.jsonl（历史可查）
 *
 * 刻意与 EventLog 分开：EventLog 是**结构化业务事件**（turn/tool/usage），
 * 这里是**自由文本诊断**。混在一起会让两边的消费者都难受。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type RuntimeLevel = "log" | "info" | "warn" | "error" | "debug";

export interface RuntimeLine {
  ts: number;
  level: RuntimeLevel;
  text: string;
  /** 进程内序号，便于增量拉取 */
  seq: number;
}

/** 环形缓冲容量：够翻历史，又不至于把内存吃光 */
export const RUNTIME_RING = 2_000;
/** 单条最长字符数，防止有人打印巨大对象 */
export const RUNTIME_MAX_CHARS = 4_000;
/** 单个日志文件上限，超过就换一个（避免无限增长） */
export const RUNTIME_FILE_MAX_BYTES = 8 * 1024 * 1024;

let ring: RuntimeLine[] = [];
let seq = 0;
let dir = "";
let installed = false;
let orig: { log: typeof console.log; info: typeof console.info; warn: typeof console.warn; error: typeof console.error } | null = null;

const today = (): string => new Date().toISOString().slice(0, 10);

function currentFile(): string {
  const base = join(dir, `runtime-${today()}.jsonl`);
  try {
    if (existsSync(base) && statSync(base).size > RUNTIME_FILE_MAX_BYTES) {
      // 换一个分片，不动老的
      let i = 1;
      for (;;) {
        const alt = join(dir, `runtime-${today()}.${i}.jsonl`);
        if (!existsSync(alt) || statSync(alt).size < RUNTIME_FILE_MAX_BYTES) return alt;
        i++;
      }
    }
  } catch { /* ignore */ }
  return base;
}

/** 把任意参数转成一行文本（对象走 JSON，别打 [object Object]） */
export function stringify(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack ?? a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ").slice(0, RUNTIME_MAX_CHARS);
}

/**
 * 装桥。**幂等** —— 重复调用只生效一次。
 * @param configDir 日志目录的父目录（通常 ~/.dove）
 */
export function installRuntimeLog(configDir: string): void {
  dir = join(configDir, "logs");
  if (!existsSync(dir)) { try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }
  if (installed) return;
  installed = true;
  orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };

  const write = (level: RuntimeLevel, args: unknown[]): void => {
    const text = stringify(args);
    const line: RuntimeLine = { ts: Date.now(), level, text, seq: ++seq };
    ring.push(line);
    if (ring.length > RUNTIME_RING) ring = ring.slice(-RUNTIME_RING);
    try { appendFileSync(currentFile(), JSON.stringify(line) + "\n"); } catch { /* 磁盘满了也不能让主流程挂 */ }
  };

  // 原样转发到真正的 stdout，保证终端里照常看得见
  console.log = (...a: unknown[]) => { write("log", a); orig!.log(...a); };
  console.info = (...a: unknown[]) => { write("info", a); orig!.info(...a); };
  console.warn = (...a: unknown[]) => { write("warn", a); orig!.warn(...a); };
  console.error = (...a: unknown[]) => { write("error", a); orig!.error(...a); };
}

/** 卸载（测试用） */
export function uninstallRuntimeLog(): void {
  if (!installed || !orig) return;
  console.log = orig.log; console.info = orig.info; console.warn = orig.warn; console.error = orig.error;
  installed = false; orig = null; ring = []; seq = 0;
}

/** 读环形缓冲（给 API 用）。afterSeq 给增量拉取 */
export function readRuntimeLog(afterSeq = 0, limit = 500, level?: RuntimeLevel): RuntimeLine[] {
  let out = ring.filter((l) => l.seq > afterSeq);
  if (level) out = out.filter((l) => l.level === level);
  return out.slice(-limit);
}

/** 可从磁盘读历史分片 */
export function listRuntimeFiles(configDir: string): { file: string; size: number; mtime: number }[] {
  const d = join(configDir, "logs");
  if (!existsSync(d)) return [];
  try {
    return readdirSync(d)
      .filter((f) => f.startsWith("runtime-") && f.endsWith(".jsonl"))
      .map((f) => {
        const st = statSync(join(d, f));
        return { file: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

/** 读某个分片（尾部 limit 行） */
export function readRuntimeFile(configDir: string, file: string, limit = 500): RuntimeLine[] {
  const safe = file.replace(/[^A-Za-z0-9._\-]/g, "");
  const p = join(configDir, "logs", safe);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).flatMap((l) => {
      try { return [JSON.parse(l) as RuntimeLine]; } catch { return []; }
    });
  } catch { return []; }
}
