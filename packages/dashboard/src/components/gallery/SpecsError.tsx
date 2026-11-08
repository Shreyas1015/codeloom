import { MapStateError } from "@/api/client";
import { Command } from "@/components/gallery/CopyCommand";
import { cn } from "@/lib/utils";

/** A spec query's error, as a local card where the specs would be: never a full-screen state. A broken
 * specs.json (409 bad-data) says how to check it; anything else says what codeloom said. */
export function SpecsError({ error, className }: { error: Error; className?: string }) {
  const bad = error instanceof MapStateError && error.code === "bad-data";
  return (
    <div role="alert" className={cn("flex max-w-[64ch] flex-col items-start gap-2.5 rounded-xl border border-dashed border-destructive bg-card px-4.5 py-4", className)}>
      <p className="text-[14px] font-semibold text-destructive">{bad ? "The spec links file can't be read" : "Spec links didn't load"}</p>
      {bad ? (
        <>
          <p className="text-[13px] text-muted-foreground">
            codeloom leaves <span className="font-mono text-[12px]">.codeloom/specs.json</span> as it is. Check it with:
          </p>
          <Command text="codeloom doctor" />
        </>
      ) : null}
      {error.message ? (
        <p className="max-w-full rounded-lg bg-muted px-3 py-2 text-[12.5px] break-words text-muted-foreground">
          <span className="font-semibold text-foreground">codeloom said: </span>
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
