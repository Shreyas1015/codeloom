import type { ReviewHunk } from "@/api/types";
import { cn } from "@/lib/utils";

/** One rendered line of a diff: context (unchanged), an addition or a deletion, with whichever of its old
 * (base) and new (head) line numbers apply. */
export interface DiffLine {
  type: "context" | "add" | "del";
  oldLine?: number;
  newLine?: number;
  text: string;
}

/** `ReviewHunk.lines` flattened across every hunk, tracking the old and new line numbers as it walks each
 * hunk's own leading " " / "+" / "-" markers (review/types.ts ReviewHunk). */
export function diffLines(hunks: ReviewHunk[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === "+") {
        out.push({ type: "add", newLine, text });
        newLine++;
      } else if (marker === "-") {
        out.push({ type: "del", oldLine, text });
        oldLine++;
      } else {
        out.push({ type: "context", oldLine, newLine, text });
        oldLine++;
        newLine++;
      }
    }
  }
  return out;
}

/** The diff tab's body: added lines in `<ins>` (role "insertion"), removed in `<del>` (role "deletion"),
 * both on the design's diff washes; context lines plain. Both line-number gutters (old | new) line up with
 * `CodeBlock`'s single gutter so Change and Code now/before read as the same code. */
export function DiffView({ hunks, file }: { hunks: ReviewHunk[]; file?: string }) {
  const lines = diffLines(hunks);
  const width = Math.max(2, ...lines.map((l) => String(l.oldLine ?? l.newLine ?? "").length));
  return (
    <section aria-label={file ? `${file}, diff` : "Diff"} data-slot="diff-view">
      <pre
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-secondary bg-background py-2.5 font-mono text-xs leading-[1.65] text-foreground"
      >
        <code className="block min-w-max">
          {lines.map((l, i) => {
            const Tag = l.type === "add" ? "ins" : l.type === "del" ? "del" : "div";
            return (
              <Tag
                key={i}
                data-line-type={l.type}
                className={cn(
                  "flex pr-3 no-underline",
                  l.type === "add" && "bg-diff-add text-diff-add-ink",
                  l.type === "del" && "bg-diff-delete text-diff-delete-ink",
                )}
              >
                <span aria-hidden="true" className="flex-none pr-2 pl-3 text-right tabular-nums text-muted-foreground select-none" style={{ minWidth: `calc(${width}ch + 0.75rem)` }}>
                  {l.oldLine ?? ""}
                </span>
                <span aria-hidden="true" className="flex-none pr-3 text-right tabular-nums text-muted-foreground select-none" style={{ minWidth: `calc(${width}ch + 0.75rem)` }}>
                  {l.newLine ?? ""}
                </span>
                <span aria-hidden="true" className="w-4 flex-none text-center select-none">
                  {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
                </span>
                <span className="whitespace-pre">{l.text}</span>
              </Tag>
            );
          })}
        </code>
      </pre>
    </section>
  );
}
