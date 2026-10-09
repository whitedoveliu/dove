/** 事件日志：轮询 GET /api/logs?threadId=&limit= */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { LogEvent } from "../types.ts";

export function useLogs(threadId: string | null, enabled: boolean, intervalMs = 2500) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);
  const reloadRef = useRef(0);

  const reload = useCallback(() => {
    reloadRef.current += 1;
    setTick(reloadRef.current);
  }, []);

  useEffect(() => {
    if (!threadId || !enabled || paused) return;
    let alive = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const list = await api.logs(threadId, 200);
        if (!alive) return;
        setEvents(list);
        setError(null);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
      if (alive) timer = window.setTimeout(poll, intervalMs);
    };

    void poll();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [threadId, enabled, paused, intervalMs, tick]);

  return { events, error, paused, setPaused, reload };
}
