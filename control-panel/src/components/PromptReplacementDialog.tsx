"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

// 替换规则类型
export interface PromptReplacement {
  id: string;
  original: string;    // 原字符串
  replacement: string; // 替换字符串
  enabled: boolean;    // 是否启用
}

// localStorage key
const STORAGE_KEY = "prompt_replacements";

// 加载替换规则
export function loadPromptReplacements(): PromptReplacement[] {
  if (typeof window === "undefined") return [];
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error("Failed to load prompt replacements:", e);
  }
  return [];
}

// 保存替换规则
function savePromptReplacements(replacements: PromptReplacement[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(replacements));
  } catch (e) {
    console.error("Failed to save prompt replacements:", e);
  }
}

// 获取启用的替换规则（供外部调用）
export function getEnabledReplacements(): PromptReplacement[] {
  return loadPromptReplacements().filter(r => r.enabled && r.original && r.replacement);
}

interface PromptReplacementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function PromptReplacementDialog({
  open,
  onOpenChange,
}: PromptReplacementDialogProps) {
  const [replacements, setReplacements] = useState<PromptReplacement[]>([]);

  // 加载数据
  useEffect(() => {
    if (open) {
      setReplacements(loadPromptReplacements());
    }
  }, [open]);

  // 生成唯一 ID
  const generateId = () => `pr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 添加新规则
  const handleAdd = () => {
    const newRule: PromptReplacement = {
      id: generateId(),
      original: "",
      replacement: "",
      enabled: true,
    };
    setReplacements([...replacements, newRule]);
  };

  // 删除规则
  const handleDelete = (id: string) => {
    setReplacements(replacements.filter(r => r.id !== id));
  };

  // 更新规则
  const handleUpdate = (id: string, field: keyof PromptReplacement, value: string | boolean) => {
    setReplacements(replacements.map(r => 
      r.id === id ? { ...r, [field]: value } : r
    ));
  };

  // 保存并关闭
  const handleSave = () => {
    // 过滤掉空规则
    const validReplacements = replacements.filter(r => r.original || r.replacement);
    savePromptReplacements(validReplacements);
    onOpenChange(false);
  };

  // 取消
  const handleCancel = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[80vw] max-w-[80vw] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            ✨ 提示词替换
          </DialogTitle>
          <DialogDescription>
            设置字符串替换规则，发送消息时会自动将提示词中的指定字符串替换为新内容。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-3 py-4 min-h-0">
          {replacements.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-sm">还没有替换规则</p>
              <p className="text-xs mt-1">点击下方按钮添加第一条规则</p>
            </div>
          ) : (
            replacements.map((rule, index) => (
              <div
                key={rule.id}
                className="rounded-lg border bg-card overflow-hidden"
              >
                {/* 头部操作栏 */}
                <div className="flex items-center gap-3 px-4 py-2 bg-muted/50 border-b">
                  {/* 序号 */}
                  <div className="flex items-center justify-center w-6 h-6 rounded-full bg-background text-xs font-medium text-muted-foreground shrink-0">
                    {index + 1}
                  </div>

                  <div className="flex-1" />

                  {/* 右侧操作 */}
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground">启用</Label>
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={(checked) => handleUpdate(rule.id, "enabled", checked)}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(rule.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1" />
                      删除
                    </Button>
                  </div>
                </div>

                {/* 左右对比编辑区域 */}
                <div className="grid grid-cols-2 divide-x">
                  {/* 左侧：查找字符串 */}
                  <div className="p-3 space-y-2">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-danger" />
                      查找（原文）
                    </Label>
                    <Textarea
                      value={rule.original}
                      onChange={(e) => handleUpdate(rule.id, "original", e.target.value)}
                      placeholder="输入要查找的字符串..."
                      className="min-h-[150px] text-sm font-mono resize-y bg-danger-subtle/40 "
                    />
                  </div>

                  {/* 右侧：替换字符串 */}
                  <div className="p-3 space-y-2">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-success" />
                      替换为（新文）
                    </Label>
                    <Textarea
                      value={rule.replacement}
                      onChange={(e) => handleUpdate(rule.id, "replacement", e.target.value)}
                      placeholder="输入替换后的字符串..."
                      className="min-h-[150px] text-sm font-mono resize-y bg-success-subtle/40 "
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between pt-4 border-t">
          <Button
            variant="outline"
            size="sm"
            onClick={handleAdd}
            className="gap-1"
          >
            <Plus className="w-4 h-4" />
            添加规则
          </Button>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCancel}>
              取消
            </Button>
            <Button size="sm" onClick={handleSave}>
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
