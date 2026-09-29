import type { ReactNode } from "react";

// A small, safe renderer for the light markdown the assistant writes:
// headings, bullet / numbered lists, paragraphs, **bold**, *italic*, `code`,
// [links](url) and bare URLs. Renders to React nodes — no HTML injection.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>)]+)|(\*[^*\n]+\*)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const tok = m[0];
    if (m[1]) out.push(<code key={k++} className="rounded bg-fill px-1 py-0.5 text-[0.9em]">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) {
      const mm = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)!;
      out.push(<a key={k++} href={mm[2]} target="_blank" rel="noreferrer" className="text-accent underline">{mm[1]}</a>);
    } else if (m[4]) {
      const trimmed = tok.replace(/[.,;:!?]+$/, "");
      out.push(<a key={k++} href={trimmed} target="_blank" rel="noreferrer" className="break-all text-accent underline">{trimmed}</a>);
      if (trimmed.length < tok.length) out.push(tok.slice(trimmed.length));
    } else if (m[5]) out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = i + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { kind: "h"; level: number; text: string } | { kind: "ul" | "ol"; items: string[] } | { kind: "p"; lines: string[] };

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const raw of src.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ kind: "h", level: h[1].length, text: h[2] });
    } else if (ul) {
      if (cur?.kind !== "ul") {
        flush();
        cur = { kind: "ul", items: [] };
      }
      (cur as { items: string[] }).items.push(ul[1]);
    } else if (ol) {
      if (cur?.kind !== "ol") {
        flush();
        cur = { kind: "ol", items: [] };
      }
      (cur as { items: string[] }).items.push(ol[1]);
    } else {
      if (cur?.kind !== "p") {
        flush();
        cur = { kind: "p", lines: [] };
      }
      (cur as { lines: string[] }).lines.push(line.trim());
    }
  }
  flush();
  return blocks;
}

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks = parse(text);
  return (
    <div className={`space-y-2 ${className}`}>
      {blocks.map((b, i) => {
        if (b.kind === "h") {
          const cls = b.level <= 2 ? "text-base font-bold" : "text-sm font-bold";
          return (
            <div key={i} className={cls}>
              {inline(b.text)}
            </div>
          );
        }
        if (b.kind === "ul" || b.kind === "ol") {
          const Tag = b.kind;
          return (
            <Tag key={i} className={`space-y-0.5 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"}`}>
              {b.items.map((it, j) => (
                <li key={j}>{inline(it)}</li>
              ))}
            </Tag>
          );
        }
        const lines = (b as { lines: string[] }).lines;
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
