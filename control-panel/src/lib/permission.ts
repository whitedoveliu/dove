/**
 * 权限模式 —— **全应用唯一的抽象**。
 *
 * 以前这套逻辑散在三处（ChatPanel 的 state、App 的建项目逻辑、api 的裸 get/set），
 * 靠约定对齐，没人保证一致 —— 「新会话选了完全权限、进去还是工作区」就是这么来的。
 * 现在只有一个入口：usePermissionMode(key)。
 *
 * 预设文案（B4）由**主机下发**，前端不再硬编码 —— 加一档只改主机一处。
 * 拿不到时用本地兜底（离线也不能没有权限选择器）。
 */
import { useCallback, useEffect, useState } from "react";
import { getPermissionMode, setPermissionMode, getPermissionPresets, type PermissionMode, type PermissionPreset } from "@/lib/api";

export type { PermissionMode, PermissionPreset };

/** 主机拿不到时的兜底（机值必须和主机的 PRESETS 一致） */
const FALLBACK_PRESETS: PermissionPreset[] = [
  { value: "read-only", label: "仅可查看", requiresConfirm: false, experimental: false, description: "只查不动：写文件、执行命令这些工具直接不给" },
  { value: "workspace-write", label: "工作区内修改", requiresConfirm: false, experimental: false, description: "工作区内直接改；越界（装依赖、访问工作区外）才问你" },
  { value: "danger-full-access", label: "完全权限", requiresConfirm: true, experimental: false, description: "任何操作都不再询问 —— 只在信任的任务上用" },
];

export const DEFAULT_PERMISSION: PermissionMode = "workspace-write";

/**
 * 两组文案（B3）—— **同样的档位，不同的语义**。
 *
 * 这正是上一轮踩的坑：新会话页配的是「下一个项目的默认值」，
 * 会话内配的是「当前这次对话」，用同一份文案会让用户以为改的是同一个东西。
 */
export const PERM_COPY = {
  /** 会话内（输入框那一行的选择器） */
  session: {
    title: "访问模式",
    hint: "影响**当前会话**",
  },
  /** 新会话页 / 设置 */
  defaults: {
    title: "权限",
    hint: "选择**新会话**的默认权限模式",
  },
} as const;

/** 从主机拉预设目录 */
export function usePermissionPresets(): { presets: PermissionPreset[]; loading: boolean } {
  const [presets, setPresets] = useState<PermissionPreset[]>(FALLBACK_PRESETS);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    getPermissionPresets()
      .then((list) => { if (alive && list.length > 0) setPresets(list); })
      .catch(() => { /* 拉不到就用兜底 */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  return { presets, loading };
}

export function presetOf(presets: PermissionPreset[], mode: PermissionMode): PermissionPreset | undefined {
  return presets.find((p) => p.value === mode);
}

const DRAFT_KEY = "dove_new_permission";
const VALID = new Set<string>(["read-only", "workspace-write", "danger-full-access", "auto"]);
/** 旧机值 → 新机值（localStorage 里可能还存着旧的） */
const ALIAS: Record<string, PermissionMode> = {
  full: "danger-full-access", workspace: "workspace-write", readonly: "read-only",
};

function isMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && VALID.has(v);
}

/** 新会话页选的权限（下一个项目的默认值）。建项目时由 App 读走。 */
export function readDraftPermission(): PermissionMode {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw && ALIAS[raw]) return ALIAS[raw];
    return isMode(raw) ? raw : DEFAULT_PERMISSION;
  } catch { return DEFAULT_PERMISSION; }
}

function writeDraftPermission(m: PermissionMode): void {
  try { localStorage.setItem(DRAFT_KEY, m); } catch { /* 隐私模式等，忽略 */ }
}

/**
 * 权限模式的读写。key 为项目标识（端口或 id），为空表示「还没有项目」。
 *
 * 切换是**乐观**的：先改界面，失败再回滚 —— 否则每次点权限都要等一个网络往返。
 * 「要不要确认」由调用方先过（见 PermissionSelect 的确认闸）。
 */
export function usePermissionMode(key: string | null | undefined) {
  const [mode, setMode] = useState<PermissionMode>(readDraftPermission);

  useEffect(() => {
    if (!key) { setMode(readDraftPermission()); return; }
    let alive = true;
    getPermissionMode(key)
      .then((m) => { if (alive) setMode(m); })
      // 读不到就保持当前值：可能是项目刚建好、内核还没落库
      .catch(() => { /* noop */ });
    return () => { alive = false; };
  }, [key]);

  const change = useCallback(async (m: PermissionMode) => {
    const prev = mode;
    setMode(m);                       // 乐观更新
    if (!key) { writeDraftPermission(m); return; }   // 还没有项目 → 存默认值
    try { await setPermissionMode(key, m); }
    catch { setMode(prev); }          // 失败回滚
  }, [key, mode]);

  return [mode, change] as const;
}
