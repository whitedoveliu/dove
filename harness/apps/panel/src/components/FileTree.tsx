/** 文件树：条目从工具调用入参派生（契约未提供文件接口，界面如实标注） */
import { useMemo, useState } from "react";
import { Empty } from "./ui/Primitives.tsx";
import { actionMeta, buildTree } from "../lib/tree.ts";
import type { FileEntry, TreeNode } from "../lib/tree.ts";

function countFiles(node: TreeNode): number {
  if (node.kind === "file") return 1;
  return node.children.reduce((sum, c) => sum + countFiles(c), 0);
}

function Node({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const style = { paddingLeft: 6 + depth * 12 };

  if (node.kind === "dir") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={style}
          className="flex w-full items-center gap-1.5 rounded-sm py-0.5 pr-2 text-left hover:bg-white/5"
        >
          <span className="w-2 shrink-0 text-[10px] text-fg-mute">{open ? "▾" : "▸"}</span>
          <span className="truncate font-mono text-[12px] text-fg-dim">{node.name}/</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-mute">{countFiles(node)}</span>
        </button>
        {open ? node.children.map((c) => <Node key={c.path} node={c} depth={depth + 1} />) : null}
      </div>
    );
  }

  const meta = node.entry ? actionMeta(node.entry.action) : null;
  return (
    <div
      style={style}
      title={(node.entry?.path ?? node.path) + (node.entry ? " · " + node.entry.tool : "")}
      className="flex items-center gap-2 rounded-sm py-0.5 pr-2 hover:bg-white/5"
    >
      <span className="w-2 shrink-0" />
      <span className="truncate font-mono text-[12px] text-fg">{node.name}</span>
      {meta ? <span className={"ml-auto shrink-0 font-mono text-[10px] " + meta.text}>{meta.label}</span> : null}
    </div>
  );
}

export function FileTree({ files, root }: { files: FileEntry[]; root?: string }) {
  const tree = useMemo(() => buildTree(files, root), [files, root]);

  if (files.length === 0) {
    return (
      <Empty>
        还没有文件操作记录。
        <br />
        读 / 写 / 改 文件后，这里会列出涉及的文件。
      </Empty>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      <div className="px-2 pb-1 font-mono text-[10px] uppercase tracking-wide text-fg-mute">
        {files.length} 个文件 · 来自工具调用
      </div>
      {tree.map((n) => (
        <Node key={n.path} node={n} depth={0} />
      ))}
    </div>
  );
}
