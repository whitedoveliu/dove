"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { cn } from "@/lib/utils";
import { matchPresentedPath, type PresentedFile } from "@/lib/presented-files";
import { openExternal } from "@/lib/links";
import { CodeBlock, MarkdownImage } from "@/components/markdown-code";

/**
 * 消息正文的 markdown 渲染。
 *
 * 原来这段内联在 `MessageList.tsx` 里（那个文件 2000 行）。挪出来是因为
 * 组件的 `components` 表从「code / a / table / blockquote」扩到了十几个 —
 * 挤在消息列表中间已经读不动了，而且这块能脱离会话数据单独渲染验证。
 */

/**
 * 交付物上下文：`Present` 声明过的文件路径 —— 正文里 inline-code 写的同一个路径
 * 也能点开预览（见下面 code 渲染器）。
 * 默认 null：这条消息没有交付物，一切渲染保持原样。
 */
export const PresentedFileContext = React.createContext<{
  files: PresentedFile[];
  open?: (path: string) => void;
} | null>(null);

/* ------------------------------------------------------------------ 链接 */

/**
 * 为什么不做「开不出来就 location.href 跳过去」的兜底：
 * 面板是个 SPA，跳走等于丢掉当前会话的画面（未发送的草稿就在 React state 里，
 * 见 ChatPanel 的 `input`），而外部站点还没有返回入口 —— 那比"点了没反应"更糟。
 * 所以下面**所有**链接都不许退回同文档导航，见 `a` 渲染器里的三种分支。
 */

/* ------------------------------------------------- markdown 组件映射表 */

