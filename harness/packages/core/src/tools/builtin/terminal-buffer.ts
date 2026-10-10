/**
 * 终端输出缓冲（terminal-session.ts 专用，零依赖）
 * 三件事：剥 ANSI/OSC、剥哨兵、**有上限的滚动缓冲**（丢头保尾 + sticky truncated）。
 * 为什么单独一层：会话模块贴着 400 行硬上限，缓冲逻辑混在一起就再也改不动了。
 */
export const MAX_BUFFER_LINES = 2000;        // 每会话滚动行数上限
export const MAX_BUFFER_CHARS = 256 * 1024;  // 每会话滚动字符上限
export const MAX_LINE_CHARS = 4000;          // 单行保护（无换行的巨型输出）

export interface LineBuffer {
  lines: string[];
  chars: number;
  total: number;    // 累计提交过多少行（含被丢掉的）
  dropped: number;  // 因上限被丢掉的头部行数
  truncated: boolean;   // sticky：丢过头就永远说「我丢过」
  partial: string;      // 还没换行的尾巴（提示符残渣 / 无换行输出）
}

export const newBuffer = (): LineBuffer =>
  ({ lines: [], chars: 0, total: 0, dropped: 0, truncated: false, partial: "" });

export function resetBuffer(b: LineBuffer): void {
  b.lines = []; b.chars = 0; b.total = 0; b.dropped = 0; b.truncated = false; b.partial = "";
}

const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\|$)|[PX^_][\s\S]*?(?:\u001b\\|$)|[@-Z\\-_])/g;
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 剥 CSI/OSC 与其它控制字符（保留 \n 与 \t） */
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "").replace(/\r/g, "").replace(CTRL_RE, "");

/** 清一行：剥 ANSI + 剥哨兵；整行只剩哨兵的返回 null（丢弃，避免提示符污染输出） */
export function cleanLine(raw: string, sentinel: string): string | null {
  let s = stripAnsi(raw);
  const had = s.includes(sentinel);
  if (had) { s = s.split(sentinel).join(""); s = s.replace(/^[ \t]+/, ""); }
  s = s.replace(/\s+$/, "");
  return had && s === "" ? null : s;
}

/** 哨兵出现次数（跨 chunk 计数由调用方负责拼尾巴） */
export function countHits(hay: string, needle: string): number {
  let n = 0, i = hay.indexOf(needle);
  while (i >= 0) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

export function pushLine(b: LineBuffer, line: string | null): void {
  if (line === null) return;
  b.lines.push(line);
  b.total++;
  b.chars += line.length + 1;
  while (b.lines.length > MAX_BUFFER_LINES || (b.chars > MAX_BUFFER_CHARS && b.lines.length > 1)) {
    b.chars -= b.lines.shift()!.length + 1;
    b.dropped++;
    b.truncated = true;
  }
}

/** 把新到的文本并进缓冲：提交完整行，留住未换行的尾巴 */
export function commitLines(b: LineBuffer, text: string, sentinel: string): void {
  b.partial += text;
  let idx = b.partial.indexOf("\n");
  while (idx >= 0) {
    pushLine(b, cleanLine(b.partial.slice(0, idx), sentinel));
    b.partial = b.partial.slice(idx + 1);
    idx = b.partial.indexOf("\n");
  }
  if (b.partial.length > MAX_LINE_CHARS) {   // 巨型无换行输出：强制切行，别让 partial 无限膨胀
    pushLine(b, cleanLine(b.partial.slice(0, MAX_LINE_CHARS), sentinel));
    b.partial = b.partial.slice(MAX_LINE_CHARS);
  }
}

/** 当前可见的全部行（已提交 + 未换行尾巴）—— TerminalRead 与 send 的 output 都用它 */
export function viewLines(b: LineBuffer, sentinel: string): string[] {
  const tail = cleanLine(b.partial, sentinel);
  return tail === null ? [...b.lines] : [...b.lines, tail];
}
