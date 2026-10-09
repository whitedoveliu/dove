"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface UserInputDialogProps {
  open: boolean;
  question: string;
  suggestions?: string[];
  onSubmit: (answer: string) => void;
  onClose: () => void;
}

export default function UserInputDialog({
  open,
  question,
  suggestions,
  onSubmit,
  onClose,
}: UserInputDialogProps) {
  const [answer, setAnswer] = useState("");

  // 当对话框打开时，清空输入
  useEffect(() => {
    if (open) {
      setAnswer("");
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (answer.trim()) {
      onSubmit(answer.trim());
      setAnswer("");
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    onSubmit(suggestion);
    setAnswer("");
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>🤖 AI 需要更多信息</DialogTitle>
          <DialogDescription>{question}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 建议选项 */}
          {suggestions && suggestions.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">💡 建议选项:</p>
              <div className="grid grid-cols-2 gap-2">
                {suggestions.map((suggestion, index) => (
                  <Button
                    key={index}
                    type="button"
                    variant="outline"
                    className="justify-start text-left h-auto py-2 px-3"
                    onClick={() => handleSuggestionClick(suggestion)}
                  >
                    <span className="mr-2 text-xs text-muted-foreground">
                      {index + 1}.
                    </span>
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* 自定义输入 */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              或者输入你自己的答案:
            </p>
            <Input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="请输入你的答案..."
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!answer.trim()}>
              提交
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

