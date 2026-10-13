import * as React from "react";
import { Settings2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { getModelSettings, saveModelSettings, testModelSettings } from "@/lib/api";
import { modelChoices, modelDisplay } from "@/lib/models";

/**
 * 模型设置对话框 —— 输入框左下角那颗齿轮点开的就是它。
 *
 * 三件事：API key / base URL / 模型。值**存内核**（`<DOVE_CONFIG>/model.json`，0600），
 * 不是 localStorage —— 这几个值决定内核往哪儿发请求，放浏览器里意味着
 * 「换台机器打开面板，key 就没了」。
 *
 * ⚠️ key 的纪律（这里的代码全都围着它转）：
 *   · **从不把整把 key 渲染进 DOM** —— 已设置时输入框是空的，掩码只出现在 placeholder
 *     和下面那行提示里（sk-…c32b）；
 *   · 用户不填 = 不改（保存时整个字段不发，内核保留原来那把）；
 *   · env 里已经配了 key 的，这里显示的就是它（hasKey / keyMasked），不静默覆盖。
 *
 * 模型那一栏和输入框右下角的 chip **共用同一份状态**（props 传进来的 model / onModelChange），
 * 不另存一份草稿 —— 两处都能选模型，两份状态的下场就是显示不一致。
 */
export interface ModelSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前模型（与 chip 同一份状态） */
  model: string;
  /** 选了别的模型 → 交给调用方持久化（和 chip 走同一条路） */
  onModelChange: (id: string) => void;
}

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; text: string }
  | { kind: "fail"; text: string };

export function ModelSettingsDialog({ open, onOpenChange, model, onModelChange }: ModelSettingsDialogProps) {
  const { toast } = useToast();
  const [baseUrl, setBaseUrl] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");     // 空串 = 不改（永远不回填原 key）
  const [hasKey, setHasKey] = React.useState(false);
  const [keyMasked, setKeyMasked] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [test, setTest] = React.useState<TestState>({ kind: "idle" });

  // 每次打开都重读一遍：别的地方（比如内核被别的东西改了）改过设置时不能显示旧值
  React.useEffect(() => {
    if (!open) return;
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
      })
      .catch((e: unknown) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  /** 测试用**屏幕上这些值**（没保存也算）—— 用户刚敲完 key 就想试，不该逼他先保存 */
  const runTest = async () => {
    setTest({ kind: "running" });
    try {
      const r = await testModelSettings({
        baseUrl: baseUrl.trim() || undefined,
        model,
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
        model,
        apiKey: apiKey.trim() || undefined,   // 空串 → 不发这个字段 → 内核保留原 key
      });
      setApiKey("");
      toast({ title: "设置已保存", description: "内核下一轮就用新的配置" });
      onOpenChange(false);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>模型设置</DialogTitle>
          <DialogDescription className="text-xs">
            API key / 地址 / 模型存在内核里（不是浏览器），保存后下一轮就用，不用重启。
            不填 API Key 就是不改动原来那把。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 py-1">
          {/* ── API Key ─────────────────────────────── */}
          <div className="space-y-1.5">
            <label htmlFor="model-settings-key" className="text-xs font-medium text-text-secondary">API Key</label>
            <Input
              id="model-settings-key"
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
            <label htmlFor="model-settings-baseurl" className="text-xs font-medium text-text-secondary">Base URL</label>
            <Input
              id="model-settings-baseurl"
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
                  onClick={() => { if (id !== model) onModelChange(id); }}
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
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
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
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size={12} className="mr-1.5" label="保存中" /> : null}
              保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 左下角那颗齿轮（「+」菜单旁边）—— 对话框的入口。
 * 和 ComposerPlusMenu 同一档几何（size-8 圆形 + 描边），挨着放才像一组。
 */
export function ModelSettingsButton({ onOpen, disabled }: { onOpen: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label="设置"
      title="模型设置（API Key / Base URL / 模型）"
      onClick={onOpen}
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong text-text-secondary transition-colors duration-fast hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
    >
      <Settings2 className="size-3.5" />
    </button>
  );
}
