/**
 * Skill —— 读技能包 SKILL.md（元工具，永远在）
 * 渐进披露：技能目录只放「名字 + 一句话」，正文按需读进来，绝不把长文档塞进系统提示词。
 * 目录约定：<workdir>/skills/<name>/SKILL.md（兼容 <workdir>/.dove/skills）。
 *
 * ⚠️ 还查一个**全局目录** ~/.dove/skills。
 *    技能本质是全局的（「怎么做 PPT」在任何项目里都一样），但 workdir 是**项目目录**，
 *    只按项目找的话，全局放一份技能谁也看不见 —— 实测踩过：
 *    全局目录里躺着 8 个技能包（ppt / video / website / shopify / stripe…），
 *    内核一个都找不到，Skill 工具一直返回 count=0。
 *
 * 依赖预检（Alma §5.3 的反面教材）：
 *    技能生态用 metadata.requires.bins:["lark-cli"] 声明依赖，但「声明了」不等于「装了」——
 *    Alma 只把这段 metadata 存下来、不读不校验，于是依赖缺失不会在装载时暴露，
 *    而是**跑到一半才失败**（那时模型已经花了几十步）。
 *    所以读正文前逐个探测：bin 走 PATH，env 走 process.env；缺了就写在正文开头，
 *    第一眼就告诉模型「别硬跑」。
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defineTool, S } from "../types.ts";
import { guarded, resolvePath, relPath, optStr, readTextFile } from "./util.ts";

const MAX_BYTES = 2 * 1024 * 1024;

function roots(workdir: string): string[] {
  // ⚠️ 必须去重：workdir 就是 home 时，第二和第三个会指向同一个目录，
  //    技能会被列两遍（实测过：8 个技能列成 16 条）。
  return [...new Set([
    path.join(workdir, "skills"),
    path.join(workdir, ".dove", "skills"),
    path.join(os.homedir(), ".dove", "skills"),
  ])];
}

async function listSkills(workdir: string): Promise<{ name: string; path: string; summary: string }[]> {
  const out: { name: string; path: string; summary: string }[] = [];
  for (const root of roots(workdir)) {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(root, e.name, "SKILL.md");
      const info = await fsp.stat(file).catch(() => null);
      if (!info) continue;
      let summary = "";
      try {
        const { text } = readTextFile(file, MAX_BYTES);
        summary = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("---")) ?? "";
      } catch { /* 读不了就只给名字 */ }
      out.push({ name: e.name, path: relPath(file, workdir), summary: summary.slice(0, 160) });
    }
  }
  return out;
}

// ── 依赖预检（requires.bins / requires.env） ────────────────

interface Requires { bins: string[]; env: string[] }
interface MissingDep { kind: "bin" | "env"; name: string; detail: string }

/** 抽 YAML frontmatter；没有就返回空串（没有 frontmatter 的技能 = 没声明依赖） */
function frontmatterOf(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m?.[1] ?? "";
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

function inlineSeq(s: string): string[] {
  return s.trim().replace(/^\[/, "").replace(/\]$/, "").split(",").map(unquote).filter(Boolean);
}

/**
 * 极简 YAML 子集解析：块映射 / 块数组 / 内联数组 / 标量。
 * 为什么自己写：内核零运行时依赖，而 frontmatter 里我们只关心 requires 那几行，引全套 YAML 不值当。
 * 解析不动的行直接忽略（当「没声明」）—— 格式花哨不该让技能读不出来。
 */
function parseMiniYaml(fm: string): Record<string, unknown> {
  const lines: { indent: number; text: string }[] = [];
  for (const raw of fm.split("\n")) {
    const text = raw.trim();
    if (!text || text.startsWith("#")) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, text });
  }
  let i = 0;
  function parseBlock(indent: number): unknown {
    if (i < lines.length && lines[i]!.text.startsWith("- ")) {
      const arr: string[] = [];
      while (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith("- ")) {
        arr.push(unquote(lines[i]!.text.slice(2)));
        i++;
        // 数组项的续行（嵌套结构）跳过：我们只收标量项
        while (i < lines.length && lines[i]!.indent > indent) i++;
      }
      return arr;
    }
    const obj: Record<string, unknown> = {};
    while (i < lines.length && lines[i]!.indent === indent) {
      const m = /^([^\s:][^:]*?)\s*:\s*(.*)$/.exec(lines[i]!.text);
      if (!m) { i++; continue; }
      const key = m[1]!.trim();
      const rest = m[2]!.trim();
      i++;
      if (!rest) {
        const next = lines[i];
        // 子块，或「块数组与键同缩进」这种合法写法
        if (next && next.indent > indent) obj[key] = parseBlock(next.indent);
        else if (next && next.indent === indent && next.text.startsWith("- ")) obj[key] = parseBlock(indent);
        else obj[key] = "";
      } else if (rest.startsWith("[")) {
        obj[key] = inlineSeq(rest);
      } else {
        obj[key] = unquote(rest);
      }
    }
    return obj;
  }
  return parseBlock(lines[0]?.indent ?? 0) as Record<string, unknown>;
}

