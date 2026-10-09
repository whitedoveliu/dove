/**
 * WebSearch —— 零依赖搜索，**多引擎降级**
 *
 * 为什么要多引擎：原来只写死 DuckDuckGo 的 HTML 端点，结果在受限网络里
 * 那个域名被 DNS 污染（实测解析到 104.244.43.248，是 Twitter 的 IP 段），
 * fetch 直接 "fetch failed"。而 WebFetch 替代不了搜索 ——
 * 它要你先知道 URL，查"某只股票的当前价格""某个报错怎么解"这类**时效性信息**
 * 根本无从下手。
 *
 * 实测各引擎在本机的可达性（2026-10-06）：
 *   Bing       302 → 跟随跳转后有 10 条 b_algo 结果   ✓ 可用
 *   DuckDuckGo 000（DNS 污染）                        ✗
 *   Google     000                                    ✗
 *   Brave      000                                    ✗
 *   Mojeek     403（判定为自动查询）                   ✗
 *   百度       页面能拿到，但结果结构随版本变          △ 兜底
 *
 * 顺序刻意是「Bing → DDG → 百度」：Bing 在两个网络环境下都能用，
 * DDG 在墙外更好，百度兜中文长尾。
 */
import { defineTool } from "../types.ts";
import { guarded, str, optNum } from "./util.ts";
import { htmlToText, decodeEntities } from "./web-fetch.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const TIMEOUT_MS = 20_000;

export interface SearchHit { title: string; url: string; snippet: string }

/** DuckDuckGo 的结果链接是跳转形式，取出真实 URL */
export function unwrapDdgUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) { try { return decodeURIComponent(m[1]!); } catch { return href; } }
  return href.startsWith("//") ? "https:" + href : href;
}

/** 过滤掉引擎自家的链接 */
const JUNK = /(^|\.)(bing|microsoft|msn|go\.micro|duckduckgo|baidu|bdstatic)\.com/i;

/**
 * 去掉「只有域名首页、又没有摘要」的结果。
 *
 * 实测：查「Vistra VST stock surge today news」，Bing 第一条给的是
 * 「Homepage | Vistra」—— 一个官网首页，**没有任何信息量**，
 * 模型拿到它只能再去 WebFetch，白跑一轮。
 * 有摘要的首页保留（至少能提供一句话线索）。
 */
export function isLowValue(h: { url: string; title: string; snippet: string }): boolean {
  if (h.snippet && h.snippet.trim().length >= 20) return false;
  try {
    const u = new URL(h.url);
    if (u.pathname === "/" || u.pathname === "") return true;
  } catch { /* 解析不了就保留 */ }
  return false;
}

/** 按 URL 去重（不同引擎可能给同一个站点的不同参数链接） */
export function dedupe(hits: { url: string }[]): typeof hits {
  const seen = new Set<string>();
  return hits.filter((h) => {
    let key = h.url;
    try { const u = new URL(h.url); key = u.host + u.pathname.replace(/\/$/, ""); } catch { /* ignore */ }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clean(u: string): string {
  try {
    const url = new URL(u);
    // 去掉追踪参数，只留干净地址
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|spm|from|wd|rsv)/i.test(k)) url.searchParams.delete(k);
    }
    return url.toString();
  } catch { return u; }
}

async function get(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

/** Bing：结果在 <li class="b_algo"><h2><a href="...">标题</a></h2>…<p>摘要</p> */
export async function searchBing(q: string, limit: number): Promise<SearchHit[]> {
  const html = await get("https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=zh-CN");
  const out: SearchHit[] = [];
  // 注意 <h2 class=""> 不是裸 <h2>（实测踩过：写成 <h2> 一条都匹配不到）
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)(?=<\/li>|<li class="b_algo"|$)/g;
  for (const m of html.matchAll(re)) {
    const url = decodeEntities(m[1] ?? "");
    if (!/^https?:/i.test(url) || JUNK.test(url)) continue;
    const title = htmlToText(m[2] ?? "");
    const cap = /<p[^>]*>([\s\S]*?)<\/p>/.exec(m[3] ?? "");
    const snippet = htmlToText(cap?.[1] ?? "");
    if (!title || title.length < 2) continue;
    out.push({ title, url: clean(url), snippet });
    if (out.length >= limit) break;
  }
  return out;
}

/** DuckDuckGo HTML 端点（墙外可用） */
export async function searchDdg(q: string, limit: number): Promise<SearchHit[]> {
  const html = await get("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "q=" + encodeURIComponent(q),
  });
  const out: SearchHit[] = [];
  const blocks = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  for (const b of blocks) {
    const url = unwrapDdgUrl(decodeEntities(b[1] ?? ""));
    const title = htmlToText(b[2] ?? "");
    const start = (b.index ?? 0) + b[0].length;
    const win = html.slice(start, start + 4_000);
    const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(win);
    if (!title || !/^https?:/i.test(url)) continue;
    out.push({ title, url: clean(url), snippet: htmlToText(sn?.[1] ?? "") });
    if (out.length >= limit) break;
  }
  return out;
}

