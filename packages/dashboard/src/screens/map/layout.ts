/** Pure helpers for the Map screen: which cards a folder level shows, where they sit, which edges join
 * them, and how a journey's stops land on this repo's files. No React here, so it is easy to test. */
import type { GraphFile, GraphFolder, GraphLevel, JourneyResult, Lane } from "@/api/types";

/** Never more cards than this at one level; the rest collapse into one "+ N more files" card. */
export const MAX_LEVEL_NODES = 150;

export type LevelItem =
  | { kind: "folder"; id: string; layer?: string; folder: GraphFolder }
  | { kind: "file"; id: string; layer?: string; file: GraphFile }
  | { kind: "more"; id: string; layer?: undefined; count: number; label: string };

export const MORE_ID = "__more__";

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The cards of one level: folders first, then files, each by name. Past the cap, the last card says how many
 * more there are. `keep` (a folder or file path) is always shown, so a search hit is never hidden. */
export function levelItems(level: GraphLevel, keep?: string): { items: LevelItem[]; hidden: number } {
  const all: LevelItem[] = [
    ...[...level.folders]
      .sort((a, b) => byName(a.name, b.name) || byName(a.path, b.path))
      .map((folder): LevelItem => ({ kind: "folder", id: folder.path, ...(folder.layer ? { layer: folder.layer } : {}), folder })),
    ...[...level.files]
      .sort((a, b) => byName(a.name, b.name) || byName(a.path, b.path))
      .map((file): LevelItem => ({ kind: "file", id: file.path, ...(file.layer ? { layer: file.layer } : {}), file })),
  ];
  if (all.length <= MAX_LEVEL_NODES) return { items: all, hidden: 0 };

  const room = MAX_LEVEL_NODES - 1;
  let shown = all.slice(0, room);
  const kept = keep !== undefined ? all.find((i) => i.id === keep) : undefined;
  if (kept && !shown.includes(kept)) shown = [...shown.slice(0, room - 1), kept];
  const hiddenItems = all.filter((i) => !shown.includes(i));
  const onlyFiles = hiddenItems.every((i) => i.kind === "file");
  const n = hiddenItems.length;
  const label = `+ ${n.toLocaleString("en-US")} more ${onlyFiles ? (n === 1 ? "file" : "files") : n === 1 ? "item" : "items"}`;
  return { items: [...shown, { kind: "more", id: MORE_ID, count: n, label }], hidden: n };
}

export const CARD_WIDTH = 248;
const COLUMN_GAP = 96;
const ROW_GAP = 18;
const PER_COLUMN = 10;
const FOLDER_HEIGHT = 74;
const FILE_HEIGHT = 58;
const FUNCTION_ROW = 26;

export function itemHeight(item: LevelItem, expanded: ReadonlySet<string>): number {
  if (item.kind === "folder") return FOLDER_HEIGHT;
  if (item.kind === "more") return FILE_HEIGHT;
  const open = expanded.has(item.id) ? Math.max(1, item.file.functions.length) * FUNCTION_ROW + 10 : 0;
  return FILE_HEIGHT + open;
}

export interface Placed {
  id: string;
  item: LevelItem;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A layered layout: one column per layer (by layer name, unlayered last; long columns wrap every 10 cards),
 * folders above files, each by name. No physics, no randomness: the same level always lands the same way. */
export function layoutLevel(items: LevelItem[], expanded: ReadonlySet<string>): Placed[] {
  const groups = new Map<string, LevelItem[]>();
  for (const item of items) {
    if (item.kind === "more") continue;
    const key = item.layer ?? "";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : byName(a, b)));
  const columns: LevelItem[][] = [];
  for (const key of keys) {
    const group = groups.get(key)!;
    for (let i = 0; i < group.length; i += PER_COLUMN) columns.push(group.slice(i, i + PER_COLUMN));
  }
  const more = items.find((i) => i.kind === "more");
  if (more) {
    const last = columns.at(-1);
    if (last && last.length < PER_COLUMN) last.push(more);
    else columns.push([more]);
  }

  const placed: Placed[] = [];
  columns.forEach((column, c) => {
    let y = 0;
    for (const item of column) {
      const height = itemHeight(item, expanded);
      placed.push({ id: item.id, item, x: c * (CARD_WIDTH + COLUMN_GAP), y, width: CARD_WIDTH, height });
      y += height + ROW_GAP;
    }
  });
  return placed;
}

/** Edge stroke width by how many imports/calls it stands for: 1.25px for one, capped at 6px. */
export function edgeWidth(count: number): number {
  return Math.min(6, 1.25 + Math.log2(Math.max(1, count)) * 0.9);
}

export interface LevelEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  count: number;
  width: number;
}

/** The level's aggregated edges whose two ends are both on screen. */
export function levelEdges(level: GraphLevel, visible: ReadonlySet<string>): LevelEdge[] {
  return level.edges
    .filter((e) => visible.has(e.from) && visible.has(e.to))
    .map((e) => ({ id: `${e.type}:${e.from}->${e.to}`, source: e.from, target: e.to, type: e.type, count: e.count, width: edgeWidth(e.count) }));
}

/** Which lane hue a layer name reads as. */
export function laneOfLayer(layer: string | undefined): Lane {
  const l = (layer ?? "").toLowerCase();
  if (/\b(ui|page|pages|view|views|component|components|frontend|client|web)\b/.test(l)) return "ui";
  if (/\b(db|data|database|model|models|schema|migration|migrations|repository|repositories|store|storage)\b/.test(l)) return "db";
  if (/\b(queue|queues|worker|workers|job|jobs|event|events|consumer|consumers)\b/.test(l)) return "queue";
  if (/\b(api|route|routes|routing|controller|controllers|service|services|handler|handlers|middleware|server)\b/.test(l)) return "api";
  return "code";
}

/** The repo-relative file of a node ref ("repo::file:<path>", "repo::function:<path>:<name>", "repo::class:…"). */
export function fileOfRef(ref: string): string | undefined {
  const at = ref.indexOf("::");
  const id = at >= 0 ? ref.slice(at + 2) : ref;
  const colon = id.indexOf(":");
  if (colon < 0) return undefined;
  const type = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (type === "file") return rest;
  if (type === "function" || type === "class" || type === "method") {
    const last = rest.lastIndexOf(":");
    return last > 0 ? rest.slice(0, last) : undefined;
  }
  return undefined;
}

/** The folder of a repo-relative path ("" at the repo root). */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export interface MapStop {
  /** 1-based, in chain order over the whole journey; a stop shared by two chains keeps its first number. */
  n: number;
  symbol: string;
  line: number;
  ref?: string;
}

/** A journey's stops in `repo`, by file. */
export function journeyStops(journey: JourneyResult, repo: string): Map<string, MapStop[]> {
  const seen = new Set<string>();
  const out = new Map<string, MapStop[]>();
  let n = 0;
  for (const chain of journey.chains) {
    for (const s of chain.stops) {
      const key = JSON.stringify([s.repo, s.file, s.line, s.symbol]);
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
      if (s.repo !== repo) continue;
      const list = out.get(s.file) ?? [];
      list.push({ n, symbol: s.symbol, line: s.line, ...(s.ref ? { ref: s.ref } : {}) });
      out.set(s.file, list);
    }
  }
  return out;
}

/** Stops in files under `folder` (recursive). */
export function stopsUnder(stops: Map<string, MapStop[]>, folder: string): MapStop[] {
  const prefix = `${folder}/`;
  const out: MapStop[] = [];
  for (const [file, list] of stops) if (file.startsWith(prefix)) out.push(...list);
  return out.sort((a, b) => a.n - b.n);
}
