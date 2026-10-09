"use client";

import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Upload, Clipboard, Camera, X, Loader2 } from "lucide-react";

interface UserScreenshotDialogProps {
  open: boolean;
  instruction: string;
  onSubmit: (screenshot: string) => void;
  onClose: () => void;
  onCaptureFromPreview?: () => Promise<string | null>;
}

export default function UserScreenshotDialog({
  open,
  instruction,
  onSubmit,
  onClose,
  onCaptureFromPreview,
}: UserScreenshotDialogProps) {
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 当对话框打开时，清空预览
  useEffect(() => {
    if (open) {
      setPreviewImage(null);
    }
  }, [open]);

  // 监听粘贴事件
  useEffect(() => {
    if (!open) return;

    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            await handleImageFile(file);
          }
          break;
        }
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [open]);

  // 处理图片文件
  const handleImageFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      alert("请选择图片文件");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setPreviewImage(result);
    };
    reader.readAsDataURL(file);
  };

  // 处理文件选择
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await handleImageFile(file);
    }
  };

  // 从预览区域截图
  const handleCaptureFromPreview = async () => {
    if (!onCaptureFromPreview) return;
    
    setIsCapturing(true);
    try {
      const screenshot = await onCaptureFromPreview();
      if (screenshot) {
        setPreviewImage(screenshot);
      } else {
        alert("截图失败，请重试");
      }
    } catch (error) {
      console.error("截图失败:", error);
      alert("截图失败，请重试");
    } finally {
      setIsCapturing(false);
    }
  };

  // 提交截图
  const handleSubmit = () => {
    if (previewImage) {
      onSubmit(previewImage);
      setPreviewImage(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>📸 需要你的协助截图</DialogTitle>
          <DialogDescription className="text-base pt-2">
            {instruction}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 截图预览 */}
          {previewImage ? (
            <div className="relative border-2 border-dashed border-success rounded-lg p-2 bg-success-subtle">
              <button
                onClick={() => setPreviewImage(null)}
                className="absolute top-3 right-3 w-6 h-6 rounded-full bg-danger text-white flex items-center justify-center hover:bg-danger-hover transition-colors z-10"
                title="删除截图"
              >
                <X className="w-4 h-4" />
              </button>
              <img
                src={previewImage}
                alt="Screenshot preview"
                className="w-full h-auto rounded"
              />
              <p className="text-sm text-success-fg mt-2 text-center font-medium">
                ✅ 截图已准备好，点击"提交截图"发送给 AI
              </p>
            </div>
          ) : (
            <div className="border-2 border-dashed border-border-default rounded-lg p-8 text-center bg-surface-inset">
              <Camera className="w-12 h-12 mx-auto mb-3 text-text-tertiary" />
              <p className="text-sm text-muted-foreground">
                请选择一种方式提供截图
              </p>
            </div>
          )}

          {/* 操作按钮 */}
          {!previewImage && (
            <div className="grid grid-cols-1 gap-3">
              {/* 上传文件 */}
              <Button
                type="button"
                variant="outline"
                className="h-auto py-4 justify-start"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-5 h-5 mr-3" />
                <div className="text-left">
                  <div className="font-medium">上传截图文件</div>
                  <div className="text-xs text-muted-foreground">
                    支持 PNG、JPG、GIF 等图片格式
                  </div>
                </div>
              </Button>

              {/* 粘贴截图 */}
              <Button
                type="button"
                variant="outline"
                className="h-auto py-4 justify-start"
                onClick={() => {
                  alert("请使用 Ctrl/Cmd + V 粘贴截图");
                }}
              >
                <Clipboard className="w-5 h-5 mr-3" />
                <div className="text-left">
                  <div className="font-medium">粘贴截图</div>
                  <div className="text-xs text-muted-foreground">
                    按 Ctrl/Cmd + V 直接粘贴剪贴板中的图片
                  </div>
                </div>
              </Button>

              {/* 从预览区域截图 */}
              {onCaptureFromPreview && (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto py-4 justify-start"
                  onClick={handleCaptureFromPreview}
                  disabled={isCapturing}
                >
                  {isCapturing ? (
                    <Loader2 className="w-5 h-5 mr-3 animate-spin" />
                  ) : (
                    <Camera className="w-5 h-5 mr-3" />
                  )}
                  <div className="text-left">
                    <div className="font-medium">
                      {isCapturing ? "正在截图..." : "截取预览区域"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      直接截取左侧预览区域的当前画面
                    </div>
                  </div>
                </Button>
              )}
            </div>
          )}
        </div>

        {/* 隐藏的文件输入 */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileSelect}
        />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!previewImage}
          >
            提交截图
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

