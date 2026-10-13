import { Fragment, type ReactNode } from "react";

function inlineNodes(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\n]+\*)/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;
    if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) nodes.push(<strong key={key}>{inlineNodes(token.slice(2, -2), key)}</strong>);
    else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link && /^https?:\/\//i.test(link[2])) {
        nodes.push(<a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>);
      } else nodes.push(<span key={key}>{link?.[1] || token}</span>);
    } else if (token.startsWith("*")) nodes.push(<em key={key}>{inlineNodes(token.slice(1, -1), key)}</em>);
    else nodes.push(token);
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderProse(source: string, keyPrefix: string): ReactNode[] {
  const lines = source.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").trim();
    if (text) blocks.push(<p key={`${keyPrefix}-p-${index}`}>{inlineNodes(text, `${keyPrefix}-p-${index}`)}</p>);
    index += 1;
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const ListTag = list.ordered ? "ol" : "ul";
    const items = list.items;
    blocks.push(
      <ListTag key={`${keyPrefix}-l-${index}`}>
        {items.map((item, itemIndex) => <li key={itemIndex}>{inlineNodes(item, `${keyPrefix}-li-${index}-${itemIndex}`)}</li>)}
      </ListTag>,
    );
    index += 1;
    list = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push(<blockquote key={`${keyPrefix}-q-${index}`}>{inlineNodes(quote.join(" "), `${keyPrefix}-q-${index}`)}</blockquote>);
    index += 1;
    quote = [];
  };
  const flush = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={`${keyPrefix}-h-${index}`}>{inlineNodes(heading[2], `${keyPrefix}-h-${index}`)}</Tag>);
      index += 1;
      continue;
    }
    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      const ordered = /\d/.test(listMatch[2]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(listMatch[3]);
      continue;
    }
    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function MarkdownView({ source }: { source: string }) {
  const body = stripFrontmatter(source);
  const parts = body.split(/```/);
  return (
    <div className="md">
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const newline = part.indexOf("\n");
          const code = newline >= 0 ? part.slice(newline + 1) : part;
          return <pre key={index}><code>{code.replace(/\n$/, "")}</code></pre>;
        }
        return <Fragment key={index}>{renderProse(part, `b${index}`)}</Fragment>;
      })}
    </div>
  );
}
