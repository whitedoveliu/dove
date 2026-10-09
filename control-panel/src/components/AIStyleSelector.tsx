"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Sparkles } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

// 预设风格
const STYLE_PRESETS = [
  {
    id: "professional_advisor",
    name: "专业顾问",
    x: 70,
    y: 85,
    emoji: "👔",
  },
  {
    id: "partner",
    name: "伙伴",
    x: 50,
    y: 35,
    emoji: "🤝",
  },
  {
    id: "creative_buddy",
    name: "创意搭档",
    x: 85,
    y: 25,
    emoji: "🎨",
  },
  {
    id: "executor",
    name: "执行者",
    x: 20,
    y: 60,
    emoji: "⚡",
  },
  {
    id: "chill_helper",
    name: "佛系助手",
    x: 25,
    y: 15,
    emoji: "🍵",
  },
];

// 本地存储 key
const STYLE_STORAGE_KEY = "ai_style_settings";

interface AIStyleSelectorProps {
  onStyleChange?: (x: number, y: number) => void;
  defaultX?: number;
  defaultY?: number;
}

// 获取风格描述
function getStyleDescription(x: number, y: number): string {
  const profDesc = y <= 33 ? "轻松" : y <= 66 ? "友好" : "专业";
  const initDesc = x <= 33 ? "被动" : x <= 66 ? "适度" : "主动";
  return `${profDesc} · ${initDesc}`;
}

// 加载保存的风格
function loadSavedStyle(): { x: number; y: number } {
  if (typeof window === "undefined") return { x: 50, y: 35 };
  try {
    const saved = localStorage.getItem(STYLE_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { x: parsed.x ?? 50, y: parsed.y ?? 35 };
    }
  } catch {
    // ignore
  }
  return { x: 50, y: 35 }; // 默认：伙伴风格
}

// 保存风格
function saveStyle(x: number, y: number) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {
    // ignore
  }
}

export default function AIStyleSelector({
  onStyleChange,
  defaultX,
  defaultY,
}: AIStyleSelectorProps) {
  const [open, setOpen] = useState(false);
  
  // 从本地存储加载初始值
  const [position, setPosition] = useState(() => {
    if (defaultX !== undefined && defaultY !== undefined) {
      return { x: defaultX, y: defaultY };
    }
    return loadSavedStyle();
  });
  
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 初始化时通知父组件
  useEffect(() => {
    onStyleChange?.(position.x, position.y);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 更新位置并保存
  const updatePosition = useCallback(
    (x: number, y: number) => {
      const newPos = { x, y };
      setPosition(newPos);
      saveStyle(x, y);
      onStyleChange?.(x, y);
    },
    [onStyleChange]
  );

  // 处理拖拽
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!isDragging || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      // Y 轴反转：视觉上的顶部是高值
      const y = Math.max(0, Math.min(100, 100 - ((e.clientY - rect.top) / rect.height) * 100));

      updatePosition(Math.round(x), Math.round(y));
    },
    [isDragging, updatePosition]
  );

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      return () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };
    }
  }, [isDragging, handlePointerMove, handlePointerUp]);

  // 点击坐标轴区域
  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, 100 - ((e.clientY - rect.top) / rect.height) * 100));
    updatePosition(Math.round(x), Math.round(y));
  };

  // 选择预设
  const handlePresetClick = (preset: (typeof STYLE_PRESETS)[0]) => {
    updatePosition(preset.x, preset.y);
  };

  // 找到最接近的预设
  const closestPreset = STYLE_PRESETS.reduce((closest, preset) => {
    const dist = Math.sqrt(
      Math.pow(preset.x - position.x, 2) + Math.pow(preset.y - position.y, 2)
    );
    const closestDist = Math.sqrt(
      Math.pow(closest.x - position.x, 2) + Math.pow(closest.y - position.y, 2)
    );
    return dist < closestDist ? preset : closest;
  }, STYLE_PRESETS[0]);

  // 是否在预设位置附近
  const isNearPreset = Math.sqrt(
    Math.pow(closestPreset.x - position.x, 2) +
    Math.pow(closestPreset.y - position.y, 2)
  ) < 10;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          title={`AI 风格: ${getStyleDescription(position.x, position.y)}`}
        >
          <Sparkles className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4" align="end">
        <div className="space-y-4">
          {/* 标题 */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">AI 对话风格</span>
            <span className="text-xs text-muted-foreground">
              {isNearPreset ? closestPreset.name : getStyleDescription(position.x, position.y)}
            </span>
          </div>

          {/* 坐标轴拖拽区域 */}
          <div className="relative">
            {/* Y 轴标签 */}
            <div className="absolute -left-1 top-0 bottom-0 flex flex-col justify-between text-[10px] text-muted-foreground pointer-events-none">
              <span>专业</span>
              <span>轻松</span>
            </div>

            {/* 坐标轴容器 */}
            <div
              ref={containerRef}
              className="ml-6 h-40 bg-muted/50 rounded-lg relative cursor-crosshair select-none overflow-hidden"
              onClick={handleContainerClick}
              onPointerDown={(e) => {
                e.preventDefault();
                setIsDragging(true);
                handleContainerClick(e);
              }}
            >
              {/* 网格线 */}
              <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none">
                {[...Array(9)].map((_, i) => (
                  <div key={i} className="border border-muted-foreground/10" />
                ))}
              </div>

              {/* 预设点标记 */}
              {STYLE_PRESETS.map((preset) => (
                <div
                  key={preset.id}
                  className="absolute w-6 h-6 -translate-x-1/2 translate-y-1/2 flex items-center justify-center text-xs opacity-30 hover:opacity-70 transition-opacity cursor-pointer pointer-events-auto"
                  style={{
                    left: `${preset.x}%`,
                    bottom: `${preset.y}%`,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePresetClick(preset);
                  }}
                  title={preset.name}
                >
                  {preset.emoji}
                </div>
              ))}

              {/* 当前位置指示器 */}
              <div
                className="absolute w-5 h-5 -translate-x-1/2 translate-y-1/2 rounded-full bg-primary shadow-lg flex items-center justify-center cursor-grab active:cursor-grabbing transition-shadow hover:shadow-lg"
                style={{
                  left: `${position.x}%`,
                  bottom: `${position.y}%`,
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDragging(true);
                }}
              >
                <div className="w-2 h-2 rounded-full bg-primary-foreground" />
              </div>
            </div>

            {/* X 轴标签 */}
            <div className="ml-6 mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>被动</span>
              <span>主动</span>
            </div>
          </div>

          {/* 预设快捷按钮 */}
          <div className="flex flex-wrap gap-1.5">
            {STYLE_PRESETS.map((preset) => {
              const isActive =
                Math.abs(preset.x - position.x) < 5 &&
                Math.abs(preset.y - position.y) < 5;
              return (
                <button
                  key={preset.id}
                  onClick={() => handlePresetClick(preset)}
                  className={`px-2 py-1 text-xs rounded-md transition-colors ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted hover:bg-muted/80 text-muted-foreground"
                  }`}
                >
                  {preset.emoji} {preset.name}
                </button>
              );
            })}
          </div>

          {/* 当前值显示 */}
          <div className="text-center text-xs text-muted-foreground">
            主动性: {position.x}% · 专业性: {position.y}%
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// 导出加载函数供外部使用
export { loadSavedStyle, STYLE_STORAGE_KEY };

