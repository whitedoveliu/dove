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
import {
  getPermissionMode, setPermissionMode, getPermissionPresets, getPermissionProfile, setWritableRoots,
  getPlanMode, setPlanMode,
  type PermissionMode, type PermissionPreset, type PermissionProfile,
} from "@/lib/api";

export type { PermissionMode, PermissionPreset, PermissionProfile };

/** 主机拿不到时的兜底（机值必须和主机的 PRESETS 一致） */
const FALLBACK_PRESETS: PermissionPreset[] = [
  { value: "read-only", label: "仅可查看", requiresConfirm: false, experimental: false,
    description: "只查不动：写文件、执行命令这些工具直接不给",
    profile: { sandbox: "read-only", approval: "never", writableRoots: [] } },
  { value: "workspace-write", label: "工作区内修改", requiresConfirm: false, experimental: false,
    description: "工作区内直接改；越界（装依赖、访问工作区外）才问你。注意：命令仍在本机直接执行，沙箱尚未接入",
    profile: { sandbox: "workspace-write", approval: "risky", writableRoots: [] } },
  { value: "danger-full-access", label: "完全权限", requiresConfirm: true, experimental: false,
    description: "任何操作都不再询问，工作区外的文件也能直接改 —— 只在信任的任务上用",
    profile: { sandbox: "danger-full-access", approval: "never", writableRoots: [] } },
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

/**
 * 某个档位实际生效的**沙箱轴**。
 *
 * 为什么不直接读 `preset.profile.sandbox`：老主机的预设没有 `profile` 字段（新前端对着旧内核跑），
 * 那时按档位名兜底映射 —— 宁可用映射表，也不许把 undefined 当成"没限制"。
 */
export function sandboxOfPreset(preset: PermissionPreset | undefined, mode: PermissionMode): PermissionProfile["sandbox"] {
  if (preset?.profile?.sandbox) return preset.profile.sandbox;
  if (mode === "read-only") return "read-only";
  if (mode === "workspace-write") return "workspace-write";
  return "danger-full-access";   // danger-full-access / auto
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

const DRAFT_PLAN_KEY = "dove_new_plan_mode";

/**
 * 新会话页的「计划模式」草稿 —— 和权限草稿同一个套路：
 * 那时**还没有线程**，没有东西可以 POST，所以先存在 localStorage，
 * 建项目时由 App 读走、落到线程 metadata（见 App.handleCreateProject）。
 */
export function readDraftPlanMode(): boolean {
  try { return localStorage.getItem(DRAFT_PLAN_KEY) === "1"; } catch { return false; }
}

export function writeDraftPlanMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(DRAFT_PLAN_KEY, "1");
    else localStorage.removeItem(DRAFT_PLAN_KEY);
  } catch { /* 隐私模式等，忽略 */ }
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

/**
 * 计划模式（B5）—— 线程级的**第二根权限轴**。
 *
 * 和权限档存同一个接口、同一份线程 metadata，但语义完全不同：开关它**不改档位**，
 * 只让内核把写类工具从工具表里裁掉（硬只读）。模型调研完用 ExitPlanMode 交计划，
 * 走既有审批通道；用户批准后**内核自己**把这一位关掉 —— 那一刻面板不知道，
 * 所以这里多给一个 refresh()，由 ChatPanel 在工具结果 / 一轮结束时重读。
 *
 * key 为空（还没进项目）时不做任何请求：计划模式是线程级的，没有线程就没有它。
 */
export function usePlanMode(key: string | null | undefined) {
  const [planMode, setPlanModeState] = useState(false);

  useEffect(() => {
    if (!key) { setPlanModeState(false); return; }
    let alive = true;
    getPlanMode(key)
      .then((on) => { if (alive) setPlanModeState(on); })
      // 读不到就保持现值：可能是项目刚建好、内核还没落库
      .catch(() => { /* noop */ });
    return () => { alive = false; };
  }, [key]);

  /** 开关是**乐观**的：先改界面，失败再回滚（和权限档一致） */
  const change = useCallback(async (on: boolean) => {
    const prev = planMode;
    setPlanModeState(on);
    if (!key) { setPlanModeState(prev); return; }
    try { await setPlanMode(key, on); }
    catch { setPlanModeState(prev); }   // 失败回滚
  }, [key, planMode]);

  /** 从后端重读（批准计划后内核会自己关掉） */
  const refresh = useCallback(async () => {
    if (!key) { setPlanModeState(false); return; }
    try { setPlanModeState(await getPlanMode(key)); }
    catch { /* 读不到就保持现值 */ }
  }, [key]);

  return [planMode, change, refresh] as const;
}

/**
 * 额外可写目录（`writableRoots`）—— 沙箱轴的一部分。
 *
 * 语义（与内核 `tools/permission.ts` 对齐）：这些目录是**工作区之外**的白名单 ——
 * 「工作区内修改」档下，写这些目录不再弹审批（越界 → 区内）；完全权限档下它没有意义（本来就全放行）。
 * 读不到（还没进项目 / 内核老版本没有这个字段）时保持空数组：**空 = 工作区外每次都问**，
 * 这是 fail-closed 的一侧，不许退回"没限制"。
 */
export function useWritableRoots(key: string | null | undefined) {
  const [roots, setRoots] = useState<string[]>([]);

  useEffect(() => {
    if (!key) { setRoots([]); return; }
    let alive = true;
    getPermissionProfile(key)
      .then((p) => { if (alive && p) setRoots(p.writableRoots ?? []); })
      .catch(() => { /* 读不到就保持现值：可能是项目刚建好、内核还没落库 */ });
    return () => { alive = false; };
  }, [key]);

  /** 加一个目录（去重）。乐观更新：先改界面，失败回滚（和权限档一致） */
  const add = useCallback(async (dir: string) => {
    if (!key || !dir) return;
    const prev = roots;
    const next = [...new Set([...roots, dir])];
    setRoots(next);
    try {
      const p = await setWritableRoots(key, next);
      if (p) setRoots(p.writableRoots ?? next);
    } catch { setRoots(prev); }
  }, [key, roots]);

  const remove = useCallback(async (dir: string) => {
    if (!key) return;
    const prev = roots;
    const next = roots.filter((r) => r !== dir);
    setRoots(next);
    try {
      const p = await setWritableRoots(key, next);
      if (p) setRoots(p.writableRoots ?? next);
    } catch { setRoots(prev); }
  }, [key, roots]);

  return { roots, add, remove } as const;
}
