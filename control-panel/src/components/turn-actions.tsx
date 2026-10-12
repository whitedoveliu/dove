"use client";

import { useState } from "react";
import { Check, Copy, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { formatTokens, totalTokens, usageEntries } from "@/lib/models";
import { getVersionList, switchVersion, type Message, type VersionInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 会话末端的消息操作行 —— 只挂在**最后一条 assistant 消息**下面
 * （参考 DSH / Claude 的操作行：左边一排小图标按钮，右边淡色元信息）。
 *
 * 两个动作：
 *   复制  该消息正文，失败静默（只在 toast 里说一声，不弹 alert）
 *   回滚  回到**上一轮之前**的快照：取版本列表的 versions[1]（versions[0] 是最新，
 *         就是这一轮的快照）。会丢弃最后一轮的文件改动，但 git 里仍可找回 ——
 *         所以必须过二次确认。
 *
 * ⚠️ 版本列表的取值规则和右侧「版本历史」面板完全一致（getVersionList /
 *    switchVersion），不要自己按消息序号推版本号：那个编号早就被证明会错位
 *    （见 MessageList.tsx 里那段「版本条已删除」的注释）。
 */
export interface TurnActionsProps {
  /** 该消息的正文（复制用） */
  content: string;
  /** 当前项目（回滚用）；拿不到就只显示复制 */
  projectId?: string | null;
  /** 这一轮的 token 用量（有就显示，没有就不显示 —— 不额外发请求） */
  usage?: Message["usage"];
  timestamp: Date;
  /** 有回合在跑 / 正在切版本 → 回滚禁用（和 PreviewPanel 的守卫一致） */
  disabled?: boolean;
  /** 回滚成功后的回调（ChatPanel 在这里刷新历史 + 预览） */
  onRolledBack?: () => void;
  className?: string;
}

export function TurnActions({
  content, projectId, usage, timestamp, disabled, onRolledBack, className,
}: TurnActionsProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 取过版本列表、确认没有更早的版本 → 按钮从此禁用（title 说明原因） */
  const [noEarlier, setNoEarlier] = useState(false);
  const [target, setTarget] = useState<VersionInfo | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 失败静默：非安全上下文 / 没给剪贴板权限时 writeText 会 reject。
      // 不弹 alert 打断阅读，只在 toast 里说清楚。
      toast({ title: "复制失败", description: "浏览器没有给剪贴板权限", tone: "danger" });
    }
  };

  /**
   * 先取版本列表再开确认框：versions.length <= 1 时**没有更早的版本**，
   * 这时不该弹一个确认了也没用的框 —— 直接把按钮置为禁用（title 说明）。
   * 列表拿不到（网络 / 404）就 toast 报错，不动按钮状态（下次点击还能重试）。
   */
  const openRollback = async () => {
    if (!projectId) {
      toast({ title: "回滚不可用", description: "还不知道当前项目", tone: "warning" });
      return;
    }
    setChecking(true);
    try {
      const r = await getVersionList(projectId, 30);
      const list = r.versions ?? [];
      if (list.length <= 1) {
        setNoEarlier(true);
        toast({ title: "没有更早的版本可回", description: `当前只有 ${list.length} 个版本快照`, tone: "info" });
        return;
      }
      setTarget(list[1] ?? null);
      setConfirmOpen(true);
    } catch (e) {
      toast({ title: "读取版本列表失败", description: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally {
      setChecking(false);
    }
  };

  const doRollback = async () => {
    if (!projectId || !target) return;
    setRolling(true);
    try {
      const r = await switchVersion(target.commit_hash, projectId);
      // 老契约层把失败也包在 200 里（{success:false}），所以必须看 success
      if (!r.success) {
        toast({ title: "回滚失败", description: r.message, tone: "danger" });
        return;
      }
      setConfirmOpen(false);
      toast({
        title: "已回滚到上一轮之前",
        description: r.message || `已恢复到版本 ${target.version_number}`,
        tone: "success",
      });
      onRolledBack?.();
    } catch (e) {
      toast({ title: "回滚失败", description: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally {
      setRolling(false);
    }
  };

  // 元信息：token 用量（本轮 stats 里拿，没有就不显示）+ 时间。
  const tokens = totalTokens(usageEntries(usage));
  const meta = [tokens > 0 ? `${formatTokens(tokens)} tokens` : null, timestamp.toLocaleTimeString()]
    .filter(Boolean)
    .join(" · ");

  const busy = checking || rolling;
  const rollbackDisabled = disabled || busy || noEarlier || !projectId;
  const rollbackTitle = noEarlier
    ? "没有更早的版本可回"
    : !projectId
      ? "还不知道当前项目"
      : disabled
        ? "回合进行中，先停一下再回滚"
        : "回滚到上一轮之前（会先确认）";

  return (
    <div className={cn("mt-1 flex w-full max-w-[92%] items-center gap-0.5", className)}>
      <IconButton
        size="xs"
        aria-label="复制正文"
        title={content.trim() ? "复制正文" : "没有可复制的正文"}
        disabled={!content.trim()}
        onClick={copy}
        className="opacity-60 hover:opacity-100"
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </IconButton>

      <IconButton
        size="xs"
        aria-label="回滚到上一轮之前"
        title={rollbackTitle}
        disabled={rollbackDisabled}
        onClick={openRollback}
        className="opacity-60 hover:opacity-100"
      >
        {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
      </IconButton>

      <span className="ml-1 min-w-0 flex-1 truncate text-right font-mono text-2xs text-text-tertiary">
        {meta}
      </span>

      {/* 回滚的二次确认：说清代价（丢文件改动）与退路（git 还在） */}
      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!o && !rolling) setConfirmOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>回滚到上一轮之前？</DialogTitle>
            <DialogDescription className="space-y-2 pt-2 text-xs leading-relaxed">
              <span className="block">
                会丢弃最后一轮的文件改动；git 里仍可找回 —— 右侧「版本历史」随时能切回来。
              </span>
              {target && (
                <span className="block text-text-tertiary">
                  目标快照：版本 {target.version_number}
                  {target.summary ? ` · ${target.summary}` : ""}
                  {target.timestamp ? ` · ${target.timestamp}` : ""}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)} disabled={rolling}>
              取消
            </Button>
            <Button variant="destructive" size="sm" loading={rolling} loadingText="回滚中…" onClick={doRollback}>
              确认回滚
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
