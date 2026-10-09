/** 预览面板：GET /api/preview/:projectId → iframe；可触发 POST /api/build */
import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Spinner, cn } from "./ui/Primitives.tsx";
import { api } from "../lib/api.ts";
import type { PreviewInfo, Project } from "../types.ts";

type Status = "idle" | "loading" | "ready" | "error";

/** 相对地址补成同源绝对地址 */
function resolveUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("/")) return window.location.origin + url;
  if (/^https?:\/\//i.test(url)) return url;
  return "http://" + url;
}

export interface PreviewPaneProps {
  project: Project | null;
  onBuild: (projectId: string) => Promise<unknown>;
}

export function PreviewPane({ project, onBuild }: PreviewPaneProps) {
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    if (!project) {
      setInfo(null);
      setStatus("idle");
      return;
    }
    let alive = true;
    setStatus("loading");
    setError(null);
    api
      .preview(project.id)
      .then((res) => {
        if (!alive) return;
        setInfo(res);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setInfo(null);
        setStatus("error");
        setError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [project, nonce]);

  const build = useCallback(async () => {
    if (!project || building) return;
    setBuilding(true);
    setError(null);
    try {
      await onBuild(project.id);
      setNonce((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    } finally {
      setBuilding(false);
    }
  }, [project, building, onBuild]);

  if (!project) {
    return <Empty>先在左侧选择或新建一个项目，这里会显示它的预览。</Empty>;
  }

  const url = info ? resolveUrl(info.url) : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-mute" title={url}>
          {url || (status === "loading" ? "获取预览地址…" : "无预览地址")}
        </span>
        {info?.port ? <span className="font-mono text-[10px] text-fg-mute">:{info.port}</span> : null}
        <Button size="xs" variant="subtle" onClick={() => setNonce((n) => n + 1)} title="重新获取并刷新 iframe">
          刷新
        </Button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-fg-dim hover:bg-white/5 hover:text-fg"
          >
            打开
          </a>
        ) : null}
      </div>

      <div className={cn("relative min-h-0 flex-1 bg-inset")}>
        {status === "ready" && url ? (
          <iframe
            key={nonce}
            src={url}
            title="项目预览"
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            {status === "loading" ? <Spinner /> : null}
            <p className="text-[12px] leading-relaxed text-fg-mute">
              {status === "loading"
                ? "正在获取预览地址…"
                : error
                  ? "预览不可用：" + error
                  : "还没有预览，先触发一次构建。"}
            </p>
            <Button variant="primary" size="md" onClick={build} disabled={building}>
              {building ? "构建中…" : "触发构建"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
