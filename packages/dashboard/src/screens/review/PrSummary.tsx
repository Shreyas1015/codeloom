import { AlertTriangle, CircleCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { PrSummary, SummaryCode, SummaryRisk, SummaryWhere, SummaryWrite } from "@/api/types";

// The top of This PR: what the PR does, in the order a reviewer reads it (0.5 spec §2–§3) — the status line, What it
// does, Where it matters, What it writes, Before deploying, Code to check, Notes. Every string here is from the PR
// (codeloom's detected facts) or from Claude, so it is only ever rendered as React text: never HTML, never markdown.

const ENTRY_WORD: Record<string, string> = { page: "page", route: "route", consumer: "queue consumer" };
const RISK_WORD: Record<string, string> = { migration: "Migration", schema: "Schema", env: "Env", docker: "Docker", ci: "CI" };

const list = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);
const joinNotes = (notes: string[] | undefined): string => list(notes).filter((n) => typeof n === "string").join("; ");

/** "2026-11-16" from an ISO timestamp; "" when it is not one. */
function checkedOn(at: unknown): string {
  return typeof at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(at) ? at.slice(0, 10) : "";
}

const muted = "text-muted-foreground";
const mono = "font-mono text-[12.5px] break-all";

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-[15px] font-bold tracking-[-0.01em]">{title}</h3>
      {children}
    </div>
  );
}

function More({ n }: { n: number }) {
  return n > 0 ? <li className={muted}>+{n} more</li> : null;
}

function ClaudeNote({ notes, added }: { notes: string[]; added?: boolean }) {
  const text = joinNotes(notes);
  if (added) return <span className={muted}>{text ? `added by Claude: ${text}` : "added by Claude"}</span>;
  return text ? <span className={muted}>Claude: {text}</span> : null;
}

function WhereItem({ w }: { w: SummaryWhere }) {
  if (w.kind === undefined) {
    return (
      <li>
        <code className={mono}>{w.name}</code>
        {w.why ? ` — ${w.why}` : ""}
      </li>
    );
  }
  return (
    <li>
      {w.journey ? (
        <>
          <b className="font-bold">{w.journey}</b> —{" "}
        </>
      ) : null}
      {ENTRY_WORD[w.kind] ?? "entry"} <code className={mono}>{w.name}</code>
      {w.repo ? <span className={muted}> ({w.repo})</span> : null}
    </li>
  );
}

function WriteItem({ w }: { w: SummaryWrite }) {
  return (
    <li>
      <code className={mono}>{w.name}</code> <ClaudeNote notes={w.notes} added={!w.detected} />
    </li>
  );
}

function RiskItem({ r }: { r: SummaryRisk }) {
  if (!r.detected) {
    return (
      <li>
        Claude: {r.file ? <code className={mono}>{r.file}</code> : null}
        {r.file ? " — " : ""}
        {joinNotes(r.notes)}
      </li>
    );
  }
  const notes = joinNotes(r.notes);
  return (
    <li>
      {(r.kind && RISK_WORD[r.kind]) ?? "Check"}: <code className={mono}>{r.file}</code>
      {r.detail ? ` — ${r.detail}` : ""}
      {notes ? ` — Claude: ${notes}` : ""}
    </li>
  );
}

