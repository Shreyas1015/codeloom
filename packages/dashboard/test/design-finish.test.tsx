// Task 11 design finish: wrap points for paths and names, the Home stop roundel row, and the Map's opening view.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Breakable, breakPieces } from "@/lib/breakable";
import { LaneCounts, MAX_ROUNDELS } from "@/screens/home/parts";
import { Inspector } from "@/screens/map/Inspector";
import { CARD_WIDTH, FIT_MAX_ZOOM, FIT_MIN_ZOOM, fitViewport } from "@/screens/map/layout";

describe("Map inspector with nothing selected", () => {
  it("sums up the open level, saying when nothing links its cards", () => {
    const level = {
      repo: "api",
      dir: "app",
      folders: [{ path: "app/controllers", name: "controllers", files: 2 }],
      files: [{ ref: "api::file:app/x.ts", path: "app/x.ts", name: "x.ts", functions: [], journeys: [] }],
      edges: [],
    };
    const { rerender } = render(<Inspector repo="api" level={level} onOpenFolder={() => {}} onJump={() => {}} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("api/app");
    expect(screen.getByText(/1 folder · 1 file · no imports or calls between them/)).toBeInTheDocument();
    rerender(
      <Inspector
        repo="api"
        level={{ ...level, edges: [{ from: "app/controllers", to: "app/x.ts", type: "imports", count: 3 }] }}
        onOpenFolder={() => {}}
        onJump={() => {}}
      />,
    );
    expect(screen.getByText(/3 imports and calls between them/)).toBeInTheDocument();
  });
});

describe("breakPieces", () => {
  it("breaks a path after each slash and underscore, keeping the extension and line with the name", () => {
    expect(breakPieces("app/controllers/customers_controller.ts:9")).toEqual(["app/", "controllers/", "customers_", "controller.ts:9"]);
    expect(breakPieces("app/customers/new/page.tsx:1")).toEqual(["app/", "customers/", "new/", "page.tsx:1"]);
  });

  it("breaks a code name at its humps and at dots before a long part", () => {
    expect(breakPieces("CustomersController.store")).toEqual(["Customers", "Controller.store"]);
    expect(breakPieces("InvoiceService.markInvoicePaid")).toEqual(["Invoice", "Service.", "mark", "Invoice", "Paid"]);
    expect(breakPieces("POST /api/customers")).toEqual(["POST /", "api/", "customers"]);
  });

  it("keeps the text exactly", () => {
    const { container } = render(<span data-testid="p"><Breakable text="lib/use-create-customer.ts:12" /></span>);
    expect(container.textContent).toBe("lib/use-create-customer.ts:12");
    expect(container.querySelectorAll("wbr").length).toBe(breakPieces("lib/use-create-customer.ts:12").length - 1);
  });
});

describe("LaneCounts (Home stop row)", () => {
  const stops = { ui: 3, api: 1, code: 2, db: 2, queue: 0 };

  it("draws one numbered roundel per stop, in lane order, ringed in the lane hue", () => {
    const { container } = render(<LaneCounts stops={stops} />);
    expect(screen.getByLabelText("3 UI stops")).toHaveAttribute("data-lane", "ui");
    expect(screen.getByLabelText("2 DB stops")).toHaveAttribute("data-lane", "db");
    expect(screen.queryByLabelText(/Queue stop/)).toBeNull();
    const numbers = [...container.querySelectorAll("[data-lane] span > span")].map((s) => s.textContent);
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(container.querySelector('[data-lane="ui"] span > span')).toHaveClass("border-lane-ui", "bg-card");
    // hollow: Home never paints a stop as walked
    expect(container.querySelector(".bg-accent")).toBeNull();
  });

  it(`folds stops past ${MAX_ROUNDELS} into one dashed +N, keeping each lane's true count`, () => {
    const { container } = render(<LaneCounts stops={{ ui: 4, api: 2, code: 4, db: 3, queue: 0 }} />);
    const numbers = [...container.querySelectorAll("[data-lane] span > span")].map((s) => s.textContent);
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(screen.getByText("+6")).toHaveClass("border-dashed");
    expect(screen.getByLabelText("4 Code stops")).toBeInTheDocument();
    expect(screen.getByLabelText("3 DB stops")).toBeInTheDocument();
  });

  it("says when a journey has no stops", () => {
    render(<LaneCounts stops={{ ui: 0, api: 0, code: 0, db: 0, queue: 0 }} />);
    expect(screen.getByText("No stops")).toBeInTheDocument();
  });
});

describe("fitViewport (Map opening view)", () => {
  const card = (x: number, y = 0) => ({ x, y, width: CARD_WIDTH, height: 74 });

  it("shows a small level at a readable zoom, top-aligned and centred across", () => {
    const vp = fitViewport([card(0), card(288), card(576)], { width: 805, height: 650 });
    expect(vp.zoom).toBeGreaterThanOrEqual(FIT_MIN_ZOOM);
    expect(vp.zoom).toBeLessThanOrEqual(FIT_MAX_ZOOM);
    const w = (576 + CARD_WIDTH) * vp.zoom;
    expect(vp.x).toBeCloseTo((805 - w) / 2, 0);
    expect(vp.y).toBe(28);
  });

  it("never blows a single card up past the max zoom", () => {
    expect(fitViewport([card(0)], { width: 1200, height: 800 }).zoom).toBe(FIT_MAX_ZOOM);
  });

  it("keeps cards readable on a wide level: min zoom, anchored top-left, the rest a pan away", () => {
    const wide = Array.from({ length: 8 }, (_, i) => card(i * 288));
    expect(fitViewport(wide, { width: 805, height: 650 })).toEqual({ x: 28, y: 28, zoom: FIT_MIN_ZOOM });
  });

  it("falls back to zoom 1 with nothing to show or no size yet", () => {
    expect(fitViewport([], { width: 800, height: 600 }).zoom).toBe(1);
    expect(fitViewport([card(0)], { width: 0, height: 0 }).zoom).toBe(1);
  });
});
