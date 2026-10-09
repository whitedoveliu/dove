/**
 * 文件 tab：优先走后端接口（GET /api/files/:projectId + GET /api/file?projectId=&path=），
 * 没有 projectId 或接口不可用时，回退到从对话工具入参派生的清单（界面上如实标注来源）。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Empty, Modal, Notice, Spinner, cn } from "./ui/Primitives.tsx";
import { FileTree } from "./FileTree.tsx";
import { api } from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import type { FileEntry } from "../lib/tree.ts";
import type { BackendFileNode, FileContent } from "../types.ts";

function countFiles(nodes: BackendFileNode[]): number {
  return nodes.reduce((sum, n) => sum + (Array.isArray(n.children) ? countFiles(n.children) : 1), 0);
}

function isDir(node: BackendFileNode): boolean {
  return node.type === "dir" || Array.isArray(node.children);
}

function Node({
  node,
  depth,
  parent,
  onPeek,
}: {
  node: BackendFileNode;
  depth: number;
  parent: string;
  onPeek: (path: string) => void;
}) {
  const path = parent ? parent + "/" + node.name : node.name;
  const [open, setOpen] = useState(depth < 2);
  const style = { paddingLeft: 6 + depth * 12 };

  if (isDir(node)) {
    const children = node.children ?? [];
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
          <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-mute">{countFiles(children)}</span>
        </button>
        {open ? children.map((c) => (
          <Node key={c.name} node={c} depth={depth + 1} parent={path} onPeek={onPeek} />
        )) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      style={style}
      title={path}
      onClick={() => onPeek(path)}
      className="flex w-full items-center gap-2 rounded-sm py-0.5 pr-2 text-left hover:bg-white/5"
    >
      <span className="w-2 shrink-0" />
      <span className="truncate font-mono text-[12px] text-fg">{node.name}</span>
      {node.size != null ? (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-mute">{formatBytes(node.size)}</span>
      ) : null}
    </button>
  );
}

export function FilesTab({
  projectId,
  files,
  root,
}: {
  projectId: string | null;
  files: FileEntry[];
  root?: string;
}) {
  const [nodes, setNodes] = useState<BackendFileNode[] | null>(null);
  const [mode, setMode] = useState<"loading" | "backend" | "derived">(projectId ? "loading" : "derived");
  const [error, setError] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ path: string; data: FileContent | null; error?: string } | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setMode("derived");
      setNodes(null);
      return;
    }
    setMode("loading");
    setError(null);
    try {
      const res = await api.files(projectId);
      if (res && Array.isArray(res.children)) {
        setNodes(res.children);
        setMode("backend");
      } else {
        setNodes(null);
        setMode("derived");
        setError("后端没有返回该项目的文件树");
      }
    } catch (err) {
      setNodes(null);
      setMode("derived");
      setError((err as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openFile = useCallback(
    async (path: string) => {
      if (!projectId) return;
      setPeek({ path, data: null });
      try {
        setPeek({ path, data: await api.file(projectId, path) });
      } catch (err) {
        setPeek({ path, data: null, error: (err as Error).message });
      }
    },
    [projectId],
  );

  if (mode === "derived") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {projectId && error ? (
          <div className="shrink-0 px-2 pt-2">
            <Notice>后端文件接口不可用（{error}），已回退到从对话派生。</Notice>
          </div>
        ) : null}
        <FileTree files={files} root={root} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <Badge tone="info">后端接口</Badge>
        <span className="font-mono text-[10px] text-fg-mute">
          {nodes ? countFiles(nodes) + " 个文件" : "读取中"}
        </span>
        <span className="flex-1" />
        <Button size="xs" variant="subtle" onClick={() => void load()} title="重新拉取文件树">
          刷新
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {mode === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-fg-mute">
            <Spinner /> 读取项目文件…
          </div>
        ) : null}
        {mode === "backend" && nodes?.length === 0 ? <Empty>项目目录是空的。</Empty> : null}
        {mode === "backend" && nodes?.length
          ? nodes.map((n) => (
              <Node key={n.name} node={n} depth={0} parent="" onPeek={openFile} />
            ))
          : null}
      </div>

      <Modal
        open={peek !== null}
        title={peek?.path ?? ""}
        width="max-w-[760px]"
        onClose={() => setPeek(null)}
        footer={<Button onClick={() => setPeek(null)}>关闭</Button>}
      >
        {peek?.error ? <Notice tone="warn">读取失败：{peek.error}</Notice> : null}
        {!peek?.error && !peek?.data ? (
          <div className="flex items-center gap-2 py-3 text-[12px] text-fg-mute">
            <Spinner /> 读取文件内容…
          </div>
        ) : null}
        {peek?.data ? (
          <div className="space-y-2">
            {peek.data.truncated ? <Notice>文件过大，只显示前 200000 个字符。</Notice> : null}
            <pre className={cn("max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-2 font-mono text-[11px] leading-[1.5] text-fg")}>
              {peek.data.content || "（空文件）"}
            </pre>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
