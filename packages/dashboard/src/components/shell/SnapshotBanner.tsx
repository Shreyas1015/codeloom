import { Camera } from "lucide-react";
import type { SnapshotInfo } from "@/api/static";

/** Permanent context for a hosted PR snapshot, above every screen: which PR, which commit, and that
 * nothing here can be changed. Ochre wash (the project's one notice tone), but — unlike StateBanners —
 * never dismissed: it is not a transient notice about this page, it is what this page *is*. */
export function SnapshotBanner({ snapshot }: { snapshot: SnapshotInfo }) {
  const sha = snapshot.head.slice(0, 7);
  // "vs main" (the --base the user passed), never the 40-character merge-base SHA; an older snapshot with
  // no baseRef falls back to that SHA's short form.
  const base = snapshot.baseRef ?? snapshot.base.slice(0, 7);
  return (
    <div
      role="status"
      aria-label="Read-only snapshot"
      className="flex items-center gap-2.5 rounded-xl border border-ring bg-accent-soft px-4 py-2.5 text-[13.5px] text-accent-foreground"
    >
      <Camera aria-hidden className="size-4 shrink-0" />
      <p>
        {snapshot.pr !== undefined ? `Snapshot of PR #${snapshot.pr}` : "Snapshot"} · commit <code className="font-mono text-[12.5px]">{sha}</code> vs{" "}
        {base} · read-only
      </p>
    </div>
  );
}