/**
 * 归集 requires.bins / requires.env。三种写法都认（技能生态里都出现过）：
 *   requires: {bins/env} · metadata: {requires: {bins/env}} · "requires.bins" 字面点路径
 */
function readRequires(fm: string): Requires {
  const doc = fm.trim() ? parseMiniYaml(fm) : {};
  const bins = new Set<string>();
  const env = new Set<string>();
  const takeList = (target: Set<string>, v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) { const s = String(x).trim(); if (s) target.add(s); } }
    else if (typeof v === "string" && v.trim()) target.add(v.trim());
  };
  const takeFromRequires = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const leaf = k.split(".").pop()!;
      if (leaf === "bins") takeList(bins, v);
      else if (leaf === "env") takeList(env, v);
    }
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const segs = k.split(".");
      const ri = segs.indexOf("requires");
      if (ri >= 0 && ri === segs.length - 1) takeFromRequires(v);
      else if (ri >= 0) {
        const leaf = segs[segs.length - 1]!;
        if (leaf === "bins") takeList(bins, v);
        else if (leaf === "env") takeList(env, v);
      }
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v);
    }
  };
  walk(doc);
  return { bins: [...bins], env: [...env] };
}

/** bin 在不在 PATH 上（声明写成路径的就按路径查）：查存在 + 可执行位 */
function binAvailable(name: string): boolean {
  const candidates = name.includes("/")
    ? [path.isAbsolute(name) ? name : path.resolve(name)]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, name));
  return candidates.some((p) => {
    try {
      if (!fs.statSync(p).isFile()) return false;
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch { return false; }
  });
}

/** 逐个探测声明的依赖；没声明的技能不会被这里碰（零成本） */
function checkRequires(requires: Requires): MissingDep[] {
  const missing: MissingDep[] = [];
  for (const b of requires.bins) if (!binAvailable(b)) missing.push({ kind: "bin", name: b, detail: "命令不存在" });
  for (const e of requires.env) if (!process.env[e]?.trim()) missing.push({ kind: "env", name: e, detail: "环境变量未设置" });
  return missing;
}

/** 警告必须放在**正文最前面**：模型读技能时不会再回头翻别的字段 */
function missingDepsWarning(missing: MissingDep[]): string {
  if (!missing.length) return "";
  return "⚠️ 这个技能声明的依赖缺失：" + missing.map((m) => m.name + "（" + m.detail + "）").join("、") +
    " —— 装了再试，别硬跑；缺依赖时正文里的命令会跑到一半才失败。\n\n";
}

export const SkillTool = defineTool({
  name: "Skill",
  description:
    "读取技能包正文（SKILL.md）。不传参数时列出可用技能；传 name 读对应技能，传 path 直接读某个 SKILL.md。" +
    "读之前会预检技能声明的依赖（requires.bins / requires.env），缺了会在正文开头明确警告。" +
    "技能是「怎么做某类事」的说明书：动手前读一次，比凭印象写更稳。",
  parameters: S.obj({
    name: S.str("技能目录名（如 lark-sheets）"),
    path: S.str("直接指向 SKILL.md 的路径（与 name 二选一）"),
  }),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: true,
  execute: (input, ctx) => guarded(async () => {
    const name = optStr(input, "name");
    const p = optStr(input, "path");

    if (!name && !p) {
      const skills = await listSkills(ctx.workdir);
      return { count: skills.length, skills, note: skills.length ? "用 name 读取正文。" : "没有找到技能包（查找目录：skills/ 与 .dove/skills/）。" };
    }

    let file: string | null = null;
    if (p) {
      const abs = resolvePath(p, ctx.workdir);
      file = abs.endsWith("SKILL.md") ? abs : path.join(abs, "SKILL.md");
    } else if (name) {
      for (const root of roots(ctx.workdir)) {
        const candidate = path.join(root, name, "SKILL.md");
        if (await fsp.stat(candidate).then((s) => s.isFile()).catch(() => false)) { file = candidate; break; }
      }
    }
    if (!file) return { name, error: "找不到技能：" + (name ?? p) + "（可用 Skill 不带参数列出全部技能）" };

    const { text, bytes, binary } = readTextFile(file, MAX_BYTES);
    if (binary) return { name, path: relPath(file, ctx.workdir), error: "SKILL.md 是二进制文件，无法读取。" };

    // 依赖预检：声明了就得查 —— 缺依赖要在「动手之前」暴露，而不是跑到一半
    const requires = readRequires(frontmatterOf(text));
    const missing = checkRequires(requires);
    return {
      name: name ?? path.basename(path.dirname(file)),
      path: relPath(file, ctx.workdir),
      bytes,
      requires: requires.bins.length || requires.env.length ? requires : undefined,
      missing: missing.length ? missing : undefined,
      content: missingDepsWarning(missing) + text,
      note: missing.length
        ? "依赖预检未通过：正文开头的警告就是缺的东西，别硬跑。"
        : "这是技能正文。按里面的步骤做；内容被截断时以存档文件为准。",
    };
  }),
});
