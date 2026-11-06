import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LevelBadge, LevelStrip, ProgressLegend, ProgressStrip } from "@/components/gallery/ProgressStrip";

const width = (el: Element | null) => (el as HTMLElement | null)?.style.width;

describe("ProgressStrip", () => {
  it("is one image named with every segment and the total", () => {
    render(<ProgressStrip counts={{ total: 10, understood: 3, toured: 2, seen: 1 }} />);
    expect(screen.getByRole("img", { name: "3 understood, 2 toured, 1 seen, of 10 journeys" })).toBeInTheDocument();
  });

  it("draws understood, toured and seen in that order, as shares of the total", () => {
    const { container } = render(<ProgressStrip counts={{ total: 10, understood: 3, toured: 2, seen: 1 }} />);
    const segs = [...container.querySelectorAll("[data-segment]")];
    expect(segs.map((s) => s.getAttribute("data-segment"))).toEqual(["understood", "toured", "seen"]);
    expect(segs.map(width)).toEqual(["30%", "20%", "10%"]);
  });

  it("shares a baseline: the track is the total's share of the scale, from the same left edge", () => {
    const { container } = render(<ProgressStrip counts={{ total: 5, understood: 0, toured: 0, seen: 5 }} scale={20} />);
    expect(width(container.querySelector("[data-slot=progress-track]"))).toBe("25%");
  });

  it("leaves out empty segments and draws an empty track for no journeys", () => {
    const { container } = render(<ProgressStrip counts={{ total: 0, understood: 0, toured: 0, seen: 0 }} scale={4} />);
    expect(container.querySelectorAll("[data-segment]")).toHaveLength(0);
    expect(screen.getByRole("img", { name: "No journeys" })).toBeInTheDocument();
  });

  it("names singular journeys", () => {
    render(<ProgressStrip counts={{ total: 1, understood: 1, toured: 0, seen: 0 }} />);
    expect(screen.getByRole("img", { name: "1 understood, of 1 journey" })).toBeInTheDocument();
  });
});

describe("LevelStrip", () => {
  it.each([
    ["none", 0, "Not started"],
    ["seen", 1, "Seen"],
    ["toured", 2, "Toured"],
    ["understood", 3, "Understood"],
  ] as const)("%s fills %i of 3 and says %s", (level, filled, word) => {
    const { container } = render(<LevelStrip level={level} />);
    expect(container.querySelectorAll("[data-step=on]")).toHaveLength(filled);
    expect(container.querySelectorAll("[data-step]")).toHaveLength(3);
    expect(container.firstElementChild).toHaveAttribute("data-level", level);
    expect(container).toHaveTextContent(word);
  });

  it("says how many stops a re-walk covers, and draws its steps dashed, never in ochre fill", () => {
    const { container } = render(<LevelStrip level="re-walk" changed={3} />);
    expect(container).toHaveTextContent("Re-walk 3 stops");
    const on = [...container.querySelectorAll("[data-step=on]")];
    expect(on).toHaveLength(2);
    for (const el of on) {
      expect(el.className).toMatch(/border-dashed/);
      expect(el.className).not.toMatch(/(^|\s)bg-accent(\s|$)/);
    }
  });
});

describe("LevelBadge", () => {
  it.each([
    ["seen", "Seen"],
    ["toured", "Toured"],
    ["understood", "Understood"],
  ] as const)("names %s", (level, word) => {
    render(<LevelBadge level={level} />);
    expect(screen.getByText(word)).toHaveAttribute("data-level", level);
  });

  it("names a re-walk with its changed stops", () => {
    render(<LevelBadge level="re-walk" changed={1} />);
    expect(screen.getByText("Needs re-walk · 1 stop changed")).toHaveAttribute("data-level", "re-walk");
  });

  it("shows nothing before the journey is opened", () => {
    const { container } = render(<LevelBadge level="none" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ProgressLegend", () => {
  it("names the three colours", () => {
    render(<ProgressLegend />);
    expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("UnderstoodTouredSeen");
  });
});
