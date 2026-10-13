"use client";

import * as React from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeLanguage, usePrismTheme } from "@/lib/highlight";
import { copyText } from "@/lib/clipboard";
import { openExternal } from "@/lib/links";

/**
 * 正文里的**围栏代码块**。
 *
 * 取舍（逐条对着用户提的「代码格式」）：
 *  - 高亮：react-syntax-highlighter 的 Prism（全量语言，refractor 已在依赖里），
 *    主题跟随浅/深色切换（见 `lib/highlight.ts` 里为什么只能二选一）。
 *  - 语言标签：左上角一枚小字标签，写的是模型自己标的那个名字（标 `ts` 就显示 TS），
 *    不显示归一后的内部名；一个都没标时退成 `TEXT` 占位。
 *  - 复制：右上角按钮。复制的是整块代码原文，不带行号、不带标签。
 *  - 不折行：`wrapLongLines={false}` + 外层 `overflow-x-auto`。折行会破坏
 *    代码的缩进语义（`|` 管道、对齐的注释都会错位），宁可横向滚。
 *  - 最高 24rem，超出内部纵向滚 —— 长代码不该把整条消息顶出去，
 *    面板右侧预览打开时可视高度本来就不多。
 *
 * 底色只留一层：外层容器自己画边框和 `bg-surface-inset`，
 * SyntaxHighlighter 的 `customStyle` 把 `background` 改成透明 ——
 * 否则 `.prose pre` 的底色和容器的底色会叠成两层，边缘发脏。
 * 同理，`<pre>` 那层壳在 markdown-content.tsx 里被替换掉了（见那里的 `pre` 渲染器）。
 */

const FONT_SIZE = "12px";
const PADDING = "0.625rem 0.75rem";

/** 复制按钮：成功后 1.2s 内切成「已复制」，然后自己回去 */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [state, setState] = React.useState<"idle" | "ok" | "fail">("idle");
  const timer = React.useRef<number | null>(null);

  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  /**
   * 失败时**必须说出来**。
   * 静默无反应是这里最糟的结果：用户以为复制好了，粘出来是上一次的内容。
   * 判定顺序与超时兜底都在 `lib/clipboard.ts`（那里也解释了为什么同步路径先跑、
   * 以及 `navigator.clipboard` 的 promise 可能永不 settle）。
   */
  const settle = React.useCallback((ok: boolean) => {
    setState(ok ? "ok" : "fail");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), ok ? 1200 : 2000);
  }, []);

  const copy = React.useCallback(() => {
    void copyText(text).then(settle);
  }, [text, settle]);

  return (
    <button
      type="button"
      onClick={copy}
      title={state === "ok" ? "已复制" : state === "fail" ? "复制失败，请手动选中复制" : "复制代码"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors",
        "hover:bg-surface-hover",
        state === "fail" ? "text-danger-fg" : "text-text-tertiary hover:text-text-primary",
        className,
      )}
    >
      {state === "ok" ? <Check className="size-3" /> : <Copy className="size-3" />}
      {state === "ok" ? "已复制" : state === "fail" ? "复制失败" : "复制"}
    </button>
  );
}

export function CodeBlock({ code, language }: { code: string; language?: string | null }) {
  const theme = usePrismTheme();
  const lang = normalizeLanguage(language);
  // 标签显示模型写的原名（没有就写 text），和上面 `lang` 的归一是两回事
  const label = (language ?? "").trim().split(/[\s:]/)[0]?.toLowerCase() || "text";

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border-subtle bg-surface-inset">
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-2 py-0.5">
        <span className="truncate font-mono text-2xs uppercase tracking-wide text-text-tertiary">
          {label}
        </span>
        <CopyButton text={code} />
      </div>
      <div className="max-h-96 overflow-auto">
        <SyntaxHighlighter
          language={lang ?? "text"}
          style={theme}
          customStyle={{
            margin: 0,
            padding: PADDING,
            background: "transparent",
            // border 也要清：容器自己已经画了边框，不清就是两层边框叠在一起（边缘发黑）
            border: "none",
            fontSize: FONT_SIZE,
            lineHeight: "19px",
          }}
          codeTagProps={{
            style: {
              fontFamily: "var(--font-mono)",
              background: "transparent",
              fontSize: FONT_SIZE,
            },
          }}
          // 长行横向滚动而不是折行 —— 折行会让缩进和 `|` 管道之类失去对齐意义
          wrapLongLines={false}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

/**
 * 正文里的图片（`![alt](url)`）。
 *
 * 取舍：
 *  - 限高 16rem + 限宽，`object-contain` —— 模型随手贴的截图动辄 2000px 高，
 *    不限高会把正文整条推走。
 *  - 懒加载 + `referrerPolicy="no-referrer"`：图是模型给的外链，不是我们托管的，
 *    别把面板的地址当 referer 发出去。
 *  - **加载失败降级成链接**：模型编 URL 是常事，破图图标没有任何信息量，
 *    退成一行可点的 URL 至少还能看出它想指哪儿。
 *  - 不做"加载完再淡入"：那要求加载期间把图藏起来（`opacity-0`），
 *    而 DNS 挂起时 `error` 迟迟不来，结果是**整块空白** —— 比看到 alt 文字更糟。
 *  - 只认 `http(s)`：react-markdown 的默认 `urlTransform` 会把 `data:` 之类的
 *    协议清成空串（`src` 为空就退化成 alt 文字），这里是刻意不放开 ——
 *    模型输出不可信，没必要为极少数 base64 贴图放宽协议。
 */
export function MarkdownImage({
  src,
  alt,
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  const [failed, setFailed] = React.useState(false);

  // 换了 src（消息重渲染 / 流式更新）要把失败状态清掉，否则一张图挂过后永远只剩链接
  React.useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src) return <span className="text-muted-foreground/60">{alt ?? ""}</span>;

  if (failed) {
    return (
      // 降级链接同样走 `openExternal`：宿主 WebView 里没有新窗口回调，
      // 只给 target/rel 的话点了没反应（和正文链接是同一个坑，见 lib/links.ts）
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        title={title ?? src}
        onClick={(event) => openExternal(event, src)}
        className="break-all font-mono text-xs text-text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
      >
        {alt || src}
      </a>
    );
  }

  return (
    <img
      src={src}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="my-1 max-h-64 max-w-full rounded-md border border-border object-contain align-middle"
    />
  );
}
