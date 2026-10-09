/**
 * Skill —— 读技能包 SKILL.md（元工具，永远在）
 * 渐进披露：技能目录只放「名字 + 一句话」，正文按需读进来，绝不把长文档塞进系统提示词。
 * 目录约定：<workdir>/skills/<name>/SKILL.md（兼容 <workdir>/.dove/skills）。
 *
 * ⚠️ 还查一个**全局目录** ~/.dove/skills。
 *    技能本质是全局的（「怎么做 PPT」在任何项目里都一样），但 workdir 是**项目目录**，
 *    只按项目找的话，全局放一份技能谁也看不见 —— 实测踩过：
 *    python/skills 里躺着 8 个技能包（ppt / video / website / shopify / stripe…），
 *    内核一个都找不到，Skill 工具一直返回 count=0。
 */
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

export const SkillTool = defineTool({
  name: "Skill",
  description:
    "读取技能包正文（SKILL.md）。不传参数时列出可用技能；传 name 读对应技能，传 path 直接读某个 SKILL.md。" +
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
    return {
      name: name ?? path.basename(path.dirname(file)),
      path: relPath(file, ctx.workdir),
      bytes,
      content: text,
      note: "这是技能正文。按里面的步骤做；内容被截断时以存档文件为准。",
    };
  }),
});
