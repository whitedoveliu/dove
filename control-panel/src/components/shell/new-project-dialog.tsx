"use client";

import * as React from "react";
import { FolderPlus, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface NewTaskInput {
  name: string;
  project?: string;
}

export interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已有任务名，用于提示重名（后端也会自动加后缀） */
  existingNames?: string[];
  /** 已有项目名，作为「所属项目」的候选 */
  existingProjects?: string[];
  /** 打开时预填的任务名（例如从一句话自动生成） */
  defaultName?: string;
  creating?: boolean;
  onCreate: (input: NewTaskInput) => void | Promise<void>;
}

/**
 * NewProjectDialog —— 新建任务（会话）。
 *
 * 对齐 Codex 的心智：**不需要挑端口**，只给任务起个名字即可；
 * 目录就用任务名，端口由后端自动分配。可选归入某个项目，
 * 这样同一项目的所有产物都落在同一个文件夹下（跨任务共享工作区）。
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  existingNames = [],
  existingProjects = [],
  defaultName = "",
  creating = false,
  onCreate,
}: NewProjectDialogProps) {
  const [name, setName] = React.useState(defaultName);
  const [project, setProject] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setName(defaultName);
      setProject("");
    }
  }, [open, defaultName]);

  const trimmed = name.trim();
  const duplicate = trimmed.length > 0 && existingNames.includes(trimmed);
  const canSubmit = trimmed.length > 0 && !creating;

  const submit = () => {
    if (!canSubmit) return;
    void onCreate({ name: trimmed, project: project.trim() || undefined });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="size-3.5 text-accent" />
            新建任务
          </DialogTitle>
          <DialogDescription>
            任务名会作为工作目录名；端口由系统自动分配，不需要你选。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="task-name">任务名</Label>
            <Input
              id="task-name"
              autoFocus
              value={name}
              maxLength={80}
              placeholder="例如：官网首页改版"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <p className={cn("h-4 text-2xs", duplicate ? "text-warning-fg" : "text-text-tertiary")}>
              {duplicate
                ? "已有同名任务，创建时会自动加后缀（-2）"
                : trimmed
                  ? `目录：${trimmed.replace(/[\\/:*?"<>|]/g, "-")}`
                  : "只能用名字，不用管端口"}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-project">所属项目（可选）</Label>
            <Input
              id="task-project"
              value={project}
              list="dove-projects"
              placeholder="留空 = 独立任务"
              onChange={(event) => setProject(event.target.value)}
            />
            <datalist id="dove-projects">
              {existingProjects.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
            <p className="text-2xs text-text-tertiary">
              填了项目名，任务会落在该项目的文件夹下，和同项目的其他任务共享工作区。
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={creating}>
            取消
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSubmit}>
            {creating && <Loader2 className="animate-spin" />}
            创建任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
