/**
 * 脱敏（T7.6 / T8.1）：**跨领域的底线能力**，所以它住在 security/ 而不是 activity/。
 * 三个使用点：① OCR/分析文本入库前 ② 助手回复落库/推流前 ③ 日志与报错文本。
 * 命中替换为 [REDACTED:KIND]；卡号走 Luhn 校验，避免把普通数字误伤；
 * PASSWORD 默认关闭（aggressive: true 才开）。
 */
export type RedactKind =
  | "API_KEY" | "JWT" | "BEARER_TOKEN" | "CREDIT_CARD" | "SSN" | "PRIVATE_KEY" | "PASSWORD";

export interface RedactRule {
  kind: RedactKind;
  re: RegExp;
  /** 需要 aggressive 才启用（默认关的规则） */
  aggressiveOnly?: boolean;
  /** 二次校验，返回 false 表示这次命中不算（原文保留） */
  validate?: (match: string) => boolean;
  /** 自定义替换；默认 [REDACTED:KIND]。groups 是捕获组 */
  replace?: (match: string, groups: string[]) => string;
}

export interface RedactOptions { aggressive?: boolean }
export interface RedactResult { text: string; hits: Record<string, number> }

export function marker(kind: RedactKind): string { return `[REDACTED:${kind}]`; }

/** Luhn 校验（去除非数字后按 13-19 位判定） */
export function luhn(input: string): boolean {
  const digits = (input ?? "").replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alternate) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** 正则表：顺序 = 优先级（越具体的越靠前） */
export const REDACT_RULES: RedactRule[] = [
  {
    kind: "PRIVATE_KEY",
    re: /-----BEGIN[^-\n]{0,60}PRIVATE KEY-----[\s\S]*?-----END[^-\n]{0,60}PRIVATE KEY-----/g,
  },
  {
    kind: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  },
  {
    kind: "BEARER_TOKEN",
    re: /\b(Bearer|Token)\s+([A-Za-z0-9\-._~+/]{16,}=*)/gi,
    replace: (_m, groups) => `${groups[0] ?? "Bearer"} ${marker("BEARER_TOKEN")}`,
  },
  {
    kind: "API_KEY",
    re: /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,}|dop_v1_[a-f0-9]{40,})/g,
  },
  {
    kind: "CREDIT_CARD",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (m) => luhn(m),
  },
  {
    kind: "SSN",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    kind: "PASSWORD",
    re: /((?:password|passwd|pwd|pass|密码|口令)\s*[:=：]\s*)(\S{4,})/gi,
    aggressiveOnly: true,
    replace: (_m, groups) => `${groups[0] ?? ""}${marker("PASSWORD")}`,
  },
];

/** 是否存在任何敏感命中（不改变文本） */
export function hasSecret(text: string, opts: RedactOptions = {}): boolean {
  return Object.keys(redact(text, opts).hits).length > 0;
}

export function redact(text: string, opts: RedactOptions = {}): RedactResult {
  const src = typeof text === "string" ? text : "";
  const hits: Record<string, number> = {};
  if (!src) return { text: "", hits };
  let out = src;
  for (const rule of REDACT_RULES) {
    if (rule.aggressiveOnly && !opts.aggressive) continue;
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = String(args[0] ?? "");
      const groups = args.slice(1, Math.max(1, args.length - 2)).map((g) => (g === undefined ? "" : String(g)));
      if (rule.validate && !rule.validate(match)) return match;
      hits[rule.kind] = (hits[rule.kind] ?? 0) + 1;
      try {
        return rule.replace ? rule.replace(match, groups) : marker(rule.kind);
      } catch { return marker(rule.kind); }
    });
  }
  return { text: out, hits };
}

/** 递归脱敏对象里的字符串（分析结果入库前用） */
export function redactDeep<T>(value: T, opts: RedactOptions = {}): { value: T; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  const merge = (h: Record<string, number>): void => {
    for (const [k, v] of Object.entries(h)) hits[k] = (hits[k] ?? 0) + v;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") { const r = redact(v, opts); merge(r.hits); return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) out[k] = walk(item);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, hits };
}