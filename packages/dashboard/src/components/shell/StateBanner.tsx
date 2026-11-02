import { FileWarning, FolderSearch, GitCommitHorizontal, KeyRound, Plug, ScanSearch, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { MapStateError, SessionError } from "@/api/client";
import type { Overview } from "@/api/types";
import { Command } from "@/components/gallery/CopyCommand";
import { Button } from "@/components/ui/button";

/** An error that makes the whole map unusable: the session is gone, or the map is not indexed / has no
 * workspace / has a bad file. Everything else stays a local message on its screen. */
export type BlockingError = SessionError | MapStateError;

export function isBlocking(err: unknown): err is BlockingError {
  return err instanceof SessionError || err instanceof MapStateError;
}

// ---- full-screen states -------------------------------------------------------------------------

interface StateCopy {
  icon: ReactNode;
  title: string;
  body: ReactNode;
  command: string;
  after?: ReactNode;
  /** The server's own message, shown as the detail. */
  detail?: string;
  error?: boolean;
}

const ICON = "size-5";

function copyFor(err: BlockingError): StateCopy {
  if (err instanceof SessionError) {
    return {
      icon: <KeyRound aria-hidden className={ICON} />,
      title: "Your session expired",
      body: "Reopen the dashboard from your terminal. The server restarted or was stopped, so this tab's link no longer works.",
      command: "codeloom dashboard",
      error: true,
    };
  }
  if (err.code === "no-workspace") {
    return {
      icon: <FolderSearch aria-hidden className={ICON} />,
      title: "No codeloom workspace here",
      body: "Run this in the folder that holds your repos. It writes the workspace file and connects your agent.",
      command: "codeloom init",
      detail: err.message,
    };
  }
  if (err.code === "bad-data") {
    return {
      icon: <FileWarning aria-hidden className={ICON} />,
      title: "codeloom can't read its map",
      body: "A file under .codeloom is damaged or was edited by hand. This checks every file and says how to fix it:",
      command: "codeloom doctor",
      detail: err.message,
      error: true,
    };
  }
  return {
    icon: <ScanSearch aria-hidden className={ICON} />,
    title: "This code isn't mapped yet",
    body: "Run this in your terminal, in the workspace folder:",
    command: "codeloom index",
    after: "This page updates by itself when indexing finishes.",
    detail: err.message,
  };
}

/** The full-screen state for a blocking error: what happened, the one command that fixes it, and the
 * server's own words. Not dismissible: there is nothing to show behind it. */
export function MapStateScreen({ error }: { error: BlockingError }) {
  const c = copyFor(error);
  const id = useId();
  return (
    <section aria-labelledby={id} data-state={error instanceof SessionError ? "session-expired" : error.code} className="flex max-w-[64ch] flex-col items-start gap-4 py-6">
      <span
        aria-hidden
        className={
          c.error
            ? "grid size-10 place-items-center rounded-xl bg-destructive-soft text-destructive"
            : "grid size-10 place-items-center rounded-xl bg-lane-api-soft text-primary"
        }
      >
        {c.icon}
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 id={id} className="text-[28px] leading-[1.15] font-bold tracking-[-0.03em] text-balance">
          {c.title}
        </h1>
        <p className="text-[14px] text-muted-foreground text-pretty">{c.body}</p>
      </div>
      <div className="flex items-center rounded-xl border border-border bg-card py-2 pr-2 pl-3">
        <span aria-hidden className="mr-2 font-mono text-[12.5px] text-muted-foreground select-none">
          $
        </span>
        <Command text={c.command} />
      </div>
      {c.after && <p className="text-[13.5px] text-foreground">{c.after}</p>}
      {c.detail && (
        <p className="max-w-full rounded-lg bg-muted px-3 py-2 text-[12.5px] break-words text-muted-foreground">
          <span className="font-semibold text-foreground">codeloom said: </span>
          {c.detail}
        </p>
      )}
    </section>
  );
}

/** A screen's own query error: the shared full state when it is blocking, else a plain alert. */
export function ScreenError({ error, fallback = "Something went wrong loading this screen." }: { error: Error; fallback?: string }) {
  if (isBlocking(error)) return <MapStateScreen error={error} />;
  return (
    <p role="alert" className="max-w-[70ch] rounded-xl border border-destructive/40 bg-destructive-soft px-5 py-4 text-[13.5px] text-foreground">
      {error.message || fallback}
    </p>
  );
}

// ---- banners ------------------------------------------------------------------------------------

const DISMISSED = "codeloom:dismissed:";

function readDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(DISMISSED + key) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(key: string): void {
  try {
    sessionStorage.setItem(DISMISSED + key, "1");
  } catch {
    /* storage blocked: dismissed for this page view only */
  }
}

/** Dismissed banners for this tab's session (sessionStorage, plus memory when storage is blocked). */
function useDismissed() {
  const [local, setLocal] = useState<ReadonlySet<string>>(new Set());
  return {
    has: (key: string) => local.has(key) || readDismissed(key),
    dismiss: (key: string) => {
      writeDismissed(key);
      setLocal((s) => new Set(s).add(key));
    },
  };
}

function Banner({ title, icon, onDismiss, children }: { title: string; icon: ReactNode; onDismiss: () => void; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex items-start gap-3 rounded-xl border border-border bg-card py-2.5 pr-2 pl-4 text-[13.5px]">
      <span aria-hidden className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onDismiss} aria-label={`Dismiss: ${title}`} className="shrink-0 text-muted-foreground">
        <X aria-hidden />
      </Button>
    </section>
  );
}

