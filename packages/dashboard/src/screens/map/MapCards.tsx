/** The three kinds of card on the Map canvas: a folder (group card), a file (lists its functions when open)
 * and the "+ N more files" card. They render inside React Flow nodes. */
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { ChevronDown, ChevronRight, FileCode2, Folder } from "lucide-react";
import { type KeyboardEvent, useMemo } from "react";
import type { GraphFile, GraphFolder, Lane } from "@/api/types";
import { StopRoundel } from "@/components/gallery/StopRoundel";
import { cn } from "@/lib/utils";
import { type MapStop, functionStops } from "./layout";

/** How the active overlay paints a card: a journey stop, dimmed (not on the journey), or plain. */
export type CardOverlay = "stop" | "dim" | "none";

interface CardCommon {
  overlay: CardOverlay;
  /** Set when the layer overlay is on. */
  lane?: Lane;
  stops: MapStop[];
  selected: boolean;
  width: number;
  /** A button in the card got focus (the canvas pans to it when it is off screen). */
  onFocusCard?: (id: string) => void;
}

export interface FolderCardData extends CardCommon {
  [key: string]: unknown;
  kind: "folder";
  folder: GraphFolder;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
}

export interface FileCardData extends CardCommon {
  [key: string]: unknown;
  kind: "file";
  file: GraphFile;
  expanded: boolean;
  selectedRef?: string;
  onToggle: (file: GraphFile) => void;
  onSelectFunction: (ref: string) => void;
}

export interface MoreCardData {
  [key: string]: unknown;
  kind: "more";
  label: string;
  width: number;
}

const LANE_CARD: Record<Lane, string> = {
  ui: "border-lane-ui bg-lane-ui-soft",
  api: "border-lane-api bg-lane-api-soft",
  code: "border-lane-code bg-lane-code-soft",
  db: "border-lane-db bg-lane-db-soft",
  queue: "border-lane-queue bg-lane-queue-soft",
};
const LANE_INK: Record<Lane, string> = {
  ui: "text-lane-ui",
  api: "text-lane-api",
  code: "text-lane-code",
  db: "text-lane-db",
  queue: "text-lane-db",
};

const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring";

function cardFrame({ overlay, lane, selected }: Pick<CardCommon, "overlay" | "lane" | "selected">) {
  return cn(
    "relative rounded-xl border-[1.5px] transition-[opacity,box-shadow,border-color] duration-150 motion-reduce:transition-none",
    lane ? LANE_CARD[lane] : "border-border bg-card",
    overlay === "stop" && "border-[#C99A2E] shadow-[0_1px_2px_rgb(26_29_28_/_0.08),0_0_0_3px_rgb(227_167_47_/_0.35)]",
    // dim the frame and the icons, never the text: it keeps its full contrast
    overlay === "dim" && "border-border/40 bg-card/50 [&_svg]:opacity-40",
    selected && "border-ring shadow-[0_2px_6px_rgb(26_29_28_/_0.10),0_0_0_3px_rgb(227_167_47_/_0.45)]",
  );
}

/** At most four roundels in a row, then a quiet "+n". */
function Roundels({ stops }: { stops: MapStop[] }) {
  if (stops.length === 0) return null;
  const shown = stops.slice(0, 4);
  return (
    <span className="flex flex-none items-center gap-1">
      {shown.map((s) => (
        <StopRoundel key={s.n} n={s.n} label={s.symbol} size="sm" />
      ))}
      {stops.length > shown.length && (
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">+{stops.length - shown.length}</span>
      )}
    </span>
  );
}

