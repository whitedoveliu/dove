/**
 * 顶部状态条数据源：情绪 / 疲劳（M6）。
 * 未接入时接口返回 { available:false } → 这里直接落到 null，面板不显示、不报错。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { EmotionState, FatigueState } from "../types.ts";

export interface StatusData {
  emotion: EmotionState | null;
  fatigue: FatigueState | null;
  refresh: () => Promise<void>;
}

export function useStatus(pollMs = 20000): StatusData {
  const [emotion, setEmotion] = useState<EmotionState | null>(null);
  const [fatigue, setFatigue] = useState<FatigueState | null>(null);

  const refresh = useCallback(async () => {
    // 请求失败 / available:false 一律视为「不可用」：静默降级
    const [e, f] = await Promise.allSettled([api.emotion(), api.fatigue()]);
    setEmotion(e.status === "fulfilled" && e.value?.available ? e.value : null);
    setFatigue(f.status === "fulfilled" && f.value?.available ? f.value : null);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [refresh, pollMs]);

  return { emotion, fatigue, refresh };
}
