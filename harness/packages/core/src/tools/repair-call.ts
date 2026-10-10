/**
 * 工具调用修复（T3.4）
 * 两层：① 名字模糊匹配 + 别名表  ② 参数错名映射 + 类型强转
 * 修不了返回 null，把原始错误交还模型自纠。
 */
import type { Tool } from "./types.ts";

/** 常见别名 → 规范名 */
const NAME_ALIASES: Record<string, string> = {
  readfile: "Read", readfiles: "Read", read_file: "Read", readfilelist: "Read", cat: "Read", view: "Read",
  writefile: "Write", write_file: "Write", createfile: "Write", newfile: "Write", new_file: "Write", create_file: "Write",
  editfile: "Edit", edit_file: "Edit", strreplace: "Edit", replace: "Edit", modifyfile: "Edit", apply_patch: "Edit",
  globfile: "Glob", listfiles: "Glob", ls: "Glob", find: "Glob", glob_files: "Glob",
  grepfile: "Grep", searchinfiles: "Grep", search_in_files: "Grep", search: "Grep", ripgrep: "Grep", rg: "Grep",
  runcommand: "Bash", run_command: "Bash", shell: "Bash", exec: "Bash", execute: "Bash", terminal: "Bash", cmd: "Bash",
  bashoutput: "BashOutput", bash_output: "BashOutput", getoutput: "BashOutput",
  killshell: "KillShell", kill_shell: "KillShell", killbash: "KillShell",
  askuser: "AskUserQuestion", ask_user: "AskUserQuestion", question: "AskUserQuestion", clarify: "AskUserQuestion",
  todowrite: "TodoWrite", todo_write: "TodoWrite", todolist: "TodoWrite", tasklist: "TodoWrite",
  attemptcompletion: "AttemptCompletion", attempt_completion: "AttemptCompletion", finish: "AttemptCompletion", done: "AttemptCompletion", taskdone: "AttemptCompletion",
  toolsearch: "ToolSearch", tool_search: "ToolSearch", searchtools: "ToolSearch",
  readskillsfile: "Skill", read_skills_file: "Skill", skill: "Skill", loadskill: "Skill",
  recall: "Recall", searchmemory: "Recall", memorysearch: "Recall",
  remember: "Remember", savememory: "Remember", store_memory: "Remember",
  // ProjectBuild / VersionList / VersionRestore / ProjectPreview 均已移除 ——
  // 构建走 npm run build（分类器放行）、版本走 git、预览由界面自己起。
  // 模型如果幻觉出这些名字，不映射到任何工具（repair 会返回未找到，模型自己改用 Bash）。



  webfetch: "WebFetch", web_fetch: "WebFetch", fetch: "WebFetch", url_fetch: "WebFetch",
  websearch: "WebSearch", web_search: "WebSearch", google: "WebSearch", search_web: "WebSearch",
  // GenerateImage / GeneratePPT / GenerateVideo 已移除（生图/PPT/视频改走技能），
  // 模型若幻觉出这些名字，不映射到任何工具，让 repair 返回未找到。
  deletefile: "Delete", delete_file: "Delete", rm: "Delete",
};

/** 参数错名映射 */
const ARG_ALIASES: Record<string, string> = {
  path: "file_path", filepath: "file_path", filename: "file_path", file: "file_path", target: "file_path",
  regex: "pattern", query: "pattern", search: "pattern",
  uri: "url", link: "url", address: "url",
  cmd: "command", script: "command", shell_command: "command",
  dir: "path", directory: "path", folder: "path",
  text: "content", data: "content", body: "content", file_content: "content",
  old: "old_string", new: "new_string", oldtext: "old_string", newtext: "new_string",
  old_str: "old_string", new_str: "new_string", search_text: "old_string", replace_text: "new_string",
  n: "limit", count: "limit", max: "limit",
};

function canonName(s: string): string { return s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase(); }

export interface RepairedCall { name: string; args: Record<string, unknown>; repaired: boolean; notes: string[] }

export function repairToolCall(
  rawName: string, rawArgs: unknown, tools: Tool[],
): RepairedCall | null {
  const notes: string[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));

  // ── 第一层：名字 ──
  let tool = byName.get(rawName);
  if (!tool) {
    const alias = NAME_ALIASES[canonName(rawName)];
    if (alias && byName.has(alias)) { tool = byName.get(alias)!; notes.push(`工具名 "${rawName}" 已修正为 "${alias}"`); }
  }
  if (!tool) {
    const c = canonName(rawName);
    const matches = tools.filter((t) => canonName(t.name) === c || canonName(t.name).startsWith(c) || c.startsWith(canonName(t.name)));
    if (matches.length === 1) { tool = matches[0]!; notes.push(`工具名 "${rawName}" 模糊匹配到 "${tool.name}"`); }
  }
  if (!tool) return null;

  // ── 第二层：参数 ──
  let args: Record<string, unknown>;
  if (typeof rawArgs === "string") {
    try { args = JSON.parse(rawArgs) as Record<string, unknown>; }
    catch { args = {}; notes.push("参数不是合法 JSON，已按空对象处理"); }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = { ...(rawArgs as Record<string, unknown>) };
  } else {
    args = {};
  }

  const props = ((tool.parameters as { properties?: Record<string, { type?: string }> }).properties) ?? {};
  const fixed: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(args)) {
    let key = k;
    if (!(key in props)) {
      const a = ARG_ALIASES[canonName(k)];
      if (a && a in props) { key = a; notes.push(`参数 "${k}" 已重命名为 "${key}"`); }
    }
    fixed[key] = coerce(v, props[key]?.type, key, notes);
  }

  return { name: tool.name, args: fixed, repaired: notes.length > 0, notes };
}

function coerce(v: unknown, type: string | undefined, key: string, notes: string[]): unknown {
  if (!type) return v;
  if (type === "string" && typeof v !== "string") { notes.push(`参数 "${key}" 已从 ${typeof v} 转成 string`); return typeof v === "object" ? JSON.stringify(v) : String(v); }
  if (type === "number" && typeof v !== "number") { const n = Number(v); if (Number.isFinite(n)) { notes.push(`参数 "${key}" 已转成 number`); return n; } }
  if (type === "boolean" && typeof v !== "boolean") { if (v === "true") return true; if (v === "false") return false; }
  if (type === "array" && !Array.isArray(v) && v !== undefined && v !== null) { return [v]; }
  return v;
}
