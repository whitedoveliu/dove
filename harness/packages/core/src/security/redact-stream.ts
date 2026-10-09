/**
 * 流式脱敏（T8.1：密钥/凭据永不出现在回复与日志）
 *
 * 为什么需要单独一个：助手回复是**逐 token 推流**的。
 * 如果只在最后脱敏，密钥已经推到界面上了；如果每块独立脱敏，
 * 跨块的密钥（被切成两半）就漏了。
 *
 * 做法：保留一个回看窗口，只放出「不可能再变成密钥」的那部分。
 */
import { redact } from "./redact.ts";
import type { RedactOptions } from "./redact.ts";

/** 回看窗口：任何单条规则匹配的最长长度都不能超过它，否则要特殊处理 */
export const LOOKBACK = 256;
/** 无结束标记的块（私钥、BEGIN…END）最多容忍这么长，超了就按原样放行并告警 */
export const MAX_UNCLOSED_BLOCK = 8_192;

const OPEN_MARKERS = ["-----BEGIN"];

/** 找出 buffer 里最后一个「已开始但没结束」的危险块起点；没有返回 -1 */
function unclosedBlockStart(buf: string): number {
  let idx = -1;
  for (const m of OPEN_MARKERS) {
    const start = buf.lastIndexOf(m);
    if (start < 0) continue;
    const endMarker = buf.indexOf("-----END", start);
    if (endMarker < 0 && start > idx) idx = start;
  }
  return idx;
}

export interface RedactStreamOptions extends RedactOptions {
  /** 命中时回调（用于日志/告警，不要把命中的原文传出去） */
  onHit?: (hits: Record<string, number>) => void;
}

/**
 * 流式脱敏器。
 * 用法：`push(delta)` 返回「现在可以安全发出去」的文本（可能为空串）；
 *       结束时必须调 `flush()`，否则最后一段会丢。
 */
export class RedactStream {
  #buf = "";
  #opts: RedactStreamOptions;
  #totalHits: Record<string, number> = {};
  #warnedUnclosed = false;

  constructor(opts: RedactStreamOptions = {}) { this.#opts = opts; }

  get hits(): Record<string, number> { return { ...this.#totalHits }; }

  #accumulate(hits: Record<string, number>): void {
    for (const [k, v] of Object.entries(hits)) this.#totalHits[k] = (this.#totalHits[k] ?? 0) + v;
    if (Object.keys(hits).length > 0) this.#opts.onHit?.(hits);
  }

  /** 喂入增量，返回可以安全放出的文本 */
  push(delta: string): string {
    this.#buf += delta;
    return this.#release(false);
  }

  /** 结束时调用：把剩下的全部放出（脱敏后） */
  flush(): string {
    return this.#release(true);
  }

  #release(final: boolean): string {
    if (this.#buf.length === 0) return "";

    // 未闭合的危险块：整块扣住，直到出现 END 或超过容忍上限
    const open = unclosedBlockStart(this.#buf);
    if (open >= 0) {
      const held = this.#buf.length - open;
      if (held <= MAX_UNCLOSED_BLOCK && !final) {
        const releasable = this.#buf.slice(0, open);
        this.#buf = this.#buf.slice(open);
        if (releasable.length === 0) return "";
        const r = redact(releasable, this.#opts);
        this.#accumulate(r.hits);
        return r.text;
      }
      if (held > MAX_UNCLOSED_BLOCK && !this.#warnedUnclosed) {
        this.#warnedUnclosed = true;
        this.#opts.onHit?.({ UNCLOSED_BLOCK: 1 });
      }
    }

    // 普通情况：扣住尾部 LOOKBACK 个字符，只放前面
    if (final) {
      const r = redact(this.#buf, this.#opts);
      this.#accumulate(r.hits);
      this.#buf = "";
      return r.text;
    }
    const cut = this.#buf.length - LOOKBACK;
    if (cut <= 0) return "";
    const head = this.#buf.slice(0, cut);
    this.#buf = this.#buf.slice(cut);
    const r = redact(head, this.#opts);
    this.#accumulate(r.hits);
    return r.text;
  }
}

/** 一次性脱敏一段完整文本（回复落库、日志写入用） */
export function redactText(text: string, opts: RedactOptions = {}): { text: string; hits: Record<string, number> } {
  return redact(text, opts);
}
