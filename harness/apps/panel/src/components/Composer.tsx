/** 输入区：自增高 textarea + Enter 发送 / Shift+Enter 换行 + 停止按钮（兼容中文输入法） */
import { useEffect, useRef, useState } from "react";
import { Button, cn } from "./ui/Primitives.tsx";

export interface ComposerProps {
  disabled: boolean;
  streaming: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ disabled, streaming, placeholder, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 168) + "px";
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled || streaming) return;
    setText("");
    onSend(value);
  };

  return (
    <div className="shrink-0 border-t border-line bg-panel px-3 py-2">
      <div
        className={cn(
          "flex items-end gap-2 rounded-md border bg-inset p-2 transition-colors duration-100",
          disabled ? "border-line" : "border-line-strong focus-within:border-accent",
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder ?? "描述你的需求：Enter 发送，Shift+Enter 换行"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="min-h-[20px] max-h-[168px] flex-1 resize-none bg-transparent px-1 py-0.5 text-[13px] leading-[1.55] text-fg outline-none placeholder:text-fg-mute disabled:opacity-50"
        />
        {streaming ? (
          <Button variant="danger" size="md" onClick={onStop} title="停止生成">
            ■ 停止
          </Button>
        ) : (
          <Button variant="primary" size="md" onClick={submit} disabled={disabled || !text.trim()}>
            ↑ 发送
          </Button>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between px-1 font-mono text-[10px] text-fg-mute">
        <span>{disabled ? "先选择一个会话" : "Enter 发送 · Shift+Enter 换行"}</span>
        <span>{text.length > 0 ? text.length + " 字" : ""}</span>
      </div>
    </div>
  );
}
