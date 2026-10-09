/**
 * 屏幕内容索引与检索 —— 补上「截图 → OCR → SQLite → **检索**」里缺的最后一环。
 *
 * 之前的状态：OCR 文本写进 activity_ocr_frames 就没人管了，
 * 只有生成日报时会被读出来。agent 想「回忆我在屏幕上看到过什么」是做不到的。
 *
 * 为什么不用 FTS5：实测 node:sqlite 的 FTS5 **对中文基本没用** ——
 *   CREATE VIRTUAL TABLE t USING fts5(body)   → 查「飞书」0 行、「看板」0 行
 *   tokenize="trigram"                        → 查「飞书」仍 0 行（trigram 要 ≥3 字）
 * 所以自己做一个倒排索引：中文切 **2-gram**（「飞书」「书看」「看板」），
 * 西文按词切。这也和 tools/registry.ts 里工具检索的做法一致。
 */
import type { Db } from "../session/db.ts";

/** 索引表（SCHEMA_VERSION 3 加进来的） */
export const SCREEN_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS activity_ocr_terms (
  term        TEXT NOT NULL,
  frame_id    TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  session_id  TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  at          INTEGER NOT NULL,
  PRIMARY KEY (term, frame_id)
);
CREATE INDEX IF NOT EXISTS idx_ocr_terms_term ON activity_ocr_terms(term);
CREATE INDEX IF NOT EXISTS idx_ocr_terms_at ON activity_ocr_terms(at DESC);
`;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const LATIN = /[a-z0-9]/;

/**
 * 切词：中文出 2-gram（单字段也出 1-gram，好让「书」这种单字查得到），西文出小写词。
 * 例："Chrome 文件 编辑" → ["chrome","文 件"?no…] 实际 → ["chrome","文件","编辑"] + 单字
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  // 中文换行多半是显示折行，不是词边界：
  // OCR 把屏幕上折成两行的「紫水晶协议」读成 "紫水\n晶协\n议"，
  // 不合并的话「水晶」这个 2-gram 就永远建不出来。
  // 只把**两个中文字之间**的换行去掉，中英之间的换行保留。
  const joined = (text ?? "").replace(/([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s*\n\s*(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g, "$1");
  const lower = joined.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    const ch = lower[i]!;
    if (CJK.test(ch)) {
      // 连续的 CJK 段
      let j = i;
      while (j < lower.length && CJK.test(lower[j]!)) j++;
      const seg = lower.slice(i, j);
      if (seg.length === 1) out.push(seg);
      else for (let k = 0; k + 2 <= seg.length; k++) out.push(seg.slice(k, k + 2));
      i = j;
    } else if (LATIN.test(ch)) {
      let j = i;
      while (j < lower.length && LATIN.test(lower[j]!)) j++;
      const w = lower.slice(i, j);
      if (w.length >= 2) out.push(w);
      i = j;
    } else i++;
  }
  // 去重但保留计数由调用方做
  return out;
}

export interface ScreenHit {
  frameId: string;
  snapshotId: string;
  /** OCR 原文（已脱敏） */
  text: string;
  /** 命中的查询词 */
  matched: string[];
  score: number;
  at: number;
  appName?: string | null;
  windowTitle?: string | null;
  filePath?: string | null;
}

export interface ScreenSearchOptions {
  limit?: number;
  /** 只搜这个时间之后（毫秒） */
  since?: number;
  /** 只搜某个会话 */
  sessionId?: string;
}

export class ScreenIndex {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

  /** OCR 落库后调用：把这一帧的文本建成倒排条目 */
  index(frame: { id: string; snapshotId: string; sessionId?: string | null; text: string; at: number }): number {
    const toks = tokenize(frame.text);
    if (toks.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);

    // 一帧最多建 800 个词条，防止超长 OCR 把索引撑爆
    const entries = [...counts.entries()].slice(0, 800);
    this.#db.run("DELETE FROM activity_ocr_terms WHERE frame_id = ?", frame.id);
    for (const [term, n] of entries) {
      this.#db.run(
        "INSERT OR REPLACE INTO activity_ocr_terms(term, frame_id, snapshot_id, session_id, occurrences, at) VALUES (?,?,?,?,?,?)",
        term, frame.id, frame.snapshotId, frame.sessionId ?? null, n, frame.at,
      );
    }
    return entries.length;
  }

  /** 删帧时同步清索引 */
  unindex(frameId: string): void {
    this.#db.run("DELETE FROM activity_ocr_terms WHERE frame_id = ?", frameId);
  }

  /** 索引覆盖的帧数 */
  stats(): { terms: number; frames: number } {
    const a = this.#db.get("SELECT COUNT(1) n FROM activity_ocr_terms") as { n: number };
    const b = this.#db.get("SELECT COUNT(DISTINCT frame_id) n FROM activity_ocr_terms") as { n: number };
    return { terms: a?.n ?? 0, frames: b?.n ?? 0 };
  }

  /**
   * 检索屏幕内容。
   * 打分 = 命中词数（按 idf 加权） + 短语连续加成 + 时间近因加成。
   */
  search(query: string, opts: ScreenSearchOptions = {}): ScreenHit[] {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 5));
    const qTerms = [...new Set(tokenize(query))];
    if (qTerms.length === 0) return [];

    const marks = qTerms.map(() => "?").join(",");
    const where: string[] = [`term IN (${marks})`];
    const params: unknown[] = [...qTerms];
    if (opts.since) { where.push("at >= ?"); params.push(opts.since); }
    if (opts.sessionId) { where.push("session_id = ?"); params.push(opts.sessionId); }

    const rows = this.#db.all(
      `SELECT term, frame_id, occurrences, at FROM activity_ocr_terms WHERE ${where.join(" AND ")} LIMIT 4000`,
      ...params,
    ) as { term: string; frame_id: string; occurrences: number; at: number }[];
    if (rows.length === 0) return [];

    // 总帧数用于 idf
    const total = (this.#db.get("SELECT COUNT(DISTINCT frame_id) n FROM activity_ocr_terms") as { n: number })?.n ?? 1;

    const perFrame = new Map<string, { terms: Set<string>; at: number; occ: number }>();
    for (const r of rows) {
      let e = perFrame.get(r.frame_id);
      if (!e) { e = { terms: new Set(), at: r.at, occ: 0 }; perFrame.set(r.frame_id, e); }
      e.terms.add(r.term);
      e.occ += r.occurrences;
      if (r.at > e.at) e.at = r.at;
    }

    const now = Date.now();
    const hits: ScreenHit[] = [];
    for (const [frameId, e] of perFrame) {
      const matched = qTerms.filter((t) => e.terms.has(t));
      if (matched.length === 0) continue;
      // idf：越少见的词越值钱
      let score = 0;
      for (const t of matched) score += Math.log(1 + total / Math.max(1, this.#df(t)));
      // 命中比例（查询词覆盖度）
      score *= matched.length / qTerms.length;
      // 近因：24 小时内线性衰减
      const ageH = Math.max(0, (now - e.at) / 3_600_000);
      score += Math.max(0, 1.5 - ageH / 16);
      if (matched.length === qTerms.length) score += 0.8;
      hits.push({ frameId, snapshotId: "", text: "", matched, score, at: e.at });
    }

    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    if (top.length === 0) return [];

    // 补全正文与快照元信息
    const ids = top.map((h) => "?").join(",");
    const metas = this.#db.all(
      `SELECT f.id AS frame_id, f.snapshot_id, f.text,
              s.app_name, s.window_title, s.file_path
         FROM activity_ocr_frames f
         LEFT JOIN activity_snapshots s ON s.id = f.snapshot_id
        WHERE f.id IN (${ids})`,
      ...top.map((h) => h.frameId),
    ) as { frame_id: string; snapshot_id: string; text: string; app_name: string | null; window_title: string | null; file_path: string | null }[];
    const byId = new Map(metas.map((m) => [m.frame_id, m]));
    return top.map((h) => {
      const m = byId.get(h.frameId);
      return {
        ...h,
        snapshotId: m?.snapshot_id ?? "",
        text: m?.text ?? "",
        appName: m?.app_name ?? null,
        windowTitle: m?.window_title ?? null,
        filePath: m?.file_path ?? null,
      };
    });
  }

  /** 文档频率（idf 用）：懒加载 + 小缓存 */
  #dfCache = new Map<string, number>();
  #df(term: string): number {
    const c = this.#dfCache.get(term);
    if (c !== undefined) return c;
    const r = this.#db.get("SELECT COUNT(DISTINCT frame_id) n FROM activity_ocr_terms WHERE term = ?", term) as { n: number };
    const n = r?.n ?? 0;
    this.#dfCache.set(term, n);
    return n;
  }

  /** 把已经存在但没索引的 OCR 帧补齐（升级后跑一次） */
  rebuild(batch = 500): { indexed: number; frames: number } {
    const frames = this.#db.all(
      `SELECT f.id, f.snapshot_id, f.session_id, f.text, f.created_at
         FROM activity_ocr_frames f
        WHERE NOT EXISTS (SELECT 1 FROM activity_ocr_terms t WHERE t.frame_id = f.id)
        ORDER BY f.created_at ASC LIMIT ?`,
      batch,
    ) as { id: string; snapshot_id: string; session_id: string | null; text: string; created_at: number }[];
    let indexed = 0;
    for (const f of frames) {
      indexed += this.index({ id: f.id, snapshotId: f.snapshot_id, sessionId: f.session_id, text: f.text, at: f.created_at });
    }
    return { indexed, frames: frames.length };
  }
}
