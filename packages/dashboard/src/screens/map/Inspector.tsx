/** The Map's right-hand panel: what the selected file or function is, where it sits, which journeys pass
 * through it and what it touches one hop away. */
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useNeighbors, useNode } from "@/api/queries";
import type { GraphFile, GraphFolder, Neighbor } from "@/api/types";
import { cn } from "@/lib/utils";
import { fileOfRef } from "./layout";

export interface InspectorProps {
  repo: string;
  /** Selected file or function ref. */
  selectedRef?: string;
  /** The level's file that is, or holds, the selected ref (gives the function list with lines). */
  file?: GraphFile;
  folder?: GraphFolder;
  onOpenFolder: (path: string) => void;
  onJump: (ref: string) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border/70 px-4.5 py-3.5 last:border-b-0">
      <h3 className="text-[12px] font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

const chip = "inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-[11.5px] text-muted-foreground";

export function Inspector(props: InspectorProps) {
  return (
    <aside aria-label="Inspector" className="flex min-h-0 flex-col overflow-y-auto border-l border-border bg-card">
      {props.selectedRef ? (
        <NodeDetails {...props} selectedRef={props.selectedRef} />
      ) : props.folder ? (
        <FolderDetails folder={props.folder} repo={props.repo} onOpen={props.onOpenFolder} />
      ) : (
        <p className="px-4.5 py-4 text-[13px] text-muted-foreground">
          Select a file to see its functions, journeys and neighbors. Double-click a folder to open it.
        </p>
      )}
    </aside>
  );
}

function FolderDetails({ folder, repo, onOpen }: { folder: GraphFolder; repo: string; onOpen: (path: string) => void }) {
  return (
    <>
      <header className="flex flex-col gap-1 border-b border-border/70 px-4.5 py-4">
        <h2 className="text-[16px] leading-tight font-bold">{folder.name}/</h2>
        <p className="font-mono text-[12px] break-all text-muted-foreground">
          {repo}/{folder.path}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className={chip}>{plural(folder.files, "file")}</span>
          {folder.layer && <span className={chip}>layer {folder.layer}</span>}
        </div>
      </header>
      <div className="px-4.5 py-3.5">
        <button
          type="button"
          onClick={() => onOpen(folder.path)}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90"
        >
          <FolderOpen aria-hidden className="size-4" />
          Open folder
        </button>
      </div>
    </>
  );
}

function NodeDetails({ repo, selectedRef, file, onJump }: InspectorProps & { selectedRef: string }) {
  const node = useNode(selectedRef);
  const near = useNeighbors(selectedRef, 1, "both");

  if (node.isPending) return <p role="status" className="px-4.5 py-4 text-[13px] text-muted-foreground">Loading…</p>;
  if (node.isError)
    return (
      <p role="alert" className="px-4.5 py-4 text-[13px] text-destructive">
        {node.error.message}
      </p>
    );

  const { node: info, summary, journeys } = node.data;
  const path = info.filePath ?? fileOfRef(selectedRef);
  const isFile = info.type === "file";
  const functions = isFile ? (file?.functions ?? []) : [];

  return (
    <>
      <header className="flex flex-col gap-1 border-b border-border/70 px-4.5 py-4">
        <h2 className="font-mono text-[15px] leading-tight font-semibold break-all">
          {info.name}
          {info.type === "function" ? "()" : ""}
        </h2>
        {path && <p className="font-mono text-[12px] break-all text-muted-foreground">{`${repo}/${path}`}</p>}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {!isFile && <span className={chip}>{info.type}</span>}
          {info.layer && <span className={chip}>layer {info.layer}</span>}
          {info.lineRange && (
            <span className={cn(chip, "font-mono tabular-nums")}>
              lines {info.lineRange[0]}–{info.lineRange[1]}
            </span>
          )}
        </div>
      </header>

      {summary && (
        <Section title="Summary">
          <p className="text-[13.5px] leading-snug">{summary}</p>
        </Section>
      )}

      {isFile && (
        <Section title={functions.length ? `Functions · ${functions.length}` : "Functions"}>
          {functions.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No functions or classes found.</p>
          ) : (
            <ul aria-label="Functions" className="flex flex-col gap-1">
              {functions.map((fn) => (
                <li key={fn.ref} className="flex justify-between gap-3 font-mono text-[12.5px]">
                  <span className="truncate">
                    {fn.name}
                    {fn.type === "function" ? "()" : ""}
                  </span>
                  {fn.line !== undefined && <span className="text-muted-foreground tabular-nums">:{fn.line}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title={journeys.length ? `In ${plural(journeys.length, "journey")}` : "Not in a journey yet"}>
        {journeys.length > 0 && (
          <ul className="flex flex-col gap-1">
            {journeys.map((j) => (
              <li key={j.id}>
                <Link
                  to="/journeys/$id"
                  params={{ id: j.id }}
                  className="text-[13.5px] font-semibold text-primary underline-offset-3 hover:underline"
                >
                  {j.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Neighbors">
        {near.isPending ? (
          <p className="text-[13px] text-muted-foreground">Loading…</p>
        ) : near.isError ? (
          <p className="text-[13px] text-destructive">{near.error.message}</p>
        ) : near.data.neighbors.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing imports or calls it, and it uses nothing mapped.</p>
        ) : (
          <ul aria-label="Neighbors" className="flex flex-col gap-0.5">
            {near.data.neighbors.map((n) => (
              <NeighborRow key={`${n.ref}|${n.via.type}|${n.via.direction}`} n={n} onJump={onJump} />
            ))}
            {near.data.truncated && <li className="pt-1 text-[12px] text-muted-foreground">More not shown.</li>}
          </ul>
        )}
      </Section>
    </>
  );
}

function NeighborRow({ n, onJump }: { n: Neighbor; onJump: (ref: string) => void }) {
  const Arrow = n.via.direction === "out" ? ArrowRight : ArrowLeft;
  const how = n.via.direction === "out" ? n.via.type : `${n.via.type} it`;
  const body = (
    <>
      <Arrow aria-hidden className="size-3.5 flex-none text-muted-foreground" />
      <span className="truncate font-mono text-[12.5px]">{n.name}</span>
      <span className="ml-auto flex-none text-[11.5px] text-muted-foreground">{how}</span>
    </>
  );
  const jumpable = fileOfRef(n.ref) !== undefined;
  return (
    <li>
      {jumpable ? (
        <button
          type="button"
          onClick={() => onJump(n.ref)}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-1 py-0.5">{body}</div>
      )}
    </li>
  );
}
