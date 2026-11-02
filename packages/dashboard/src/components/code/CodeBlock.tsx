import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { CodeLang, Token } from "./highlighter";

export type BlockLang = CodeLang | "text";

const EXT: Record<string, CodeLang> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  sql: "sql",
  json: "json",
};

/** File path → one of the bundled languages, else plain text. */
export function langForFile(file: string): BlockLang {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  return (ext && EXT[ext]) || "text";
}

export interface CodeBlockProps {
  code: string;
  /** Number of the first line in `code`. Default 1. */
  startLine?: number;
  /** Inclusive line range to mark, in file line numbers. */
  highlight?: { from: number; to: number };
  lang?: BlockLang;
  /** Used for the label and, when `lang` is not given, to pick the language. */
  file?: string;
  className?: string;
}

/** Code with line numbers and a highlighted range. Shows plain text at once; Shiki colours arrive from a lazy chunk. */
export function CodeBlock({ code, startLine = 1, highlight, lang, file, className }: CodeBlockProps) {
  const resolved: BlockLang = lang ?? (file ? langForFile(file) : "text");
  const [tokens, setTokens] = useState<{ code: string; lang: BlockLang; lines: Token[][] } | null>(null);

  useEffect(() => {
    if (resolved === "text") return;
    let live = true;
    import("./highlighter")
      .then((m) => m.highlightLines(code, resolved))
      .then((lines) => {
        if (live) setTokens({ code, lang: resolved, lines });
      })
      .catch(() => {
        /* colours are an enhancement: plain text stays */
      });
    return () => {
      live = false;
    };
  }, [code, resolved]);

  const coloured = tokens && tokens.code === code && tokens.lang === resolved ? tokens.lines : null;
  const plain = code.split("\n");
  const endLine = startLine + plain.length - 1;
  const label = `${file ?? "Code"}, lines ${startLine}–${endLine}`;
  const width = String(endLine).length;

  return (
    <section aria-label={label} data-slot="code-block" data-lang={resolved} data-highlighted={coloured ? "true" : "false"} className={cn("min-w-0", className)}>
      <pre
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-secondary bg-background py-2.5 font-mono text-xs leading-[1.65] text-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <code className="block min-w-max">
          {plain.map((text, i) => {
            const n = startLine + i;
            const on = highlight !== undefined && n >= highlight.from && n <= highlight.to;
            return (
              <span
                key={n}
                data-line={n}
                data-highlighted={on ? "" : undefined}
                className={cn("flex pr-3", on && "bg-accent-soft shadow-[inset_3px_0_0_var(--accent)]")}
              >
                <span
                  data-slot="line-number"
                  aria-hidden="true"
                  className={cn("flex-none pr-3 pl-3 text-right tabular-nums select-none", on ? "text-accent-foreground" : "text-muted-foreground")}
                  style={{ minWidth: `calc(${width}ch + 1.5rem)` }}
                >
                  {n}
                </span>
                <span data-slot="line-code" className="whitespace-pre">
                  {coloured?.[i]
                    ? coloured[i]!.map((t, j) => (
                        <span key={j} data-token="" style={{ color: t.color, fontStyle: t.italic ? "italic" : undefined, fontWeight: t.bold ? 600 : undefined }}>
                          {t.content}
                        </span>
                      ))
                    : text}
                </span>
              </span>
            );
          })}
        </code>
      </pre>
    </section>
  );
}
