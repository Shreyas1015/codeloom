/** The React Flow canvas for one folder level. Cards sit where `layoutLevel` puts them; nothing is dragged and
 * nothing moves by physics. Each card is a real button, so Tab walks the cards and Enter acts on them. */
import "@xyflow/react/dist/style.css";
import { Background, BackgroundVariant, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";
import type { GraphFile, GraphLevel, Lane } from "@/api/types";
import { type CardOverlay, type FileCardData, type FolderCardData, type MoreCardData, nodeTypes } from "./MapCards";
import { type LevelItem, type MapStop, laneOfLayer, layoutLevel, levelEdges, stopsUnder } from "./layout";

export interface MapCanvasProps {
  level: GraphLevel;
  items: LevelItem[];
  expanded: ReadonlySet<string>;
  /** Selected file or function ref (from the URL). */
  selectedRef?: string;
  selectedFolder?: string;
  /** The journey overlay's stops in this repo by file, or undefined when no journey overlay is on. */
  stops?: Map<string, MapStop[]>;
  layers: boolean;
  onSelectFolder: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onToggleFile: (file: GraphFile) => void;
  onSelectFunction: (ref: string) => void;
}

type CardNode = Node<FolderCardData, "folder"> | Node<FileCardData, "file"> | Node<MoreCardData, "more">;

export function MapCanvas(props: MapCanvasProps) {
  const { level, items, expanded, selectedRef, selectedFolder, stops, layers } = props;

  const nodes = useMemo<CardNode[]>(() => {
    const placed = layoutLevel(items, expanded);
    return placed.map((p): CardNode => {
      // React Flow turns pointer events off on nodes that are neither selectable nor draggable; the cards are
      // buttons, so turn them back on. "nopan": a press on a card is a click, not the start of a pan.
      const base = {
        id: p.id,
        position: { x: p.x, y: p.y },
        initialWidth: p.width,
        initialHeight: p.height,
        className: "nopan",
        style: { pointerEvents: "all" as const },
      };
      const item = p.item;
      if (item.kind === "more") return { ...base, type: "more", data: { kind: "more", label: item.label, width: p.width } };
      const lane: Lane | undefined = layers ? laneOfLayer(item.layer) : undefined;
      const itemStops = !stops ? [] : item.kind === "folder" ? stopsUnder(stops, item.folder.path) : (stops.get(item.file.path) ?? []);
      const overlay: CardOverlay = !stops ? "none" : itemStops.length ? "stop" : "dim";
      if (item.kind === "folder") {
        return {
          ...base,
          type: "folder",
          data: {
            kind: "folder",
            folder: item.folder,
            overlay,
            ...(lane ? { lane } : {}),
            stops: itemStops,
            selected: selectedFolder === item.folder.path,
            width: p.width,
            onSelect: props.onSelectFolder,
            onOpen: props.onOpenFolder,
          },
        };
      }
      return {
        ...base,
        type: "file",
        data: {
          kind: "file",
          file: item.file,
          overlay,
          ...(lane ? { lane } : {}),
          stops: itemStops,
          selected: selectedRef === item.file.ref,
          ...(selectedRef ? { selectedRef } : {}),
          expanded: expanded.has(item.file.path),
          width: p.width,
          onToggle: props.onToggleFile,
          onSelectFunction: props.onSelectFunction,
        },
      };
    });
    // the callbacks are stable (useCallback in MapScreen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, expanded, selectedRef, selectedFolder, stops, layers]);

  const edges = useMemo<Edge[]>(() => {
    const visible = new Set(nodes.map((n) => n.id));
    return levelEdges(level, visible).map((e) => {
      const onJourney = !!stops && (stopCount(nodes, e.source) > 0 || stopCount(nodes, e.target) > 0);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        focusable: false,
        selectable: false,
        ariaLabel: `${e.source} ${e.type} ${e.target} (${e.count})`,
        style: {
          stroke: onJourney ? "#C99A2E" : "var(--connector)",
          strokeWidth: e.width,
          opacity: stops && !onJourney ? 0.35 : 0.85,
        },
        ...(e.count > 1
          ? {
              label: String(e.count),
              labelStyle: { fontFamily: "var(--font-mono)", fontSize: 10.5, fill: "var(--muted-foreground)" },
              labelBgStyle: { fill: "var(--background)" },
              labelBgPadding: [3, 1] as [number, number],
            }
          : {}),
      };
    });
  }, [level, nodes, stops]);

  return (
    <ReactFlow
      key={`${level.repo}/${level.dir}`}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={1.75}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      attributionPosition="top-right"
      className="bg-[#EEF0EC]"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#C9CFCA" />
      <Controls showInteractive={false} position="bottom-right" className="!overflow-hidden !rounded-lg !border !border-border !shadow-none" />
    </ReactFlow>
  );
}

function stopCount(nodes: CardNode[], id: string): number {
  const n = nodes.find((x) => x.id === id);
  return n && n.data.kind !== "more" ? n.data.stops.length : 0;
}
