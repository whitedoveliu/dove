/**
 * 读侧路径护栏（**入站**）：在文件被读出来之前，把「秘密类路径」拦掉。
 *
 * 与同层 redact.ts 的分工必须说清楚，否则很容易以为两者重复：
 *   · redact.ts 管**出站**：文本已经产生（回复落库、推流、日志），它负责别把密钥写出去；
 *   · 本文件管**入站**：Read / Glob / Grep 还没碰文件就先判路径。
 *   出站脱敏是**事后**过滤，挡不住秘密**进入上下文** —— 一旦 Read 把私钥读进来，
 *   它就已经在 prompt 里了，后面替换成 [REDACTED] 只是让日志干净，模型该看见的还是看见了。
 *   所以读侧必须单独有一层，且必须是硬拒（不走审批弹窗）：
 *   审批是「用户可能点允许」的东西，而这里要的是「没有这个选项」。
 *
 * 判定只用**精确**匹配（名字全等 / 结尾后缀 / 开头前缀 / 目录段全等），**绝不做子串包含**：
 * `credentialsHelper.ts`、`.envoy`、`notes.pem.md`、`.envrc` 都是正常文件。
 * 误伤比漏拦更贵 —— 模型被「说不清为什么」拒过几次之后就会开始绕路（Bash、cat），
 * 护栏于是既没保住秘密，又白白吃掉几轮对话。
 */
import * as path from "node:path";
import {
  SENSITIVE_DIR_SEGMENTS,
  SENSITIVE_FILE_NAMES,
  SENSITIVE_FILE_PREFIXES,
  SENSITIVE_FILE_SUFFIXES,
  SENSITIVE_NAME_EXEMPT_SUFFIXES,
} from "../constants.ts";

export type SensitiveRuleKind = "dir" | "name" | "env" | "suffix" | "prefix";

export interface SensitiveHit {
  kind: SensitiveRuleKind;
  /** 命中的规则原文（目录段 / 文件名 / 后缀 / 前缀），用于查规则表 */
  rule: string;
  /** 给模型看的规则说明，错误文案与过滤提示都用它 */
  label: string;
}

/**
 * 路径 → 小写片段。
 * 大小写统一是必须的：macOS / Windows 的文件系统默认大小写不敏感，
 * `.ENV` 与 `.env` 是同一个文件；只按原样比较等于留了个改名就能绕过去的洞。
 */
function segs(p: string): string[] {
  return String(p ?? "").split(/[\\/]+/).filter((s) => s.length > 0).map((s) => s.toLowerCase());
}

/** abs 是否真的落在 base 之内（`..foo` 这种合法子目录名不算越界） */
function isUnder(abs: string, base: string): boolean {
  const rel = path.relative(base, abs);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep));
}

/**
 * 「base 之下」的第一个片段下标；abs 不在 base 之下时返回 0（全路径都参与判定）。
 *
 * 为什么要这个东西：用户可能**故意**把工作区设在敏感目录里（例如在 ~/.ssh 下放脚本、
 * 或被审计的 .aws 目录），那是他显式选过的路径，不该把整棵树都拒掉 ——
 * 那样只会让人关掉护栏。所以 base 自己路径里的敏感**目录**片段予以豁免。
 * 注意豁免的边界很窄：
 *   · 只豁免目录段规则；文件名规则（id_rsa / .env / *.pem / service-account-*）**永远生效**，
 *     那是文件自身的属性，跟它被放在哪个目录无关；
 *   · 只豁免 base **自身及其上方**的片段；base 里更深处的敏感目录照样拦，
 *     多段规则（`.config/gcloud`）只要有一段落在 base 之下也算命中（见 matchSensitive 的起扫点）。
 */
function boundaryIndex(abs: string, base?: string): number {
  if (!base) return 0;
  const absRes = path.resolve(abs);
  const baseRes = path.resolve(base);
  if (!isUnder(absRes, baseRes)) return 0;
  if (absRes === baseRes) return segs(absRes).length; // 读 base 本身（列目录）不算踩线
  return segs(baseRes).length;
}

