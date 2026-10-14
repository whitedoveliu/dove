"use client";

import * as React from "react";
import { Settings2 } from "lucide-react";

import { SettingsDialog } from "@/components/settings-dialog";
import { usePublishModelBinding } from "@/lib/model-binding";

/**
 * composer 那两条模型入口（「+」旁边的齿轮 / 起始页同一颗齿轮）的兼容层。
 *
 * 模型设置的**表单已经搬进设置弹窗的「模型」分区**（settings-dialog.tsx）——
 * 那里是唯一的实现，这里只剩两件事：
 *   ① 打开设置弹窗并直接落在「模型」分区；
 *   ② 把 composer 手里那份模型状态发布出去（见 lib/model-binding.ts）——
 *      设置弹窗里的模型必须和 chip 用同一份，否则两处会各说各话。
 * ChatPanel 是别人在改的文件，入口那两处照旧调用本组件、props 不变。
 */
export interface ModelSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前模型（与 chip 同一份状态） */
  model: string;
  /** 选了别的模型 → 交给调用方持久化（和 chip 走同一条路） */
  onModelChange: (id: string) => void;
}

export function ModelSettingsDialog({ open, onOpenChange, model, onModelChange }: ModelSettingsDialogProps) {
  // 不管开没开都发布：设置弹窗可能从侧栏被打开，那时 composer 那份状态必须是现成的
  usePublishModelBinding(model, onModelChange);
  return <SettingsDialog open={open} onOpenChange={onOpenChange} initialSection="model" />;
}

/**
 * 左下角那颗齿轮（「+」菜单旁边）—— 设置弹窗的入口（落在「模型」分区）。
 * 和 ComposerPlusMenu 同一档几何（size-8 圆形 + 描边），挨着放才像一组。
 */
export function ModelSettingsButton({ onOpen, disabled }: { onOpen: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label="设置"
      title="设置（API Key / Base URL / 模型）"
      onClick={onOpen}
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong text-text-secondary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
    >
      <Settings2 className="size-3.5" />
    </button>
  );
}
