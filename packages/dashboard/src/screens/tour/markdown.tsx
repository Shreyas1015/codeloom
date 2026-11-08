import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A small, safe Markdown subset for agent-written text (tour explanations, view notes): paragraphs, `-`/`*`
 * and `1.` lists, fenced code, inline `code`, **bold** and *italics*; with `headings`, `#` headings; with
 * `links`, `[text](url)` links to in-app paths (`/…`) or http(s) only. Everything else, HTML included, is
 * plain text: React escapes it, and nothing is ever set as HTML. */

type Block =
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "h"; depth: number; text: string };

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

function blocks(text: string, headings: boolean): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = headings ? HEADING.exec(line) : null;
    if (heading) {
      flush();
      out.push({ kind: "h", depth: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const last = out[out.length - 1];
      const item = (bullet ?? numbered)![1]!;
      if (last && last.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line.trim());
  }
  flush();
  return out;
}

/** A link target that is safe to follow: an in-app path (`/map`, not `//host`) or http(s). Anything else
 * (javascript:, data:, relative paths) is not a link. */
export function safeHref(url: string): { href: string; external: boolean } | undefined {
  if (/^\/(?!\/)/.test(url)) return { href: url, external: false };
  if (/^https?:\/\/[^\s/]/i.test(url)) return { href: url, external: true };
  return undefined;
}

const LINK_CLS = "font-semibold text-primary underline underline-offset-3 outline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring";

/** Inline: `code` first (its content stays literal), then links (when allowed), **bold** and *italics*. */
function inline(text: string, links: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined)
      out.push(
        <code key={k++} className="rounded-[4px] bg-muted px-1.25 py-px font-mono text-[0.85em]">
          {m[1]}
        </code>,
      );
    else if (m[2] !== undefined) {
      const target = links ? safeHref(m[3]!) : undefined;
      if (!target) out.push(m[0]);
      else
        out.push(
          <a key={k++} href={target.href} className={LINK_CLS} {...(target.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {m[2]}
          </a>,
        );
    } else if (m[4] !== undefined) out.push(<strong key={k++}>{m[4]}</strong>);
    else out.push(<em key={k++}>{m[5]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_CLS = ["text-xl font-bold tracking-[-0.02em]", "text-[15px] font-bold", "text-[14px] font-semibold"];

export function Markdown({
  text,
  className,
  headings,
  links = false,
}: {
  text: string;
  className?: string;
  /** Render `#` headings, `#` as this HTML level (2–6; deeper `##` go one level down each, capped at h6). */
  headings?: 2 | 3 | 4 | 5 | 6;
  /** Render `[text](url)` links (in-app paths and http(s) only). */
  links?: boolean;
}) {
  const inl = (t: string) => inline(t, links);
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {blocks(text, headings !== undefined).map((b, i) =>
        b.kind === "h" ? (
          (() => {
            const H = `h${Math.min(headings! + b.depth - 1, 6)}` as "h2";
            return (
              <H key={i} className={cn("text-foreground", HEADING_CLS[Math.min(b.depth - 1, 2)], i > 0 && "mt-1")}>
                {inl(b.text)}
              </H>
            );
          })()
        ) : b.kind === "p" ? (
          <p key={i}>{inl(b.text)}</p>
        ) : b.kind === "code" ? (
          <pre key={i} tabIndex={0} className="overflow-x-auto rounded-lg border border-secondary bg-background px-3 py-2.5 font-mono text-xs leading-[1.65] outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring">
            {b.text}
          </pre>
        ) : b.kind === "ul" ? (
          <ul key={i} className="flex list-disc flex-col gap-1 pl-5">
            {b.items.map((t, j) => (
              <li key={j}>{inl(t)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="flex list-decimal flex-col gap-1 pl-5">
            {b.items.map((t, j) => (
              <li key={j}>{inl(t)}</li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}