const components: Components = {
  /**
   * 围栏代码块。
   *
   * 块 / 行内的判定：react-markdown v10 **不再**往 `code` 传 `inline`
   * （v9 起随 `hast-util-to-jsx-runtime` 一起移除了），原来的
   * `!inline && !!match` 实际退化成「只有标了语言才算块」，没写语言的围栏
   * 会被当成行内 code。
   *
   * 判据只有两条：`!!language || raw.endsWith("\n")`。
   *  - **围栏块的 children 恒定以 `\n` 结尾** —— hast 的 code 节点内容就是那几行（含行尾换行），
   *    实测 react-markdown@10.1：无语言的围栏块 children = "const a = 1;\n"；
   *  - **行内 code 永远不以 `\n` 结尾** —— CommonMark 把 code span 里的换行归一成空格，
   *    `raw` 里根本没有 `\n`。
   *
   * 反例（回归现场）：源码里折了行的行内 code，位置横跨两行、`raw` 却是 "a b" 这种形式
   * （实测 `endsWith("\n") === false`）。曾经用「`raw.includes("\n")` 或 node.position 跨行」
   * 当判据，`raw.includes("\n")` 会在**围栏块里只有一行**时漏判（渲染成行内 code），
   * 而 position 跨行会把上面这种行内 code 误判成块 —— 两个方向各错一次。
   * 所以 `node.position` 不参与判定。
   * 这两条可以用一段 SSR 渲染钉住：跨行行内 code 的 HTML 里**不该**出现复制按钮
   * （那是 CodeBlock 的标记），围栏块（有/无语言）的 HTML 里该有。
   */
  code({ node: _node, className, children, ...props }) {
    // 这个 hook 必须**在任何 return 之前**：`code` 是 react-markdown 逐节点渲染的
    // 组件，块/行内两种形态在流式更新时会在同一个实例上切换，晚调用就是
    // "Rendered more hooks than during the previous render"。
    const presented = React.useContext(PresentedFileContext);

    const raw = String(children ?? "");
    const language = /language-([^\s]+)/.exec(className ?? "")?.[1];
    const isBlock = !!language || raw.endsWith("\n");

    if (isBlock) {
      return <CodeBlock code={raw.replace(/\n$/, "")} language={language} />;
    }

    // 正文里写成 inline-code 的交付物路径 → 可点击，点开右侧预览面板。
    // 只认「已在这条消息里被 Present 声明过」的路径，其余 inline-code 原样渲染。
    const text = raw.trim();
    const hit = presented?.open && text ? matchPresentedPath(text, presented.files) : null;
    if (hit) {
      return (
        <button
          type="button"
          title={`预览 ${hit.path}`}
          onClick={() => presented?.open?.(hit.path)}
          className={cn(
            "cursor-pointer rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[0.875em] text-text-primary",
            "underline decoration-dotted underline-offset-2 transition-colors duration-fast hover:bg-surface-hover",
            className,
          )}
        >
          {children}
        </button>
      );
    }
    return (
      <code
        className={cn(
          "rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[0.875em] text-text-primary",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  },

  /**
   * 围栏块外面那层 `<pre>`：直接透传子节点。
   *
   * 不这么做的话会渲染出 `<pre><div>…</div></pre>` —— CodeBlock 自己画边框和底色，
   * 外面再套一层 `.prose pre` 的背景/内边距就是双层底色，且 `div` 放进 `pre`
   * 本身也不符合 HTML 的内容模型。
   */
  pre({ children }) {
    return <>{children}</>;
  },

  /**
   * 链接。三种分支，**任何一种都不许退回同文档导航**：
   *
   *  ① 空 href：不在 safeProtocol 里的协议会被 react-markdown 的默认 urlTransform
   *     清成空串（实测：`javascript:` / `data:` / `file:` 都清；放行的是
   *     `https?` / `ircs?` / `mailto` / `xmpp` 和所有相对形式）。
   *     `href=""` 的含义是「导航到当前 URL」= **整页重载** —— 面板是 SPA，重载等于
   *     换掉整个界面、未发送的草稿（ChatPanel 的 `input` state）一起没，而且回不来。
   *     所以空 href 干脆不渲染 `href`，点击也 preventDefault。
   *  ② 站内锚点（`#xxx`）：交给浏览器自己的滚动行为，不新开窗口。
   *  ③ 其余（http / https / mailto / 相对路径…）：**一律** `target="_blank"`
   *     + `rel="noopener noreferrer"` + `onClick` 兜底（`lib/links.ts` 的 openExternal，
   *     它同时负责 preventDefault）。旧实现（git HEAD 的 MessageList）对**所有**链接
   *     都给 target/rel，只对 `https?://` 加兜底是这次改动引入的回归：像
   *     `[文档](./README.md)` 这种相对链接退化成同文档导航，同样会丢掉草稿。
   *
   * `break-all`：模型给的长 URL（带一串 query / 编码过的中文）会把
   * `min-w-0` 的正文容器撑破，导致整条消息横向溢出。
   */
  a({ href, children, node: _node, ...props }) {
    const url = href ?? "";
    if (!url) {
      return (
        <a
          aria-disabled="true"
          title={undefined}
          onClick={(event: React.MouseEvent<HTMLAnchorElement>) => event.preventDefault()}
          // 点不动就别装成链接（旧实现正是这条 `!url && "cursor-default no-underline"`）
          className="cursor-default break-all text-text-accent no-underline"
          {...props}
        >
          {children}
        </a>
      );
    }
    const isAnchor = url.startsWith("#");
    if (isAnchor) {
      return (
        <a
          href={url}
          title={url}
          className="break-all text-text-accent underline decoration-accent/35 underline-offset-2 transition-colors duration-fast hover:decoration-solid hover:text-accent-hover"
          {...props}
        >
          {children}
        </a>
      );
    }
    return (
      <a
        href={url}
        title={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event: React.MouseEvent<HTMLAnchorElement>) => openExternal(event, url)}
        className={cn(
          "break-all text-text-accent underline decoration-accent/35 underline-offset-2",
          "transition-colors duration-fast hover:decoration-solid hover:text-accent-hover",
        )}
        {...props}
      >
        {children}
      </a>
    );
  },

  /**
   * 图片：内联显示 + 限高，加载失败降级成链接（见 markdown-code.tsx）。
   */
  img({ src, alt, title }) {
    return <MarkdownImage src={src} alt={alt} title={title} />;
  },

  /**
   * GFM 任务列表的勾选框。
   *
   * remark-gfm 生成的就是 `<input type="checkbox" disabled checked>`，
   * 这里只补样式（原生 checkbox 在浅色下是系统蓝，和面板的 accent 打架）
   * 并**显式**声明只读 —— 用户不该在历史消息里点勾。
   */
  input({ type, checked, node, ...props }) {
    if (type !== "checkbox") return <input type={type} {...props} />;
    return (
      <input
        type="checkbox"
        checked={!!checked}
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="mr-1.5 size-3.5 shrink-0 translate-y-[2px] accent-[rgb(var(--accent))]"
        {...props}
      />
    );
  },

  ul({ node, className, children, ...props }) {
    // GFM 给任务列表的 ul 加 `contains-task-list`：去掉圆点，让勾选框自己当符号
    const isTaskList = (className ?? "").split(/\s+/).includes("contains-task-list");
    return (
      <ul
        className={cn(
          "my-2 space-y-1",
          isTaskList ? "list-none pl-1" : "list-disc pl-5",
          className,
        )}
        {...props}
      >
        {children}
      </ul>
    );
  },

  li({ node, className, children, ...props }) {
    // 任务项可能有嵌套列表，`[&>ul]` 那一层不用再缩进
    const isTaskItem = (className ?? "").split(/\s+/).includes("task-list-item");
    return (
      <li className={cn(isTaskItem && "list-none", className)} {...props}>
        {children}
      </li>
    );
  },

  ol({ node, children, ...props }) {
    return (
      <ol className="my-2 list-decimal space-y-1 pl-5" {...props}>
        {children}
      </ol>
    );
  },

  blockquote({ node, children, ...props }) {
    return (
      <blockquote
        // `before/after:content-none` 是**必须的**：@tailwindcss/typography 的
        // `prose` 默认给引用块加一对装饰引号（`blockquote p:first-of-type::before`
        // 的 `content: open-quote`），中文排版下会渲染成 `“…”` 那种弯引号，
        // 而模型输出里的引用**本身就是原文**，再包一层引号是凭空加的东西。
        className={cn(
          "my-2 border-l-4 border-muted-foreground/30 py-2 pl-4 italic text-muted-foreground",
          "before:content-none after:content-none",
          "[&>p:first-of-type]:before:content-none [&>p:last-of-type]:after:content-none",
        )}
        {...props}
      >
        {children}
      </blockquote>
    );
  },

  h1({ node, children, ...props }) {
    return <h1 className="mb-2 mt-4 text-lg font-bold" {...props}>{children}</h1>;
  },
  h2({ node, children, ...props }) {
    return <h2 className="mb-2 mt-3 text-base font-bold" {...props}>{children}</h2>;
  },
  h3({ node, children, ...props }) {
    return <h3 className="mb-1 mt-2 text-sm font-bold" {...props}>{children}</h3>;
  },

  p({ node, children, ...props }) {
    return <p className="my-2" {...props}>{children}</p>;
  },

  /**
   * 表格：外面套一层横向滚动。
   *
   * 右侧预览面板打开时正文只剩一半宽，三列以上的表格必然放不下。
   * 两道保险：
   *  · 外层 `overflow-x-auto` —— 表格比容器宽时横向滚，而不是把正文撑破；
   *  · 每个单元格 `min-w-24`（6rem）—— `table-layout: auto` 默认会把列
   *    压到"能塞下就行"，于是「全部面板」被折成「全部面 / 板」这种三行高。
   *    给列一个下限后，表格宁可超宽去横向滚，也保持每行一个值。
   * **刻意不用 `max-w-full` 让单元格放肆折行**：折行后读不出列对齐关系。
   */
  table({ node, children, ...props }) {
    return (
      <div className="my-2 max-w-full overflow-x-auto">
        <table className="min-w-full border-collapse border border-muted" {...props}>
          {children}
        </table>
      </div>
    );
  },
  th({ node, children, ...props }) {
    return (
      <th className="min-w-24 whitespace-nowrap border border-muted bg-muted/50 px-3 py-2 text-left font-semibold" {...props}>
        {children}
      </th>
    );
  },
  td({ node, children, ...props }) {
    return (
      <td className="min-w-24 border border-muted px-3 py-2 align-top" {...props}>
        {children}
      </td>
    );
  },

  /** 分割线：`.prose hr` 的边框太淡（4% 透明度）时几乎看不见，这里给足对比 */
  hr({ node, ...props }) {
    return <hr className="my-3 border-t border-border-strong" {...props} />;
  },

  /**
   * 原生 HTML（`<details>` / `<summary>` 等）**不支持**：
   * react-markdown 默认把 raw HTML 节点丢掉，要解析得挂 `rehype-raw`。
   * 这里不加 —— 模型输出是不可信输入，`rehype-raw` 会把它变成真的 DOM 节点，
   * XSS 面直接从零变成"靠 React 的转义兜底"，而这条链路上没有任何净化器。
   * 需要折叠内容的话，用 markdown 自己的语法就够了。
   */
};

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none text-sm leading-relaxed dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