/** 命中判定；没命中返回 null。base 见 boundaryIndex 的说明 */
export function sensitiveHitOf(absPath: string, base?: string): SensitiveHit | null {
  const parts = segs(absPath);
  if (parts.length === 0) return null;
  const name = parts[parts.length - 1];

  // ⓪ 模板豁免先行：`.env.example` / `.env.template` / `secrets.sample` 是**样板**不是钥匙。
  //    拦它们只会让模型读不到「该配哪些变量」，属于纯粹的误伤 —— 而且极常见。
  //    注意豁免只作用于**末尾那一段名字**，不影响目录段规则与后缀/前缀规则。
  if (SENSITIVE_NAME_EXEMPT_SUFFIXES.some((s) => name.endsWith(s.toLowerCase()))) return null;

  // ① 文件名精确相等。`credentials` 命中，`credentialsHelper.ts` 不命中
  if (SENSITIVE_FILE_NAMES.some((n) => n.toLowerCase() === name)) {
    return { kind: "name", rule: name, label: "敏感文件名「" + name + "」" };
  }
  // ② .env 家族。`.env.local` 命中，`.envoy` / `.envrc` 不命中（都不满足 `.env.` 前缀）
  if (name === ".env" || name.startsWith(".env.")) {
    return { kind: "env", rule: ".env", label: "敏感文件名「" + name + "」（.env 家族）" };
  }
  // ③ 后缀 / 前缀必须落在**文件名两端**：apikey.pem 命中，notes.pem.md 不命中
  const suf = SENSITIVE_FILE_SUFFIXES.find((s) => name.endsWith(s.toLowerCase()));
  if (suf) return { kind: "suffix", rule: suf, label: "敏感文件后缀「" + suf + "」" };
  const pre = SENSITIVE_FILE_PREFIXES.find((s) => name.startsWith(s.toLowerCase()));
  if (pre) return { kind: "prefix", rule: pre, label: "敏感文件名前缀「" + pre + "」" };

  // ④ 目录段：任意一段全等即命中。多段规则（`.config/gcloud`）按**连续片段**匹配，
  //    不能按单段名找 `.config` 或 `gcloud` —— 那样 `.config/nvim` 会被误伤。
  //    起扫点回退 d.length-1 段：只要规则里还有一段落在 base 之下（跨边界）就不豁免，
  //    否则「base=~/.config」会把 ~/.config/gcloud 整片放走。
  const start = boundaryIndex(absPath, base);
  for (const dir of SENSITIVE_DIR_SEGMENTS) {
    const d = segs(dir);
    if (d.length === 0) continue;
    const from = Math.max(0, start - (d.length - 1));
    for (let i = from; i + d.length <= parts.length; i++) {
      if (d.every((s, j) => parts[i + j] === s)) {
        return { kind: "dir", rule: dir, label: "敏感目录「" + dir + "」" };
      }
    }
  }
  return null;
}

/** 这个绝对路径是不是秘密类路径（base = 用户显式指定的工作目录 / 搜索根，可省） */
export function isSensitivePath(absPath: string, base?: string): boolean {
  return sensitiveHitOf(absPath, base) !== null;
}

/**
 * 读之前调用：命中即抛错。
 *
 * 为什么直接抛而不是弹审批：秘密文件的正确处置是「没有这个选项」。
 * 弹窗会让模型觉得「问一下就能读」，也会把用户的注意力训练成默认点允许。
 * 真需要里面的内容，走 Bash（那条路径有审批 + 命令分类器兜着），别让静默路径存在。
 */
export function assertReadablePath(absPath: string, base?: string): void {
  const hit = sensitiveHitOf(absPath, base);
  if (!hit) return;
  throw new Error(
    "读取被拒绝：" + absPath + "\n" +
    "命中读侧护栏规则：" + hit.label + "\n" +
    "这类路径放的是私钥 / 凭据，读进来就等于把秘密写进上下文 —— " +
    "出站脱敏只挡日志与回复，挡不住已经进上下文的原文。\n" +
    "不要读它，也不要用 Grep / Glob 绕（这两个工具对同一批路径同样会过滤或拒绝）。\n" +
    "如果确实需要里面的内容，先让用户确认，再用 Bash（那条路径有审批）。",
  );
}

/**
 * 给 Glob / Grep 用：丢掉命中项并**只回报数量**。
 *
 * 为什么只回报数量、不回传被丢掉的路径：把 `.ssh/id_rsa` 写进结果里，
 * 等于换个字段名把同一条情报交给模型（路径本身就有信息量，Grep 的报错路径同理）。
 * 模型只需要知道「有东西被过滤了」，不需要知道是什么。
 */
export function filterSensitiveEntries<T>(
  entries: T[],
  pathOf: (t: T) => string,
  base?: string,
): { kept: T[]; droppedCount: number } {
  const kept: T[] = [];
  let droppedCount = 0;
  for (const e of entries) {
    if (sensitiveHitOf(pathOf(e), base)) droppedCount++;
    else kept.push(e);
  }
  return { kept, droppedCount };
}

/**
 * 过滤提示语（没有过滤就返回 undefined —— 每轮都多一句废话会挤掉真正有用的信息）。
 *
 * ⚠️ 数量只计**结果过滤**丢掉的条目：遍历阶段就被剪掉的敏感目录（walkFiles 的 pruneDir）
 * 不会出现在这里，所以它是「至少过滤了这么多」而不是精确总数。
 * 想要精确值就得让 walkFiles 回传剪枝计数，为一句提示不值得动遍历器的返回形状。
 */
export function sensitiveFilterNote(droppedCount: number): string | undefined {
  if (droppedCount <= 0) return undefined;
  return "已过滤 " + droppedCount + " 条敏感路径（凭据 / 私钥类不返回）。";
}
