import { useEffect, useState } from "react";
import { useCode } from "@/api/queries";
import type { SnapshotInfo } from "@/api/static";
import type { ReviewNodeChange, ReviewStop } from "@/api/types";
import { CodeBlock } from "@/components/code/CodeBlock";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { DiffView } from "./diff";

export type ReviewLaneStop = ReviewStop & { n: number };

const quiet = "text-[13px] text-muted-foreground";

/** A stop's number, ink-filled by default and ochre-filled only when changed — on Review, ochre means
 * "changed" and nothing else (review-maps-constraints.md), unlike the Journey/Map `StopRoundel`'s "this is
 * a numbered stop" ochre (its Honest Roundel Rule), so this screen gets its own small numeral instead. */
export function StopNum({ n, changed, size = "md" }: { n: number; changed: boolean; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      data-changed={changed ? "true" : "false"}
      className={cn(
        "inline-grid flex-none place-items-center rounded-full font-mono font-bold tabular-nums select-none",
        size === "sm" ? "size-4.5 text-[9.5px]" : "size-5 text-[11px]",
        changed ? "bg-accent text-accent-foreground" : "bg-foreground text-background",
      )}
    >
      {n}
    </span>
  );
}

/** sha256("<repo-relative file path>") as lowercase hex, for the "Comment on GitHub" anchor
 * (`#diff-<hex>`, the same id GitHub puts on that file's block in the PR's Files changed tab). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function githubPath(repoPath: string, file: string): string {
  const base = repoPath.replace(/^\.\/?$/, "").replace(/^\/+|\/+$/g, "");
  return base ? `${base}/${file}` : file;
}

/** The "Comment on GitHub" href, or `undefined` while it hashes or when the snapshot carries no `pr` /
 * `repoSlug` (review-maps-design §7: the link is hidden rather than built on a guess). */
function useGithubHref(snapshot: SnapshotInfo | null, repoPath: string | undefined, file: string | undefined): string | undefined {
  const [href, setHref] = useState<string | undefined>(undefined);
  const pr = snapshot?.pr;
  const repoSlug = snapshot?.repoSlug;
  useEffect(() => {
    setHref(undefined);
    if (pr === undefined || !repoSlug || !repoPath || !file) return;
    let live = true;
    void sha256Hex(githubPath(repoPath, file)).then((hex) => {
      if (live) setHref(`https://github.com/${repoSlug}/pull/${pr}/files#diff-${hex}`);
    });
    return () => {
      live = false;
    };
  }, [pr, repoSlug, repoPath, file]);
  return href;
}

/** "+4 −1 lines inside this function.", plus "Also on journey X, Y." for this node's other journeys. */
function changeSummary(node: ReviewNodeChange, currentJourneyId: string, journeyNameById: Map<string, string>): { counts: string; rest: string } {
  const others = node.journeys.filter((id) => id !== currentJourneyId).map((id) => journeyNameById.get(id)).filter((n): n is string => !!n);
  const rest = `lines inside this function.${others.length > 0 ? ` Also on journey ${others.join(", ")}.` : ""}`;
  return { counts: `+${node.added} −${node.removed}`, rest };
}

export interface ReviewCodePanelProps {
  stop: ReviewLaneStop;
  /** The matching entry of `review.nodes`, when this stop's ref is a changed function. */
  node?: ReviewNodeChange;
  journeyId: string;
  journeyNameById: Map<string, string>;
  /** The git-root-relative folder the stop's repo lives in (`/api/overview` repos[].path), for the GitHub link. */
  repoPath?: string;
  snapshot: SnapshotInfo | null;
}

/** The right-hand panel of "This PR" (spec §7): a stop's diff (default for a changed stop), its code at
 * head, or its code at base — whichever tab is open. Unchanged stops with no diff data get only "Code now",
 * read live from the snapshot's stored whole file (review-maps-constraints.md's code size cap still applies). */
export function ReviewCodePanel({ stop, node, journeyId, journeyNameById, repoPath, snapshot }: ReviewCodePanelProps) {
  const file = node?.file ?? stop.file;
  const [tab, setTab] = useState(node && stop.changed ? "change" : "now");
  // Only an unchanged stop with no node entry needs a live fetch; a changed node's code already travelled
  // inside review.json (before/after), and a stop with no file (db/queue) has nothing to fetch.
  const code = useCode(!node ? stop.repo : undefined, !node ? stop.file : undefined);
  const href = useGithubHref(snapshot, repoPath, file);

  const lines = node?.after ?? node?.before;
  const lineRange = lines ? `${lines.start}–${lines.end}` : code.data ? `${code.data.startLine}–${code.data.endLine}` : undefined;

  const tabs: Array<{ value: string; label: string }> = node
    ? [
        { value: "change", label: "Change" },
        { value: "now", label: "Code now" },
        { value: "before", label: "Code before" },
      ]
    : stop.file
      ? [{ value: "now", label: "Code now" }]
      : [];

  const summary = node && stop.changed ? changeSummary(node, journeyId, journeyNameById) : undefined;

  return (
    <aside aria-label="Code panel" className="flex min-w-0 flex-col gap-3 self-start overflow-hidden rounded-xl border border-border bg-card p-4 lg:sticky lg:top-0">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="flex items-center gap-2 text-[15px] leading-snug font-bold break-words">
            <StopNum n={stop.n} changed={stop.changed} size="sm" />
            {stop.label}
          </h2>
          {file && (
            <p className="font-mono text-[11.5px] text-muted-foreground">
              {file}
              {lineRange ? ` · lines ${lineRange}` : ""}
            </p>
          )}
        </div>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[12px] font-semibold text-primary underline-offset-3 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Comment on GitHub ↗
          </a>
        )}
      </header>

      {summary && (
        <p className="rounded-lg border border-ring bg-accent-soft px-3 py-2 text-[12.5px] text-accent-foreground">
          ✏️ Changed in this PR: <b className="font-bold">{summary.counts}</b> {summary.rest}
        </p>
      )}

      {tabs.length === 0 ? (
        <p className={quiet}>No code for this stop.</p>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="gap-3">
          <TabsList variant="line" className="h-auto w-full justify-start gap-3 border-b border-border p-0 pb-2">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="flex-none px-0 text-[13px]">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {node && (
            <TabsContent value="change">
              <DiffView hunks={node.hunks} file={file} />
            </TabsContent>
          )}
          <TabsContent value="now">
            {node ? (
              node.after ? (
                <CodeBlock code={node.after.text} startLine={node.after.start} file={file} />
              ) : (
                <p className={quiet}>Deleted in this PR.</p>
              )
            ) : code.data ? (
              <CodeBlock code={code.data.text} startLine={code.data.startLine} file={file} />
            ) : code.error ? (
              <p role="alert" className="text-[13px] text-destructive">
                {code.error.message}
              </p>
            ) : (
              <p className={quiet}>Loading code…</p>
            )}
          </TabsContent>
          {node && (
            <TabsContent value="before">
              {node.before ? <CodeBlock code={node.before.text} startLine={node.before.start} file={file} /> : <p className={quiet}>New in this PR.</p>}
            </TabsContent>
          )}
        </Tabs>
      )}

      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        <span>
          <span aria-hidden className="mr-1 inline-block size-2.5 rounded-[2px] border border-diff-add-ink bg-diff-add align-[-1px]" />
          added
        </span>
        <span>
          <span aria-hidden className="mr-1 inline-block size-2.5 rounded-[2px] border border-diff-delete-ink bg-diff-delete align-[-1px]" />
          removed
        </span>
      </p>
    </aside>
  );
}
