/** 新建项目弹窗：POST /api/projects { id?, name, path } */
import { useEffect, useState } from "react";
import { Button, Field, Modal } from "./ui/Primitives.tsx";

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, path: string) => Promise<void>;
}

export function NewProjectDialog({ open, onClose, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setPath("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim() || !path.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim(), path.trim());
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新建项目"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim() || !path.trim()}>
            {busy ? "创建中…" : "创建"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-fg-dim">名称</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：作品集官网"
            className="h-7 w-full rounded-sm border border-line-strong bg-inset px-2 text-[12px] text-fg outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-fg-dim">目录</span>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            placeholder="/Users/you/projects/site"
            className="h-7 w-full rounded-sm border border-line-strong bg-inset px-2 font-mono text-[12px] text-fg outline-none focus:border-accent"
          />
        </label>
        {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        <div className="rounded-sm border border-line bg-inset p-2">
          <Field label="说明">
            项目创建后可触发构建（POST /api/build），并在右侧预览面板查看。
          </Field>
        </div>
      </div>
    </Modal>
  );
}
