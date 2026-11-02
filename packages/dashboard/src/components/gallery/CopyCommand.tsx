import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Copies `text`. Says "Copied" in its name and a polite status; when the clipboard is blocked, asks the
 * viewer to select the text instead (keep that text `select-all` next to the button). */
export function CopyButton({
  text,
  label = "Copy command",
  iconOnly = false,
  className,
}: {
  text: string;
  label?: string;
  /** Just the icon (the name still says "Copy command" / "Copied"), for commands set inside a sentence. */
  iconOnly?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={iconOnly ? "icon-xs" : "xs"}
        onClick={copy}
        aria-label={state === "copied" ? "Copied" : label}
        title={iconOnly ? (state === "copied" ? "Copied" : label) : undefined}
        className={cn("text-muted-foreground hover:text-foreground", className)}
      >
        {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        {!iconOnly && <span aria-hidden>{state === "copied" ? "Copied" : "Copy"}</span>}
      </Button>
      <span role="status" className={cn("text-xs", state === "failed" ? "text-destructive" : "sr-only")}>
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select the text" : ""}
      </span>
    </>
  );
}

/** A terminal command set in mono, selectable in one click, with a copy button. */
export function Command({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-0.5 gap-y-1 align-middle", className)}>
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12.5px] text-foreground select-all">{text}</code>
      <CopyButton text={text} iconOnly />
    </span>
  );
}