const SHOW_FILES = 3;

function StaleBanner({ overview, onDismiss }: { overview: Overview; onDismiss: () => void }) {
  const repos = overview.indexStatus.repos.filter((r) => r.stale);
  const files = repos.flatMap((r) => r.changedFiles.map((f) => `${r.id}/${f}`));
  const more = files.length - SHOW_FILES;
  const truncated = repos.some((r) => r.truncated);
  return (
    <Banner title="Map is behind your code" icon={<GitCommitHorizontal />} onDismiss={onDismiss}>
      <p className="leading-7">
        <b className="font-semibold">Map is behind your code</b> — run <Command text="codeloom index" />
      </p>
      {files.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px] text-muted-foreground">
          <span>Changed since the last index:</span>
          <ul aria-label="Changed files" className="contents">
            {files.slice(0, SHOW_FILES).map((f) => (
              <li key={f} className="font-mono text-foreground">
                {f}
              </li>
            ))}
          </ul>
          {(more > 0 || truncated) && <span>{truncated ? "and more" : `and ${more} more`}</span>}
        </div>
      )}
    </Banner>
  );
}

function AgentBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Banner title="Agent not connected" icon={<Plug />} onDismiss={onDismiss}>
      <p className="leading-7">
        Add codeloom to your agent: <Command text="codeloom init" /> adds it to <code className="font-mono text-[12.5px]">.mcp.json</code>
      </p>
    </Banner>
  );
}

/** Quiet banners above every screen, from /api/overview: the index is older than HEAD, the agent is not
 * set up. Each can be dismissed for the session; the stale one comes back when the code moves again. */
export function StateBanners({ overview }: { overview: Overview }) {
  const dismissed = useDismissed();
  const staleRepos = overview.indexStatus.repos.filter((r) => r.stale);
  // keyed by what is stale, so a new commit after a dismiss shows the banner again
  const staleKey = `${overview.name}:stale:${staleRepos.map((r) => `${r.id}@${r.head}`).join(",")}`;
  const agentKey = `${overview.name}:agent`;
  const showStale = staleRepos.length > 0 && !dismissed.has(staleKey);
  const showAgent = !overview.mcpConnected && !dismissed.has(agentKey);
  if (!showStale && !showAgent) return null;
  return (
    <div className="flex flex-col gap-2">
      {showStale && <StaleBanner overview={overview} onDismiss={() => dismissed.dismiss(staleKey)} />}
      {showAgent && <AgentBanner onDismiss={() => dismissed.dismiss(agentKey)} />}
    </div>
  );
}
