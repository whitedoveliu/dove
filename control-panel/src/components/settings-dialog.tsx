"use client";

import * as React from "react";
import { Cpu, FolderOpen, Monitor, Moon, SlidersHorizontal, Sun } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import {
  apiFetch, getModelSettings, getPanelOrigin, openProjectPath, saveModelSettings, testModelSettings,
} from "@/lib/api";
import { modelChoices, modelDisplay } from "@/lib/models";
import { useModelBinding } from "@/lib/model-binding";
import { useTheme, type ThemeMode } from "@/lib/theme";

/**
 * 设置弹窗 —— 侧栏左下角的「设置」和 ⌘, 都开它，左边分区导航、右边内容。
 *
 * 两个分区，各自的「事实来源」都不一样，别把它们看成一份状态：
 *   · 通用 —— 外观（主题）、记忆文件夹、版本行。主题是**全局一份**（lib/theme.ts），
 *     记忆文件夹与版本只有内核知道（/api/config · /api/health），读不到就不显示那一行。
 *   · 模型 —— API key / Base URL / 模型，**整段搬自 model-settings-dialog.tsx**（逻辑与
 *     API 调用一字未改）。那边现在只剩一个薄壳，把 composer 的入口引到这里。
 *
 * 模型那一栏为什么看 lib/model-binding.ts：模型状态在 ChatPanel 手里（chip 和它共用），
 * 设置弹窗自己再读一份内核值就会出现「设置里改了、chip 还是旧的」。
 */
export type SettingsSection = "general" | "model";

const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "通用", icon: <SlidersHorizontal /> },
  { id: "model", label: "模型", icon: <Cpu /> },
];

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 打开时停在哪个分区（模型那条旧入口要直接落到「模型」）。
   * 不给（侧栏入口）= 沿用它上次看的那个，别把「刚才在看模型」的人又扔回通用。
   */
  initialSection?: SettingsSection;
}

