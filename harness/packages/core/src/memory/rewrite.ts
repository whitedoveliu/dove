/**
 * 记忆通道的查询改写（规则版，零依赖、零延迟）
 *
 * 为什么需要：注入用的查询就是用户原话，里面一半是招呼与请求壳
 * （「你好」「帮我看下」「请问」「谢谢」）—— 这些词在向量里占位置，
 * 会把真正有信息量的词（配色 / 字体 / pnpm）稀释掉。
 * 改写的目标只有一个：**留下检索意图**，不做同义扩展（那需要 LLM，见下）。
 *
 * 纪律：绝不抛异常；改写失败 / 改没了 → 回退原查询（宁可检索原句，不可检索空串）。
 * 想升级成 LLM 改写：给 MemoryService 传 rewriter 覆盖即可（retrieve.ts 已留钩子）。
 */

/** 中英填充词：整段删（不是词干，不做前后缀匹配） */
const FILLERS: string[] = [
  // 中文
  "你好", "您好", "哈喽", "哈啰", "请问", "麻烦你", "麻烦", "帮我看看", "帮我", "帮忙", "请你",
  "给我", "我要", "我想", "能不能", "可不可以", "能否", "看一下", "看看", "看下", "瞅瞅", "瞧瞧",
  "谢谢", "多谢", "拜托", "一下子", "帮我弄", "帮我做",
  // 英文（按词边界匹配）
  "could you", "can you", "would you", "i want to", "i need to", "i'd like to", "help me",
  "for me", "thank you", "thanks", "please", "hello", "hi", "hey",
];

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
/** 结尾的语气词：只削一次，削完太短就整体回退 */
const TRAILING_RE = /[\s,.!?~、。！？…，；：]*[吧呀啊哦喔嘛呢啦]?[\s,.!?~、。！？…，；：]*$/;
/** 首尾标点 */
const EDGE_PUNCT_RE = /^[\s,.!?~、。！？…，；：'"“”()（）\-—]+|[\s,.!?~、。！？…，；：'"“”()（）\-—]+$/g;

function stripFiller(text: string): string {
  let out = text;
  for (const f of FILLERS) {
    if (!f) continue;
    const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 英文词按词边界；中文直接替换（无词边界概念）
    const re = /^[a-z' ]+$/.test(f)
      ? new RegExp(`\\b${escaped}\\b`, "gi")
      : new RegExp(escaped, "g");
    out = out.replace(re, " ");
  }
  return out;
}

/**
 * 把用户原话改写成检索查询。
 * 例：「你好，帮我看下首页的配色方案，谢谢」→「首页的配色方案」
 */
export function rewriteQuery(query: string): string {
  const original = (query ?? "").normalize("NFKC").trim();
  if (!original) return "";
  try {
    let out = original.replace(EMOJI_RE, " ");
    out = stripFiller(out);
    out = out.replace(TRAILING_RE, "");
    out = out.replace(EDGE_PUNCT_RE, "");
    out = out.replace(/\s+/g, " ").trim();
    // 削没了（整句都是客套）或只剩标点 → 回退原句
    if (out.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return original;
    return out;
  } catch {
    return original;
  }
}
