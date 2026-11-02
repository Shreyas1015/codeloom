/** Search box for the Map: files, functions and classes of the current repo. Picking a hit jumps to it. */
import { Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { useSearch } from "@/api/queries";
import type { SearchHit, SearchKind } from "@/api/types";
import { cn } from "@/lib/utils";

const KINDS: SearchKind[] = ["file", "function", "class"];

export function MapSearch({ repo, onPick }: { repo: string; onPick: (hit: SearchHit) => void }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  // a short pause before asking, so each keystroke does not fetch
  useEffect(() => {
    const t = setTimeout(() => setQ(text), 150);
    return () => clearTimeout(t);
  }, [text]);

  const result = useSearch(q, KINDS, repo);
  const hits = q.trim() && text.trim() ? (result.data?.results ?? []).slice(0, 12) : [];
  const open = hits.length > 0 || (q.trim() !== "" && text.trim() !== "" && result.isSuccess);

  const pick = (hit: SearchHit) => {
    setText("");
    setQ("");
    onPick(hit);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && hits.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === "ArrowUp" && hits.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      pick(hits[active]);
    } else if (e.key === "Escape") {
      setText("");
    }
  };

  return (
    <div className="relative w-64">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        aria-label="Search this repo"
        placeholder="Find a file or function"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && hits[active] ? `${listId}-${active}` : undefined}
        className="h-8 w-full rounded-md border border-border bg-card pr-2.5 pl-8 text-[13px] placeholder:text-muted-foreground focus-visible:border-ring"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="absolute top-9 right-0 left-0 z-20 flex max-h-80 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-[0_6px_20px_rgb(26_29_28_/_0.12)]"
        >
          {hits.length === 0 && <li className="px-2 py-1.5 text-[13px] text-muted-foreground">No matches in {repo}.</li>}
          {hits.map((hit, i) => (
            <li
              key={hit.ref}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(hit)}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5",
                i === active ? "bg-accent-soft" : "hover:bg-muted",
              )}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-[12.5px]">{hit.name}</span>
                <span className="flex-none text-[11px] text-muted-foreground">{hit.kind}</span>
              </span>
              {hit.file && (
                <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                  {hit.file}
                  {hit.line !== undefined ? `:${hit.line}` : ""}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