function CodeItem({ c, onOpen }: { c: SummaryCode; onOpen?: (ref: string) => void }) {
  const ref = c.ref;
  const name =
    ref && onOpen ? (
      <button
        type="button"
        onClick={() => onOpen(ref)}
        className="font-mono text-[12.5px] font-semibold break-all text-primary underline-offset-3 outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {c.name}
      </button>
    ) : (
      <code className={mono}>{c.name}</code>
    );
  if (!c.detected) {
    return (
      <li className="flex flex-col gap-0.5">
        <span>
          {name} <ClaudeNote notes={c.notes} added />
        </span>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {name}
        {/* ochre wash = changed, as on the lanes */}
        <span className="inline-flex w-fit items-center rounded-[4px] bg-accent-soft px-1.75 py-px text-[11.5px] font-semibold whitespace-nowrap text-accent-foreground">
          {c.change ?? "changed"}, +{count(c.added)} −{count(c.removed)}
        </span>
        {c.file ? <span className={`${mono} ${muted}`}>{c.file}</span> : null}
      </span>
      <ClaudeNote notes={c.notes} />
    </li>
  );
}

/** The PR summary section. `onOpenCode` opens a changed function's diff in the page's code panel. */
export function PrSummarySection({ summary, onOpenCode }: { summary: PrSummary; onOpenCode: (ref: string) => void }) {
  const checked = summary.status === "checked";
  const more = summary.more ?? { whereItMatters: 0, writes: 0, readsOnly: 0, beforeDeploying: 0, beforeDeployingAdded: 0, codeToCheck: 0, codeToCheckAdded: 0 };
  const where = list(summary.whereItMatters);
  const writes = list(summary.writes);
  const reads = list(summary.readsOnly);
  const further = list(summary.furtherAlong).filter((x) => x && typeof x.repo === "string" && Array.isArray(x.names));
  const risks = list(summary.beforeDeploying);
  const detectedRisks = risks.filter((r) => r.detected);
  const addedRisks = risks.filter((r) => !r.detected);
  const code = list(summary.codeToCheck);
  const detectedCode = code.filter((c) => c.detected);
  const addedCode = code.filter((c) => !c.detected);
  const notes = list(summary.notes).filter((n) => typeof n === "string");
  const on = checkedOn(summary.checkedAt);

  return (
    <section aria-labelledby="pr-summary-title" className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-[13.5px]">
      <div className="flex flex-col gap-1">
        <h2 id="pr-summary-title" className="text-xl font-bold tracking-[-0.02em]">
          What this PR does
        </h2>
        {checked ? (
          <p className="flex items-center gap-1.5 text-[12.5px] text-success">
            <CircleCheck aria-hidden className="size-3.5 flex-none" />
            <span>{on ? `Checked by Claude ${on}` : "Checked by Claude"}</span>
          </p>
        ) : (
          <p className={`text-[12.5px] ${muted}`}>
            Draft by codeloom — not checked. Run <code className="font-mono text-[12px]">codeloom pr --check</code> to let Claude explain this PR.
          </p>
        )}
      </div>

      {checked && summary.whatItDoes ? <p className="max-w-[72ch] text-[15px] leading-relaxed">{summary.whatItDoes}</p> : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Sub title="Where it matters">
          {where.length === 0 ? (
            <p className={muted}>No entry point on the map reaches the changed code.</p>
          ) : (
            <ul aria-label="Where it matters" className="flex flex-col gap-1">
              {where.map((w, i) => (
                <WhereItem key={i} w={w} />
              ))}
              <More n={count(more.whereItMatters)} />
            </ul>
          )}
        </Sub>

        <Sub title="What it writes">
          {writes.length === 0 ? (
            <p className={muted}>{further.length > 0 && summary.repoId ? `Nothing in ${summary.repoId}.` : "Nothing on the map."}</p>
          ) : (
            <ul aria-label="What it writes" className="flex flex-col gap-1">
              {writes.map((w, i) => (
                <WriteItem key={i} w={w} />
              ))}
              <More n={count(more.writes)} />
            </ul>
          )}
          {further.length > 0 ? (
            <p className={muted}>
              Further along (other services):{" "}
              {further.map((x, i) => (
                <span key={x.repo}>
                  {i > 0 ? "; " : ""}
                  {x.repo}:{" "}
                  {x.names.map((n, k) => (
                    <span key={k}>
                      {k > 0 ? ", " : ""}
                      <code className={mono}>{n}</code>
                    </span>
                  ))}
                </span>
              ))}
            </p>
          ) : null}
          {reads.length > 0 ? (
            <p className={muted}>
              Reads only:{" "}
              {reads.map((r, i) => (
                <span key={i}>
                  {i > 0 ? ", " : ""}
                  <code className={mono}>{r}</code>
                </span>
              ))}
              {count(more.readsOnly) > 0 ? `, +${count(more.readsOnly)} more` : ""}
            </p>
          ) : null}
        </Sub>
      </div>

      {risks.length > 0 ? (
        // the calm warning style of a trap ("Remember this"): ochre wash, alert icon, ochre ink — never ochre fill
        <div role="note" aria-label="Before deploying" className="flex gap-3 rounded-[10px] bg-accent-soft px-3.5 py-3 text-accent-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 size-4.5 flex-none" />
          <div className="flex min-w-0 flex-col gap-1">
            <b className="font-bold">Before deploying</b>
            <ul className="flex flex-col gap-1">
              {detectedRisks.map((r, i) => (
                <RiskItem key={`d${i}`} r={r} />
              ))}
              <More n={count(more.beforeDeploying)} />
              {addedRisks.map((r, i) => (
                <RiskItem key={`a${i}`} r={r} />
              ))}
              <More n={count(more.beforeDeployingAdded)} />
            </ul>
          </div>
        </div>
      ) : null}

      <Sub title="Code to check">
        {detectedCode.length === 0 ? <p className={muted}>No changed function on the map.</p> : null}
        {code.length > 0 ? (
          <ul aria-label="Code to check" className="flex flex-col gap-1.5">
            {detectedCode.map((c, i) => (
              <CodeItem key={`d${i}`} c={c} onOpen={onOpenCode} />
            ))}
            <More n={count(more.codeToCheck)} />
            {addedCode.map((c, i) => (
              <CodeItem key={`a${i}`} c={c} />
            ))}
            <More n={count(more.codeToCheckAdded)} />
          </ul>
        ) : null}
      </Sub>

      {notes.length > 0 ? (
        <Sub title="Notes">
          {notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </Sub>
      ) : null}
    </section>
  );
}
