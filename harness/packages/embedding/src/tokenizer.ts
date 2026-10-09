/**
 * BERT WordPiece 分词器（零依赖，自己实现）
 *
 * 为什么不用 transformers.js 自带的：它会连 onnxruntime-web(90MB) 和 sharp(17MB)
 * 一起拖下来，而我只跑纯文本 Node 推理，那两个完全用不上。
 * BERT 的分词算法是公开且稳定的，自己写一百多行，省 100MB+ 依赖。
 *
 * 算法（对齐 google-research/bert tokenization.py）：
 *   ① BasicTokenizer：清洗控制字符 → 中文/日文汉字两侧加空格 → 空白切分 →
 *      标点单独成 token → 小写化 → 去重音
 *   ② WordPieceTokenizer：对每个 token 贪心最长匹配，续接片段加 "##"
 *   ③ 加 [CLS] / [SEP]，按 maxLen 截断，生成 attention_mask
 */
import { readFileSync } from "node:fs";

/** BERT 里永远不拆的 token */
const NEVER_SPLIT = new Set(["[UNK]", "[SEP]", "[PAD]", "[CLS]", "[MASK]"]);
/** 视为空白 */
const isWhitespace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || /\p{Zs}/u.test(c);
/** 视为控制字符 */
const isControl = (c: string) => {
  const n = c.codePointAt(0) ?? 0;
  if (n === 0 || n === 0xfffd) return true;
  return (n >= 1 && n <= 8) || (n >= 0x0b && n <= 0x0c) || (n >= 0x0e && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
};
/** CJK 表意文字（和 BERT 一样要按字切开） */
function isCjk(c: string): boolean {
  const n = c.codePointAt(0) ?? 0;
  return (n >= 0x4e00 && n <= 0x9fff) || (n >= 0x3400 && n <= 0x4dbf)
      || (n >= 0x20000 && n <= 0x2a6df) || (n >= 0x2a700 && n <= 0x2b73f)
      || (n >= 0x2b740 && n <= 0x2b81f) || (n >= 0x2b820 && n <= 0x2ceaf) || (n >= 0xf900 && n <= 0xfaff);
}
/** 标点（ASCII 区间 + Unicode P 类） */
function isPunct(c: string): boolean {
  const n = c.codePointAt(0) ?? 0;
  if ((n >= 33 && n <= 47) || (n >= 58 && n <= 64) || (n >= 91 && n <= 96) || (n >= 123 && n <= 126)) return true;
  return /\p{P}/u.test(c);
}

export interface EncodeResult {
  inputIds: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
  tokens: string[];
}

export class WordPieceTokenizer {
  #vocab: Map<string, number>;
  #unkId: number;
  #clsId: number;
  #sepId: number;
  #padId: number;
  #maxLen: number;
  #doLowerCase: boolean;
  #maxCharsPerWord = 100;

  constructor(vocab: Map<string, number>, opts: { maxLen?: number; doLowerCase?: boolean } = {}) {
    this.#vocab = vocab;
    this.#unkId = vocab.get("[UNK]") ?? 100;
    this.#clsId = vocab.get("[CLS]") ?? 101;
    this.#sepId = vocab.get("[SEP]") ?? 102;
    this.#padId = vocab.get("[PAD]") ?? 0;
    this.#maxLen = opts.maxLen ?? 512;
    this.#doLowerCase = opts.doLowerCase ?? true;
  }

  /** 从 vocab.txt 加载（每行一个 token，行号即 id） */
  static fromVocabFile(path: string, opts: { maxLen?: number; doLowerCase?: boolean } = {}): WordPieceTokenizer {
    const lines = readFileSync(path, "utf8").split("\n");
    const vocab = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]!.replace(/\r$/, "");
      if (t.length === 0 && i === lines.length - 1) continue; // 末尾空行
      if (!vocab.has(t)) vocab.set(t, i);
    }
    return new WordPieceTokenizer(vocab, opts);
  }

  get vocabSize(): number { return this.#vocab.size; }
  /** 词表本体（createOnnxEmbedding 要拿它构造实例） */
  get vocabMap(): Map<string, number> { return this.#vocab; }

  /** ① BasicTokenizer */
  #basic(text: string): string[] {
    const out: string[] = [];
    let cur: string[] = [];
    const flush = () => { if (cur.length) { out.push(cur.join("")); cur = []; } };

    for (const ch of text.normalize("NFD")) {
      // 去掉组合用记号（重音）
      if (/\p{Mn}/u.test(ch)) continue;
      if (isControl(ch) || isWhitespace(ch)) { flush(); continue; }
      const c = this.#doLowerCase ? ch.toLowerCase() : ch;
      if (isCjk(c)) { flush(); out.push(c); continue; }
      if (isPunct(c)) { flush(); out.push(c); continue; }
      cur.push(c);
    }
    flush();
    return out;
  }

  /** ② WordPieceTokenizer：贪心最长匹配 */
  #wordpiece(token: string): string[] {
    if (token.length > this.#maxCharsPerWord) return ["[UNK]"];
    const chars = Array.from(token);
    const pieces: string[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: string | null = null;
      while (start < end) {
        const sub = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
        if (this.#vocab.has(sub)) { found = sub; break; }
        end -= 1;
      }
      if (found === null) return ["[UNK]"];
      pieces.push(found);
      start = end;
    }
    return pieces;
  }

  /** ③ 编码成模型输入 */
  encode(text: string, maxLen?: number): EncodeResult {
    const limit = Math.min(maxLen ?? this.#maxLen, this.#maxLen);
    const tokens: string[] = ["[CLS]"];
    for (const raw of this.#basic(text)) {
      if (NEVER_SPLIT.has(raw)) { tokens.push(raw); continue; }
      tokens.push(...this.#wordpiece(raw));
    }
    tokens.push("[SEP]");

    let ids = tokens.map((t) => this.#vocab.get(t) ?? this.#unkId);
    let toks = tokens;
    if (ids.length > limit) {
      // 保留首尾（[CLS] ... [SEP]）
      ids = [...ids.slice(0, limit - 1), this.#sepId];
      toks = [...toks.slice(0, limit - 1), "[SEP]"];
    }
    return {
      inputIds: ids,
      attentionMask: ids.map(() => 1),
      tokenTypeIds: ids.map(() => 0),
      tokens: toks,
    };
  }

  /** 批量编码：padding 到本批最长（BERT 要求矩形输入） */
  encodeBatch(texts: string[], maxLen?: number): { inputIds: number[][]; attentionMask: number[][]; tokenTypeIds: number[][] } {
    const enc = texts.map((t) => this.encode(t, maxLen));
    const width = Math.max(1, ...enc.map((e) => e.inputIds.length));
    return {
      inputIds: enc.map((e) => [...e.inputIds, ...new Array(width - e.inputIds.length).fill(this.#padId)]),
      attentionMask: enc.map((e) => [...e.attentionMask, ...new Array(width - e.attentionMask.length).fill(0)]),
      tokenTypeIds: enc.map((e) => [...e.tokenTypeIds, ...new Array(width - e.tokenTypeIds.length).fill(0)]),
    };
  }
}