export function SettingsDialog({ open, onOpenChange, initialSection }: SettingsDialogProps) {
  const [section, setSection] = React.useState<SettingsSection>(initialSection ?? "general");
  const [prevOpen, setPrevOpen] = React.useState(open);
  const activeNavRef = React.useRef<HTMLButtonElement>(null);
  /**
   * 触发这次打开的那个控件 —— 关闭后焦点要还给它（Radix 只在用 DialogTrigger 时才知道
   * trigger 是谁，这里的打开是程序式的，得自己记）。
   */
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  // 打开的那一刻落位：说了就听他的，没说就沿用上次的（在渲染期算完，别等 effect ——
  // 等 effect 的话下面那句聚焦会先落在**上一个**分区上再跳）
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setSection(initialSection ?? section);
  }

  React.useEffect(() => {
    if (!open) return;
    // 初始焦点落在当前分区（Tab 从这里出发），和 DSH 一致
    activeNavRef.current?.focus();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(800px,calc(100dvh_-_3rem))] w-[min(800px,calc(100vw_-_3rem))] max-w-none flex-col gap-0 overflow-hidden p-0"
        onOpenAutoFocus={() => {
          // Radix 把焦点抢进弹窗之前，activeElement 还是那颗齿轮
          returnFocusRef.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus?.();
          returnFocusRef.current = null;
        }}
      >
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5">
          <DialogTitle>设置</DialogTitle>
          {/* 给读屏器一句话，标题本身太短说不清这是个弹窗 */}
          <DialogDescription className="sr-only">面板设置：通用与模型</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 border-t border-border-subtle">
          <nav aria-label="设置分区" className="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r border-border-subtle p-2">
            {SECTIONS.map((entry) => {
              const active = section === entry.id;
              return (
                <button
                  key={entry.id}
                  ref={active ? activeNavRef : undefined}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => setSection(entry.id)}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-sm transition-colors duration-fast",
                    active
                      ? "bg-surface-active font-medium text-text-primary"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
                  )}
                >
                  <span className={cn("shrink-0 [&_svg]:size-4", active ? "text-text-secondary" : "text-text-tertiary")}>
                    {entry.icon}
                  </span>
                  {entry.label}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {/* 两栏都挂着，只藏一个：切走再切回来时**没保存的草稿还在**
                （baseUrl / 刚敲的 key），卸载重挂会悄悄丢掉它们。 */}
            <div className={cn(section !== "general" && "hidden")}>
              <GeneralSection active={section === "general"} />
            </div>
            <div className={cn(section !== "model" && "hidden")}>
              <ModelSection active={section === "model"} onRequestClose={() => onOpenChange(false)} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ 通用 */

/** 版本号 + 记忆文件夹 + 工作区根 —— 面板同源路由上那几条只读信息 */
interface KernelInfo {
  version: string;
  configDir: string;
  workspaceRoot: string;
}

let kernelInfoCache: KernelInfo | null = null;

/**
 * 读内核自己报的版本号（/api/health 的 version）和记忆文件夹（/api/config 的 configDir）。
 *
 * 两条都在**面板同源**那份服务（内核 8790）上 —— 8008 那套老契约没有它们。
 * 为什么不去猜 ~/.dove：那个目录是 DOVE_CONFIG 给的，面板照抄内核的答案才不会指错地方。
 * 拿不到就返回 null，调用方据此**不渲染**那一行（宁可少一行，也不显示一个假的）。
 */
async function fetchKernelInfo(): Promise<KernelInfo | null> {
  const bases = [getPanelOrigin(), `http://${window.location.hostname}:8790`];
  for (const base of bases) {
    try {
      const [health, config] = await Promise.all([
        apiFetch(`${base}/api/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        apiFetch(`${base}/api/config`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      const version = typeof health?.version === "string" ? health.version : "";
      const configDir = typeof config?.configDir === "string" ? config.configDir : "";
      const workspaceRoot = typeof config?.workspaceRoot === "string" ? config.workspaceRoot : "";
      if (version || configDir) return { version, configDir, workspaceRoot };
    } catch {
      /* 这个 base 不通：换下一个 */
    }
  }
  return null;
}

function useKernelInfo(active: boolean): KernelInfo | null {
  // 缓存住：版本号和配置目录在进程活着的这段时间里不会变，每次开弹窗都重拉只会闪一下
  const [info, setInfo] = React.useState<KernelInfo | null>(kernelInfoCache);
  React.useEffect(() => {
    if (!active || info) return;
    let cancelled = false;
    void fetchKernelInfo().then((next) => {
      if (cancelled || !next) return;
      kernelInfoCache = next;
      setInfo(next);
    });
    return () => { cancelled = true; };
  }, [active, info]);
  return info;
}

/** 面板拿不到家目录，但 `/Users/x/...` `/home/x/...` 这个形状的绝对路径可以缩成 ~ 好读 */
function prettyPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~").replace(/\/+$/, "");
}

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "浅色", icon: <Sun /> },
  { value: "dark", label: "深色", icon: <Moon /> },
  { value: "system", label: "跟随系统", icon: <Monitor /> },
];

function SettingsRow({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3.5">
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium text-text-secondary">{label}</p>
        {hint && <p className="text-2xs leading-relaxed text-text-tertiary">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">{children}</div>
    </div>
  );
}

function GeneralSection({ active }: { active: boolean }) {
  const { mode, setTheme } = useTheme();
  const { toast } = useToast();
  const [opening, setOpening] = React.useState(false);
  const info = useKernelInfo(active);

  const openMemoryFolder = async () => {
    if (!info?.configDir) return;
    setOpening(true);
    try {
      // ⚠️ **不带 project_id**：契约里这才是「以工作区根为边界」那条用法
      // （给了 project_id 就按那个项目的目录解析，而记忆文件夹不在任何项目里）。
      // 越界时后端是硬拒（403），把它的话原样显示出来 —— 那边会写清是哪条边界。
      const result = await openProjectPath({ path: info.configDir, action: "default" });
      if (result.ok) {
        toast({ title: "已打开记忆文件夹", description: result.message, tone: "success" });
        return;
      }
      // 内核的拒绝话术只说「不在项目工作区内」，用户不知道工作区是哪儿 ——
      // 把工作区根带上，才知道下一步该做什么（这里只在**已经失败**时补一句解释，
      // 判定边界归内核，面板不拿它去拦操作）。
      const outside = info.workspaceRoot
        && info.configDir !== info.workspaceRoot
        && !info.configDir.startsWith(info.workspaceRoot.replace(/\/+$/, "") + "/");
      toast({
        title: "没能打开记忆文件夹",
        description: outside
          ? `${result.message}（内核只肯打开工作区里的路径；当前工作区 ${prettyPath(info.workspaceRoot)}）`
          : result.message,
        tone: "warning",
      });
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="divide-y divide-border-subtle">
        <SettingsRow label="外观" hint="面板的配色；「跟随系统」跟着系统走">
          <div
            role="radiogroup"
            aria-label="外观"
            className="inline-flex items-center gap-0.5 rounded-lg border border-border-subtle bg-surface-inset p-0.5"
          >
            {THEME_OPTIONS.map((option) => {
              const checked = mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setTheme(option.value)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-2xs font-medium transition-colors duration-fast",
                    checked
                      ? "bg-surface-raised text-text-primary shadow-xs"
                      : "text-text-secondary hover:text-text-primary",
                  )}
                >
                  <span className="[&_svg]:size-3.5">{option.icon}</span>
                  {option.label}
                </button>
              );
            })}
          </div>
        </SettingsRow>

        {/* 读不到配置目录（内核没起来 / 请求被拒）就不渲染这行 —— 猜一个 ~/.dove 会更糟：
            用户按下去要么打不开，要么打开的是别的地方。 */}
        {info?.configDir && (
          <SettingsRow
            label="记忆文件夹"
            hint={`${prettyPath(info.configDir)} —— SOUL / USER / MEMORY 和每天的日记都在这里`}
          >
            <Button
              variant="outline"
              size="sm"
              aria-label="打开记忆文件夹"
              disabled={opening}
              onClick={() => void openMemoryFolder()}
            >
              {opening ? <Spinner size={12} label="打开中" /> : <FolderOpen />}
              打开
            </Button>
          </SettingsRow>
        )}
      </div>

      {/* 版本来自内核（GET /api/health 的 version），面板侧没有镜像；拿不到就不显示 */}
      {info?.version && <p className="text-2xs text-text-tertiary">版本 {info.version}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ 模型 */

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; text: string }
  | { kind: "fail"; text: string };

/**
 * 模型分区 —— 与 model-settings-dialog.tsx 里那份表单是同一套逻辑（值存内核、
 * key 不回填、测试用屏幕上这些值），只是从「独立弹窗」换成「设置里的一栏」。
 * `active` = 这一栏现在是不是可见（藏着的栏不发请求、不读设置）。
 */
function ModelSection({ active, onRequestClose }: { active: boolean; onRequestClose: () => void }) {
  const { toast } = useToast();
  const binding = useModelBinding();
  const [baseUrl, setBaseUrl] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");     // 空串 = 不改（永远不回填原 key）
  const [hasKey, setHasKey] = React.useState(false);
  const [keyMasked, setKeyMasked] = React.useState("");
  const [kernelModel, setKernelModel] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [test, setTest] = React.useState<TestState>({ kind: "idle" });

  // 每次切到这一栏都重读一遍：别的地方（比如内核被别的东西改了）改过设置时不能显示旧值
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    setApiKey("");
    setTest({ kind: "idle" });
    getModelSettings()
      .then((s) => {
        if (cancelled) return;
        setBaseUrl(s.baseUrl);
        setHasKey(s.hasKey);
        setKeyMasked(s.keyMasked);
        setKernelModel(s.model);
      })
      .catch((e: unknown) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active]);

  /** 当前模型以 composer 那份为准（chip 显示的就是它，见 lib/model-binding.ts） */
  const model = binding?.model || kernelModel;

  /** 选了别的模型就立刻存（不等人点保存）—— composer 那条路会连 chip 和内核一起写 */
  const chooseModel = (id: string) => {
    if (!id || id === model) return;
    if (binding) {
      binding.onChange(id);
      return;
    }
    // 兜底：composer 还没把状态发布出来（正常流程走不到，见 lib/model-binding.ts）
    void saveModelSettings({ model: id }).catch((e: unknown) => {
      toast({ title: "模型没能存进内核", description: e instanceof Error ? e.message : String(e), tone: "warning" });
    });
  };

  /** 测试用**屏幕上这些值**（没保存也算）—— 用户刚敲完 key 就想试，不该逼他先保存 */
  const runTest = async () => {
    setTest({ kind: "running" });
    try {
      const r = await testModelSettings({
        baseUrl: baseUrl.trim() || undefined,
        model: model || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      setTest(r.ok ? { kind: "ok", text: `通了 · ${r.latencyMs} ms` } : { kind: "fail", text: `不通：${r.error}` });
    } catch (e) {
      setTest({ kind: "fail", text: `不通：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveModelSettings({
        baseUrl: baseUrl.trim() || undefined,
        model: model || undefined,
        apiKey: apiKey.trim() || undefined,   // 空串 → 不发这个字段 → 内核保留原 key
      });
      setApiKey("");
      toast({ title: "设置已保存", description: "内核下一轮就用新的配置" });
      onRequestClose();
    } catch (e) {
      toast({
        title: "保存失败",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3.5 py-1">
      <p className="text-xs leading-relaxed text-text-secondary">
        API key / 地址 / 模型存在内核里（不是浏览器），保存后下一轮就用，不用重启。
        不填 API Key 就是不改动原来那把。
      </p>

      {/* ── API Key ─────────────────────────────── */}
      <div className="space-y-1.5">
        <label htmlFor="settings-model-key" className="text-xs font-medium text-text-secondary">API Key</label>
        <Input
          id="settings-model-key"
          aria-label="API Key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? keyMasked : "sk-…"}
          className="rounded-lg border border-border-strong bg-surface-inset px-2.5"
        />
        <p className="text-2xs text-text-tertiary">
          {loading ? "正在读内核里的设置…"
            : loadError ? `读不到内核设置：${loadError}`
            : hasKey ? `已设置 ${keyMasked} —— 留空 = 不改；粘贴新 key 会整体替换`
            : "还没配 key：填一把再点「测试」"}
        </p>
      </div>

      {/* ── Base URL ────────────────────────────── */}
      <div className="space-y-1.5">
        <label htmlFor="settings-model-baseurl" className="text-xs font-medium text-text-secondary">Base URL</label>
        <Input
          id="settings-model-baseurl"
          aria-label="Base URL"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.deepseek.com/v1"
          spellCheck={false}
          className="rounded-lg border border-border-strong bg-surface-inset px-2.5"
        />
      </div>

      {/* ── 模型（和 chip 同一份状态）────────────────── */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-text-secondary">模型</span>
        <div className="flex flex-wrap gap-1.5">
          {modelChoices(model).map((id) => (
            <button
              key={id}
              type="button"
              title={id}
              onClick={() => chooseModel(id)}
              className={cn(
                "h-7 rounded-full border px-2.5 text-2xs transition-colors duration-fast",
                id === model
                  ? "border-accent-border bg-accent-subtle text-accent-subtle-fg"
                  : "border-border-default bg-surface-inset text-text-secondary hover:bg-surface-hover hover:text-text-primary",
              )}
            >
              {modelDisplay(id)}
            </button>
          ))}
        </div>
      </div>

      {/* 测试结果就在按钮旁边，不弹窗 —— 成功/失败都是这一行文字 */}
      <div className="flex min-h-[20px] items-center gap-2">
        {test.kind === "running" && (
          <span className="flex items-center gap-1.5 text-2xs text-text-tertiary">
            <Spinner size={12} label="测试中" />测试中…
          </span>
        )}
        {test.kind === "ok" && <span className="text-2xs font-medium text-success-fg">{test.text}</span>}
        {test.kind === "fail" && <span className="text-2xs font-medium text-danger-fg">{test.text}</span>}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runTest()}
          disabled={test.kind === "running" || saving}
        >
          {test.kind === "running" ? <Spinner size={12} className="mr-1.5" label="测试中" /> : null}
          测试
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onRequestClose} disabled={saving}>取消</Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner size={12} className="mr-1.5" label="保存中" /> : null}
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
