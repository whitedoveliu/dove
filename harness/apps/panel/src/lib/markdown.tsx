/** 轻量 Markdown 渲染（零依赖）：代码块 / 标题 / 列表 / 引用 / 行内样式 */
import type { ReactNode } from "react";

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "para"; text: string };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) { body.push(lines[i]); i++; }
      i++;
      blocks.push({ kind: "code", lang: fence[2].trim(), text: body.join("\n") });
      continue;
    }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) { blocks.push({ kind: "heading", level: head[1].length, text: head[2] }); i++; continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { blocks.push({ kind: "hr" }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (i < lines.length) {
        const b = lines[i].match(/^\s*([-*+])\s+(.*)$/);
        const n = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        if (ordered && n) { items.push(n[1]); i++; continue; }
        if (!ordered && b) { items.push(b[2]); i++; continue; }
        if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1] += " " + lines[i].trim();
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "para", text: para.join("\n") });
  }
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;

/** 行内样式：行内代码 / 加粗 / 斜体 / 链接 */
export function Inline({ text }: { text: string }): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(<code key={key++} className="rounded-sm bg-raised px-1 py-px font-mono text-[12px] text-think">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key++} className="font-semibold text-fg">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[")) {
      const link = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      nodes.push(
        <a key={key++} href={link ? link[2] : "#"} target="_blank" rel="noreferrer" className="text-accent underline decoration-accent/40 hover:decoration-accent">{link ? link[1] : tok}</a>,
      );
    } else {
      nodes.push(<em key={key++} className="text-fg-dim">{tok.slice(1, -1)}</em>);
    }
    last = at + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

const HEAD_SIZE = ["text-[15px]", "text-[14px]", "text-[13px]", "text-[12px]", "text-[12px]", "text-[12px]"];

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={"space-y-2 " + (className ?? "")}>
      {blocks.map((b, i) => {
        if (b.kind === "code") {
          return (
            <pre key={i} className="overflow-x-auto rounded-md border border-line bg-inset p-2 font-mono text-[12px] leading-[1.5] text-fg">
              {b.lang ? <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-mute">{b.lang}</div> : null}
              <code>{b.text}</code>
            </pre>
          );
        }
        if (b.kind === "heading") {
          const size = HEAD_SIZE[Math.min(b.level, 6) - 1];
          return (
            <div key={i} className={"font-semibold text-fg " + size}>
              <span className="mr-1 text-fg-mute">{"#".repeat(b.level)}</span>
              <Inline text={b.text} />
            </div>
          );
        }
        if (b.kind === "list") {
          return (
            <ul key={i} className="space-y-1">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-2">
                  <span className="select-none text-fg-mute">{b.ordered ? String(j + 1) + "." : "•"}</span>
                  <span className="min-w-0 flex-1"><Inline text={it} /></span>
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === "quote") {
          return (
            <blockquote key={i} className="border-l-2 border-line-soft pl-3 text-fg-dim">
              <Inline text={b.text} />
            </blockquote>
          );
        }
        if (b.kind === "hr") return <hr key={i} className="border-line" />;
        return (
          <p key={i} className="whitespace-pre-wrap break-words">
            <Inline text={b.text} />
          </p>
        );
      })}
    </div>
  );
}
