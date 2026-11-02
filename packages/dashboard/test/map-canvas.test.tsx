import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GraphLevel } from "@/api/types";
import { MapCanvas, type MapCanvasProps } from "@/screens/map/MapCanvas";
import { type MapStop, levelItems } from "@/screens/map/layout";

const setCenter = vi.fn();
vi.mock("@xyflow/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@xyflow/react")>();
  return { ...real, useReactFlow: () => ({ ...real, setCenter, getViewport: () => ({ x: 0, y: 0, zoom: 0.8 }) }) };
});

// React Flow reads the viewport transform through DOMMatrixReadOnly, which jsdom lacks.
beforeAll(() => {
  if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
    (globalThis as Record<string, unknown>).DOMMatrixReadOnly = class {
      m22 = 1;
      constructor(_init?: string) {}
    };
  }
});

const level: GraphLevel = {
  repo: "api",
  dir: "app",
  folders: [{ path: "app/models", name: "models", files: 2, layer: "data" }],
  files: [
    {
      ref: "api::file:app/invoice.ts",
      path: "app/invoice.ts",
      name: "invoice.ts",
      functions: [
        { ref: "api::function:app/invoice.ts:total", name: "total", type: "function", line: 4 },
        { ref: "api::function:app/invoice.ts:Invoice.total", name: "total", type: "function", line: 30 },
      ],
      journeys: ["j_bill_customer"],
    },
    { ref: "api::file:app/customer.ts", path: "app/customer.ts", name: "customer.ts", functions: [], journeys: [] },
  ],
  edges: [],
};

function renderCanvas(over: Partial<MapCanvasProps> = {}) {
  const props: MapCanvasProps = {
    level,
    items: levelItems(level).items,
    expanded: new Set(),
    layers: false,
    onSelectFolder: vi.fn(),
    onOpenFolder: vi.fn(),
    onToggleFile: vi.fn(),
    onSelectFunction: vi.fn(),
    ...over,
  };
  return render(
    <div style={{ width: 800, height: 600 }}>
      <MapCanvas {...props} />
    </div>,
  );
}

describe("MapCanvas", () => {
  it("names the canvas after the repo and drops React Flow's select/move/delete key hints", () => {
    renderCanvas();
    const canvas = screen.getByRole("application", { name: "Map of api" });
    expect(canvas).toHaveClass("react-flow");
    expect(screen.queryByText(/arrow keys/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/delete/i)).not.toBeInTheDocument();
  });

  it("pans to a card that gets focus while off screen, keeping the zoom", () => {
    setCenter.mockClear();
    renderCanvas(); // jsdom lays nothing out: the canvas is 0×0, so every card is off screen
    fireEvent.focus(screen.getByRole("button", { name: /^customer\.ts/ }));
    expect(setCenter).toHaveBeenCalledTimes(1);
    const [x, y, opts] = setCenter.mock.calls[0]!;
    expect(typeof x).toBe("number");
    expect(typeof y).toBe("number");
    expect(opts).toMatchObject({ zoom: 0.8 });
  });

  it("does not pan when the focused card is already in view", () => {
    setCenter.mockClear();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 10000,
      bottom: 10000,
      width: 10000,
      height: 10000,
      toJSON: () => ({}),
    } as DOMRect);
    renderCanvas();
    fireEvent.focus(screen.getByRole("button", { name: /^customer\.ts/ }));
    expect(setCenter).not.toHaveBeenCalled();
  });

  it("dims cards off the journey without fading their text", () => {
    const stops = new Map<string, MapStop[]>([["app/invoice.ts", [{ n: 1, lane: "code", symbol: "total", line: 4 }]]]);
    renderCanvas({ stops });
    const dim = screen.getByRole("button", { name: /^customer\.ts/ }).closest("[data-card]")!;
    expect(dim).toHaveAttribute("data-overlay", "dim");
    const tokens = dim.className.split(/\s+/);
    // no opacity on the card itself (that would fade its text); only its icons are faded
    expect(tokens.filter((t) => /^opacity-/.test(t))).toEqual([]);
    expect(tokens).toContain("[&_svg]:opacity-40");
    for (const el of dim.querySelectorAll("*")) expect(el.className.toString()).not.toMatch(/(^|\s)opacity-/);
  });

  it("puts a function's roundel on the right one of two same-name functions", () => {
    const stops = new Map<string, MapStop[]>([
      [
        "app/invoice.ts",
        [
          { n: 2, lane: "code", symbol: "total", line: 99, ref: "api::function:app/invoice.ts:Invoice.total" },
          { n: 3, lane: "code", symbol: "total", line: 4 },
          { n: 5, lane: "code", symbol: "total", line: 70 },
        ],
      ],
    ]);
    renderCanvas({ stops, expanded: new Set(["app/invoice.ts"]) });
    const list = screen.getByRole("list", { name: "Functions in invoice.ts" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(within(first!).getAllByRole("img").map((i) => i.getAttribute("aria-label"))).toEqual(["Stop 3: total"]);
    expect(within(second!).getAllByRole("img").map((i) => i.getAttribute("aria-label"))).toEqual(["Stop 2: total"]);
    expect(screen.queryByRole("img", { name: "Stop 5: total" })).not.toBeInTheDocument();
  });
});
