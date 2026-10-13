import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";

/**
 * 全窗口「拖进来就能传」的蒙层。
 *
 * 为什么是**全窗口**（window 上的原生监听，而不是给某个 div 加 onDrop）：
 * 用户拖文件时不会瞄着输入框松手 —— 他往窗口里一甩。只有落在输入框上才响应
 * 的落点，等于让用户猜「哪里能放」。所以监听装在 window 上，蒙层铺满整个窗口。
 *
 * 三个细节都是踩过才知道会错的：
 *   · **dragleave 会冒泡**：从子元素划过去时也会触发一遍，用布尔量会出现
 *     「蒙层闪一下就没了」。这里用计数器（进入 +1 / 离开 -1，归零才收）。
 *   · **不是所有拖拽都是文件**：选中文字往外拖也会触发 dragenter，
 *     那时候弹「松手即上传」是错的。只认 dataTransfer.types 里有 "Files"。
 *   · **必须拦住默认行为**：不 preventDefault 的话，松手时浏览器会把
 *     文件当成导航目标（webview 直接跳到 file://…）或把文件名插进正文。
 *     所以哪怕当前没有任务可落（起始页），也要拦 —— 只是把文案换成「先建任务」。
 *
 * 蒙层本身 pointer-events:none：它只是画给人看的，事件照旧落到下层元素
 * （已有的 drop 落点，比如请求截图那张卡片，仍然先拿到事件）。
 */
export interface DropFilesOverlayProps {
  /** 文件会落到哪个任务（显示用）。null = 还没有任务，落不了地 */
  targetLabel?: string | null;
  /** 松手时一次拿到所有文件（调用方自己决定传哪儿、怎么报错） */
  onFiles: (files: File[]) => void;
}

export function DropFilesOverlay({ targetLabel, onFiles }: DropFilesOverlayProps) {
  const [active, setActive] = useState(false);
  /** dragenter/dragleave 的层数（见上面第 ②点） */
  const depth = useRef(0);
  /** 回调放 ref：监听只在挂载时装一次，不必因为 props 变化重装 */
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const reset = () => { depth.current = 0; setActive(false); };

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current += 1;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();                                  // 不拦就没有 drop 事件
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      reset();                                             // 松手立刻收蒙层
      if (e.defaultPrevented) return;                      // 更内层的落点已经处理过了
      if (files.length === 0) return;
      e.preventDefault();
      onFilesRef.current(files);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    // 拖出窗口 / 拖拽被取消时 dragleave 不一定来，兜一道
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);

  if (!active) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[200] flex items-center justify-center p-8" aria-hidden>
      <div className="absolute inset-0 bg-[rgb(var(--surface-app)/0.72)] backdrop-blur-[2px]" />
      <div className="relative flex max-w-[440px] flex-col items-center gap-1.5 rounded-[22px] border-2 border-dashed border-[rgb(var(--accent)/0.45)] bg-surface-raised px-8 py-7 text-center shadow-lg">
        <UploadCloud className="size-7 text-[rgb(var(--accent))]" />
        <p className="text-sm font-semibold text-text-primary">
          {targetLabel ? "松手即上传" : "先建好任务再拖文件"}
        </p>
        <p className="text-xs text-text-secondary">
          {targetLabel
            ? `文件会放进「${targetLabel}」的 uploads/ 目录，模型可以直接读`
            : "文件要有地方放：在输入框里说一句话建好任务，再拖进来"}
        </p>
        <p className="text-2xs text-text-tertiary">任意格式 · 单个文件上限 20MB · 可一次拖多个</p>
      </div>
    </div>
  );
}
