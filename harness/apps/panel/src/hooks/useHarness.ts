/** 全局数据源：健康 / 会话 / 项目 / 记忆 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Health, MemoryItem, Project, Thread } from "../types.ts";

export function useHarness() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [memory, setMemory] = useState<MemoryItem[]>([]);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
      setHealthError(null);
    } catch (err) {
      setHealth(null);
      setHealthError((err as Error).message);
    }
  }, []);

  /** 内核未启动时静默失败：面板仍可打开 */
  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await api.threads());
    } catch {
      setThreads([]);
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.projects());
    } catch {
      setProjects([]);
    }
  }, []);

  const refreshMemory = useCallback(async () => {
    try {
      setMemory(await api.memory());
    } catch {
      setMemory([]);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    void refreshThreads();
    void refreshProjects();
    const timer = window.setInterval(() => void refreshHealth(), 10000);
    return () => window.clearInterval(timer);
  }, [refreshHealth, refreshThreads, refreshProjects]);

  const createThread = useCallback(
    async (kind: string, title: string, projectId?: string | null) => {
      const created = await api.createThread({ kind, title, projectId });
      await refreshThreads();
      return created;
    },
    [refreshThreads],
  );

  const createProject = useCallback(
    async (name: string, path: string) => {
      const created = await api.createProject({ name, path });
      await refreshProjects();
      return created;
    },
    [refreshProjects],
  );

  const build = useCallback((projectId: string) => api.build(projectId), []);

  return {
    health,
    healthError,
    threads,
    projects,
    memory,
    refreshHealth,
    refreshThreads,
    refreshProjects,
    refreshMemory,
    createThread,
    createProject,
    build,
  };
}
