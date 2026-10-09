/** 文件清单：契约没有文件接口，文件树从工具调用入参派生（诚实标注来源） */
import type { UIMessage } from "../types.ts";

export type FileAction = "read" | "write" | "edit" | "delete" | "list" | "run" | "other";

export interface FileEntry {
  path: string;
  action: FileAction;
  tool: string;
  at: number;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: TreeNode[];
  entry?: FileEntry;
}

const PATH_KEYS = ["file_path", "filePath", "path", "target", "filename", "notebook_path", "dir", "cwd"];
const MAX_FILES = 500;

export function actionOf(tool: string): FileAction {
  const t = tool.toLowerCase();
  if (t.includes("write") || t.includes("create") || t.includes("save")) return "write";
  if (t.includes("edit") || t.includes("patch") || t.includes("replace")) return "edit";
  if (t.includes("delete") || t.includes("remove") || t.startsWith("rm")) return "delete";
  if (t.includes("read") || t.includes("view") || t.includes("cat") || t.includes("open")) return "read";
  if (t.includes("glob") || t.includes("grep") || t.includes("search") || t.includes("list") || t.includes("ls")) return "list";
  if (t.includes("bash") || t.includes("shell") || t.includes("exec") || t.includes("run")) return "run";
  return "other";
}

export function actionMeta(action: FileAction): { label: string; text: string } {
  switch (action) {
    case "read":
      return { label: "读", text: "text-info" };
    case "write":
      return { label: "写", text: "text-success" };
    case "edit":
      return { label: "改", text: "text-warn" };
    case "delete":
      return { label: "删", text: "text-danger" };
    case "list":
      return { label: "查", text: "text-fg-dim" };
    case "run":
      return { label: "跑", text: "text-think" };
    default:
      return { label: "·", text: "text-fg-mute" };
  }
}

function looksLikePath(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 300) return false;
  if (v.startsWith("-") || v.includes("://") || v.includes("\n")) return false;
  return v.includes("/") || /\.[a-z0-9]{1,6}$/i.test(v);
}

function pathsOf(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const bag = input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const v = bag[key];
    if (typeof v === "string" && looksLikePath(v)) out.push(v.trim());
  }
  return out;
}

function normalize(raw: string, root?: string): string {
  let p = raw.replace(/^["\']|["\']$/g, "").trim();
  if (!p) return "";
  if (root && !p.startsWith("/")) {
    p = root.replace(/\/+$/, "") + "/" + p.replace(/^\.\//, "");
  }
  return p;
}

export function collectFiles(messages: UIMessage[], root?: string): FileEntry[] {
  const map = new Map<string, FileEntry>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind !== "tool") continue;
      const action = actionOf(p.name);
      for (const raw of pathsOf(p.input)) {
        const path = normalize(raw, root);
        if (!path) continue;
        const prev = map.get(path);
        const newer = !prev || p.startedAt >= prev.at;
        map.set(path, {
          path,
          action: newer ? action : prev.action,
          tool: newer ? p.name : prev.tool,
          at: Math.max(p.startedAt, prev?.at ?? 0),
        });
        if (map.size >= MAX_FILES) return sortEntries(map);
      }
    }
  }
  return sortEntries(map);
}

function sortEntries(map: Map<string, FileEntry>): FileEntry[] {
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function stripRoot(path: string, root?: string): string {
  if (!root) return path;
  const prefix = root.replace(/\/+$/, "") + "/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** 扁平清单 → 目录树（目录优先，名称排序） */
export function buildTree(entries: FileEntry[], root?: string): TreeNode[] {
  const top: TreeNode[] = [];
  for (const entry of entries) {
    const segs = stripRoot(entry.path, root).split("/").filter(Boolean);
    let level = top;
    let walked = "";
    segs.forEach((seg, i) => {
      const isFile = i === segs.length - 1;
      walked = walked ? walked + "/" + seg : seg;
      let node = level.find((n) => n.name === seg && n.kind === (isFile ? "file" : "dir"));
      if (!node) {
        node = { name: seg, path: walked, kind: isFile ? "file" : "dir", children: [] };
        level.push(node);
      }
      if (isFile) node.entry = entry;
      level = node.children;
    });
  }
  sortTree(top);
  return top;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of nodes) sortTree(n.children);
}