const hidden = "!pointer-events-none !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0";
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
    </>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function FolderCard({ data }: NodeProps & { data: FolderCardData }) {
  const { folder, lane, stops } = data;
  const label = `${folder.name}/ folder, ${plural(folder.files, "file")}${folder.layer ? `, layer ${folder.layer}` : ""}`;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      data.onOpen(folder.path);
    }
  };
  return (
    <div
      data-card="folder"
      data-overlay={data.overlay}
      data-lane={lane}
      className={cardFrame(data)}
      style={{ width: data.width }}
      onFocus={() => data.onFocusCard?.(folder.path)}
    >
      <Handles />
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          aria-label={label}
          aria-pressed={data.selected}
          title="Double-click or press Enter to open"
          onClick={() => data.onSelect(folder.path)}
          onDoubleClick={() => data.onOpen(folder.path)}
          onKeyDown={onKeyDown}
          className={cn("flex min-w-0 flex-1 cursor-pointer flex-col gap-1 rounded-md text-left", focusRing)}
        >
          <span className={cn("flex items-center gap-1.5 text-[13px] leading-tight font-bold", lane ? LANE_INK[lane] : "text-foreground")}>
            <Folder aria-hidden className="size-3.5 flex-none" strokeWidth={2} />
            <span className="truncate">{folder.name}/</span>
          </span>
          <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="font-mono tabular-nums">{plural(folder.files, "file")}</span>
            {folder.layer && <span className="truncate">· {folder.layer}</span>}
          </span>
        </button>
        <Roundels stops={stops} />
      </div>
    </div>
  );
}

export function FileCard({ data }: NodeProps & { data: FileCardData }) {
  const { file, lane, stops, expanded } = data;
  const fnCount = file.functions.length;
  const label = [
    file.name,
    plural(fnCount, "function"),
    file.journeys.length ? `in ${plural(file.journeys.length, "journey")}` : "",
    file.layer ? `layer ${file.layer}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const byFunction = useMemo(() => functionStops(file.functions, stops), [file.functions, stops]);
  return (
    <div
      data-card="file"
      data-overlay={data.overlay}
      data-lane={lane}
      className={cn(cardFrame(data), "rounded-lg border")}
      style={{ width: data.width }}
      onFocus={() => data.onFocusCard?.(file.path)}
    >
      <Handles />
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          aria-label={label}
          aria-expanded={expanded}
          aria-pressed={data.selected}
          onClick={() => data.onToggle(file)}
          className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left", focusRing)}
        >
          {expanded ? (
            <ChevronDown aria-hidden className="size-3.5 flex-none text-muted-foreground" />
          ) : (
            <ChevronRight aria-hidden className="size-3.5 flex-none text-muted-foreground" />
          )}
          <FileCode2 aria-hidden className={cn("size-3.5 flex-none", lane ? LANE_INK[lane] : "text-muted-foreground")} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-[12.5px] text-foreground">{file.name}</span>
            <span className="text-[11.5px] text-muted-foreground">
              {fnCount === 0 ? "no functions" : plural(fnCount, "function")}
              {file.journeys.length > 0 && ` · ${plural(file.journeys.length, "journey")}`}
            </span>
          </span>
        </button>
        {!expanded && <Roundels stops={stops} />}
      </div>
      {expanded && (
        <ul aria-label={`Functions in ${file.name}`} className="flex flex-col gap-0.5 border-t border-border/80 px-2 py-1.5">
          {fnCount === 0 && <li className="px-1.5 py-1 text-[12px] text-muted-foreground">No functions or classes found.</li>}
          {file.functions.map((fn) => {
            const fnStops = byFunction.get(fn.ref) ?? [];
            const sel = data.selectedRef === fn.ref;
            return (
              <li key={fn.ref} className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={`${fn.name}()${fn.line !== undefined ? `, line ${fn.line}` : ""}`}
                  aria-pressed={sel}
                  onClick={() => data.onSelectFunction(fn.ref)}
                  className={cn(
                    "flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 py-0.5 text-left font-mono text-[12px] hover:bg-muted",
                    sel && "bg-accent-soft",
                    focusRing,
                  )}
                >
                  <span className="truncate">
                    {fn.type === "class" ? "class " : ""}
                    {fn.name}
                    {fn.type === "function" ? "()" : ""}
                  </span>
                  {fn.line !== undefined && <span className="text-muted-foreground tabular-nums">:{fn.line}</span>}
                </button>
                <Roundels stops={fnStops} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function MoreCard({ data }: NodeProps & { data: MoreCardData }) {
  return (
    <div
      data-card="more"
      className="flex flex-col gap-0.5 rounded-lg border border-dashed border-muted-foreground/50 bg-background px-3 py-2"
      style={{ width: data.width }}
    >
      <Handles />
      <span className="font-mono text-[12.5px] text-foreground tabular-nums">{data.label}</span>
      <span className="text-[11.5px] text-muted-foreground">Search to find one.</span>
    </div>
  );
}

export const nodeTypes = { folder: FolderCard, file: FileCard, more: MoreCard };