/** 百度：结构随版本变，用宽松匹配兜底 */
export async function searchBaidu(q: string, limit: number): Promise<SearchHit[]> {
  const html = await get("https://www.baidu.com/s?wd=" + encodeURIComponent(q));
  const out: SearchHit[] = [];
  const re = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/g;
  for (const m of html.matchAll(re)) {
    const url = decodeEntities(m[1] ?? "");
    const title = htmlToText(m[2] ?? "");
    if (!title || !/^https?:/i.test(url) || JUNK.test(url)) continue;
    out.push({ title, url: clean(url), snippet: "" });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Tavily Search API —— **有 key 时优先用它**。
 *
 * 为什么值得引一个外部依赖：实测同样的查询，差距是数量级的 ——
 *   查 "Vistra VST stock price today"
 *   Bing  → "Homepage | Vistra" / "Vistra: Corporate Business Service Provider"
 *           （卓佳，中国企业服务公司 —— **完全不是**纽交所的 Vistra Corp）
 *   Tavily→ kraken.com / robinhood.com / investing.com 的 VST 实时报价
 *           score 0.93~0.95，而且全是正确的那家公司
 *
 * 抓搜索引擎的 HTML 只能给到首页、还会认错实体；搜索 API 带相关性打分，
 * 并且能直接给 answer。
 */
export async function searchTavily(q: string, limit: number, key: string): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query: q,
      max_results: Math.min(Math.max(limit, 1), 20),
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error("tavily HTTP " + res.status);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).flatMap((r) => {
    const url = String(r.url ?? "");
    if (!/^https?:/i.test(url)) return [];
    return [{
      title: String(r.title ?? "").slice(0, 200),
      url: clean(url),
      snippet: String(r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
    }];
  });
}

/** 抓 HTML 的引擎（零依赖兜底）*/
export const ENGINES: { name: string; run: (q: string, n: number) => Promise<SearchHit[]> }[] = [
  { name: "bing", run: searchBing },
  { name: "duckduckgo", run: searchDdg },
  { name: "baidu", run: searchBaidu },
];

/** 依次尝试各引擎，返回第一个有结果的 */
export async function searchAll(
  q: string, limit: number, apiKey?: string,
): Promise<{ hits: SearchHit[]; engine: string; tried: string[]; dropped: number }> {
  const tried: string[] = [];
  // 有 key 就先走搜索 API —— 质量比抓 HTML 高一个量级
  if (apiKey) {
    tried.push("tavily");
    try {
      const hits = await searchTavily(q, limit, apiKey);
      if (hits.length > 0) return { hits, engine: "tavily", tried, dropped: 0 };
    } catch { /* 挂了就退回抓 HTML */ }
  }
  for (const e of ENGINES) {
    tried.push(e.name);
    try {
      // 多取一些，过滤后还能凑够 limit
      const raw = await e.run(q, limit + 6);
      if (raw.length === 0) continue;
      const cleaned = dedupe(raw).filter((h) => !isLowValue(h));
      const hits = (cleaned.length > 0 ? cleaned : raw).slice(0, limit);
      return { hits, engine: e.name, tried, dropped: raw.length - hits.length };
    } catch { /* 换下一个 */ }
  }
  return { hits: [], engine: "", tried, dropped: 0 };
}

export const WebSearchTool = defineTool({
  name: "WebSearch",
  discoverable: "联网搜索（查时效性信息：今天的股价、最新版本号、某个报错怎么解）",
  description: [
    "搜索互联网，返回标题 + 链接 + 摘要。",
    "用途：查时效性信息（今天的股价、最新版本号、某个报错怎么解）、找官方文档地址。",
    "拿到链接后如果需要正文，用 WebFetch 打开具体页面。",
    "注意：搜索结果是「发现线索」，不是「已读内容」—— 下结论前先 WebFetch 读原文。",
    // ↓ 这三条是照 Claude Code 的 WebSearch 提示词抄的，它们各自解决一个实测问题：
    "",
    `**查询里必须带上当前年份（现在是 ${new Date().getFullYear()} 年）**。` +
      "查「最新版本」「今年的新闻」这类时，年份写错会拿到一整年的过期结果。",
    "",
    "**回答里凡是用了搜索结果，末尾必须附「来源:」并列出 [标题](URL)。**",
    "没有来源的时效性结论等于编造 —— 用户没法核实。",
    "",
    "搜索结果里带日期的，**优先信日期新的**；摘要互相矛盾时以更权威的来源为准（官网 > 百科 > 论坛）。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      limit: { type: "number", description: "返回条数，默认 8，最多 20" },
    },
    required: ["query"],
  },
  outputTier: "compact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const query = str(input, "query");
    const limit = Math.min(Math.max(optNum(input, "limit") ?? 8, 1), 20);
    const { hits, engine, tried } = await searchAll(query, limit, ctx.services?.webSearchKey);

    if (hits.length === 0) {
      return {
        query, found: 0, results: [], enginesTried: tried,
        error: "SEARCH_UNAVAILABLE",
        note:
          "所有搜索源都没返回结果（试过：" + tried.join("、") + "）。" +
          "常见原因：网络受限导致搜索引擎不可达。此时**不要反复重试搜索** —— " +
          "改用 WebFetch 直接打开你已知的网址，或者直接告诉用户你拿不到实时信息。",
      };
    }
    return {
      query, found: hits.length, results: hits, engine,
      note: "以上是「线索」不是「读过的内容」；引用前请用 WebFetch 打开确认。",
    };
  }),
});
