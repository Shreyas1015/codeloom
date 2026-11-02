import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfidenceLine, confidenceStroke } from "@/components/gallery/ConfidenceLine";
import { CountStrip } from "@/components/gallery/CountStrip";
import { LaneColumn, type LaneStop } from "@/components/gallery/LaneColumn";
import { StopRoundel, stopLabel } from "@/components/gallery/StopRoundel";

describe("StopRoundel", () => {
  it("is an image named 'Stop 3: POST /api/customers' by default", () => {
    render(<StopRoundel n={3} label="POST /api/customers" />);
    const r = screen.getByRole("img", { name: "Stop 3: POST /api/customers" });
    expect(r).toHaveTextContent("3");
    expect(r).toHaveAttribute("data-state", "default");
    expect(r).toHaveAttribute("data-size", "md");
  });

  it("marks the selected stop as the current step", () => {
    render(<StopRoundel n={4} label="CustomersController.store" state="selected" size="sm" />);
    const r = screen.getByRole("img", { name: "Stop 4: CustomersController.store" });
    expect(r).toHaveAttribute("data-state", "selected");
    expect(r).toHaveAttribute("aria-current", "step");
    expect(r).toHaveAttribute("data-size", "sm");
  });

  it("says an unresolved stop is unresolved and draws a dashed oxblood ring", () => {
    render(<StopRoundel n={5} label="fetch(url)" state="unresolved" />);
    const r = screen.getByRole("img", { name: "Stop 5: fetch(url) (unresolved)" });
    expect(r).toHaveAttribute("data-state", "unresolved");
    expect(r.className).toMatch(/border-dashed/);
    expect(r.className).toMatch(/border-destructive/);
  });

  it("can be decorative inside a labelled control", () => {
    const { container } = render(<StopRoundel n={1} label="x" decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("stopLabel builds the shared accessible label", () => {
    expect(stopLabel(3, "POST /api/customers")).toBe("Stop 3: POST /api/customers");
    expect(stopLabel(2, "x", true)).toBe("Stop 2: x (unresolved)");
  });
});

describe("CountStrip", () => {
  const counts = { files: 2318, pages: 64, routes: 186, tables: 52, queues: 3, journeys: 41 };

  it("lists the six totals in order, with captions and grouped numbers", () => {
    render(<CountStrip counts={counts} />);
    const strip = screen.getByRole("list", { name: "Totals" });
    const items = within(strip).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    const read = items.map((li) => [li.querySelector("[data-slot=count-value]")?.textContent, li.querySelector("[data-slot=count-caption]")?.textContent]);
    expect(read).toEqual([
      ["2,318", "Files"],
      ["64", "UI pages"],
      ["186", "API routes"],
      ["52", "DB tables"],
      ["3", "Queues"],
      ["41", "User journeys"],
    ]);
  });

  it("uses tabular figures for the numbers", () => {
    render(<CountStrip counts={counts} />);
    for (const v of document.querySelectorAll("[data-slot=count-value]")) expect(v.className).toMatch(/tabular-nums/);
  });

  it("each item reads as number then caption, in DOM order", () => {
    render(<CountStrip counts={counts} />);
    const first = screen.getAllByRole("listitem")[0]!;
    expect(first.firstElementChild).toHaveAttribute("data-slot", "count-value");
    expect(first.lastElementChild).toHaveAttribute("data-slot", "count-caption");
  });
});

describe("ConfidenceLine", () => {
  it("draws exact as a solid line with no tooltip trigger", () => {
    render(<ConfidenceLine confidence="exact" />);
    const line = screen.getByRole("img", { name: "Exact link" });
    expect(line).toHaveAttribute("data-confidence", "exact");
    expect(line).toHaveAttribute("data-stroke", "solid");
    expect(line).not.toHaveAttribute("tabindex");
  });

  it("draws param as a thinner solid line", () => {
    render(<ConfidenceLine confidence="param" />);
    const line = screen.getByRole("img", { name: "Matched with a path parameter" });
    expect(line).toHaveAttribute("data-stroke", "thin");
  });

  it("draws guess dashed, focusable, with the reason in a tooltip", async () => {
    const user = userEvent.setup();
    render(<ConfidenceLine confidence="guess" reason="Matched /api/* by prefix only" />);
    const line = screen.getByRole("img", { name: "Guessed link: Matched /api/* by prefix only" });
    expect(line).toHaveAttribute("data-stroke", "dashed");
    await user.tab();
    expect(line).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Matched /api/* by prefix only");
  });

  it("draws unresolved dashed in oxblood with a default reason", async () => {
    const user = userEvent.setup();
    render(<ConfidenceLine confidence="unresolved" orientation="horizontal" />);
    const line = screen.getByRole("img", { name: /^Unresolved hop: / });
    expect(line).toHaveAttribute("data-stroke", "dashed");
    expect(line).toHaveAttribute("data-orientation", "horizontal");
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/could not find/i);
  });

  it("confidenceStroke gives SVG paths the same look", () => {
    expect(confidenceStroke("exact")).toMatchObject({ stroke: "var(--connector)", strokeWidth: 2, strokeDasharray: undefined });
    expect(confidenceStroke("param").strokeWidth).toBeLessThan(2);
    expect(confidenceStroke("guess").strokeDasharray).toBeTruthy();
    expect(confidenceStroke("unresolved")).toMatchObject({ stroke: "var(--destructive)" });
  });
});

describe("LaneColumn", () => {
  const stops: LaneStop[] = [
    { index: 3, label: "POST /api/customers", detail: "api/start/routes.ts:88", note: "auth + role: sales" },
    { index: 4, label: "CustomersController.store", detail: "api/app/controllers/customers_controller.ts:41", confidence: "param" },
    { index: 5, label: "fetch(url)", detail: "api/app/services/invoice_service.ts:17", confidence: "unresolved", reason: "URL built at runtime", unresolved: true },
  ];

  it("is a region named after its lane with a hued header and the repo", () => {
    render(<LaneColumn lane="api" subtitle="core-service" stops={stops} />);
    const region = screen.getByRole("region", { name: "API" });
    expect(region).toHaveAttribute("data-lane", "api");
    expect(within(region).getByRole("heading", { level: 3 })).toHaveTextContent("API");
    expect(within(region).getByText("core-service")).toBeInTheDocument();
  });

  it("stacks the stops in order with connectors between them", () => {
    render(<LaneColumn lane="api" stops={stops} />);
    const items = within(screen.getByRole("list", { name: "API stops" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("POST /api/customers")).toBeInTheDocument();
    expect(within(items[0]!).getByText("api/start/routes.ts:88")).toBeInTheDocument();
    // connector before stop 2 and stop 3, none before the first
    expect(within(items[0]!).queryByRole("img", { name: /link|hop/i })).toBeNull();
    expect(within(items[1]!).getByRole("img", { name: "Matched with a path parameter" })).toBeInTheDocument();
    expect(within(items[2]!).getByRole("img", { name: "Unresolved hop: URL built at runtime" })).toBeInTheDocument();
    expect(within(items[2]!).getByRole("img", { name: "Stop 5: fetch(url) (unresolved)" })).toBeInTheDocument();
  });

  it("connects with an exact line when a stop gives no confidence", () => {
    render(<LaneColumn lane="ui" stops={[stops[0]!, { index: 4, label: "b" }]} />);
    expect(screen.getByRole("img", { name: "Exact link" })).toBeInTheDocument();
  });

  it("draws no connector, only a plain gap, before a stop that is not connected to the one above", () => {
    render(<LaneColumn lane="db" stops={[{ index: 5, label: "invoices" }, { index: 6, label: "invoice_lines", connected: false }]} />);
    const items = within(screen.getByRole("list", { name: "DB stops" })).getAllByRole("listitem");
    expect(items[1]!.querySelector('[data-slot="confidence-line"]')).toBeNull();
    const gap = items[1]!.querySelector('[data-slot="lane-gap"]');
    expect(gap).not.toBeNull();
    expect(gap).toHaveAttribute("aria-hidden", "true");
  });

  it("makes stops buttons when selectable, marks the selected one, and reports clicks", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<LaneColumn lane="api" stops={stops} selectedIndex={4} onSelect={onSelect} />);
    const sel = screen.getByRole("button", { name: "Stop 4: CustomersController.store" });
    expect(sel).toHaveAttribute("aria-current", "step");
    expect(sel).toHaveAccessibleDescription("api/app/controllers/customers_controller.ts:41");
    expect(screen.getByRole("button", { name: "Stop 3: POST /api/customers" })).not.toHaveAttribute("aria-current");
    await user.click(screen.getByRole("button", { name: "Stop 3: POST /api/customers" }));
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("keeps the dashed oxblood edge on a selected unresolved stop, with the ochre selection ring outside", () => {
    render(<LaneColumn lane="api" stops={stops} selectedIndex={5} onSelect={() => {}} />);
    const card = screen.getByRole("button", { name: "Stop 5: fetch(url) (unresolved)" });
    expect(card).toHaveAttribute("aria-current", "step");
    expect(card.className).toMatch(/border-dashed/);
    expect(card.className).toMatch(/border-destructive/);
    expect(card.className).not.toMatch(/border-accent-foreground/);
    expect(card.className).toMatch(/shadow-\[0_0_0_3px_rgb\(227_167_47/);
    const roundel = card.querySelector("[data-slot=stop-roundel]")!;
    expect(roundel).toHaveAttribute("data-state", "unresolved");
    expect(roundel.className).toMatch(/border-dashed/);
    expect(roundel.className).toMatch(/shadow-\[0_0_0_4px_rgb\(227_167_47/);
  });

  it("draws connectors in the connector token, not the focus ring", () => {
    render(<ConfidenceLine confidence="exact" />);
    const wire = screen.getByRole("img", { name: "Exact link" }).firstElementChild!;
    expect(wire.className).toMatch(/border-connector/);
    expect(wire.className).not.toMatch(/border-ring/);
    expect(confidenceStroke("param").stroke).toBe("var(--connector)");
  });

  it("uses each lane's hue and says when a lane is empty", () => {
    const { rerender } = render(<LaneColumn lane="db" stops={[]} />);
    expect(screen.getByRole("region", { name: "DB" }).className).toMatch(/bg-lane-db-soft/);
    expect(screen.getByText("No stops in this lane")).toBeInTheDocument();
    rerender(<LaneColumn lane="queue" stops={[]} />);
    expect(screen.getByRole("region", { name: "Queue" }).className).toMatch(/bg-lane-queue-soft/);
    rerender(<LaneColumn lane="code" stops={[]} />);
    const code = screen.getByRole("region", { name: "Code" });
    expect(code).toHaveAttribute("data-lane", "code");
    expect(code.className).toMatch(/bg-lane-code-soft/);
    expect(code.querySelector("h3")!.className).toMatch(/text-lane-code/);
  });
});
