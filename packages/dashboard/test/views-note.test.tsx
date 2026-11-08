import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoteMarkdown } from "@/screens/views/NoteMarkdown";

describe("view note Markdown", () => {
  it("renders headings, lists, bold, inline code and fenced code", () => {
    const { container } = render(
      <NoteMarkdown text={"# Spec audit\n\nJourneys with **no spec** for `SHOP-12`.\n\n## Next\n\n- Invoices\n- Customers\n\n```\ncodeloom index\n```"} />,
    );
    expect(screen.getByRole("heading", { name: "Spec audit" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Next" })).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("no spec");
    expect(container.querySelector("code")).toHaveTextContent("SHOP-12");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre")).toHaveTextContent("codeloom index");
  });

  it("note headings sit below the view's own title (h1 → h3, ## → h4)", () => {
    render(<NoteMarkdown text={"# One\n\n## Two\n\n### Three"} />);
    expect(screen.getByRole("heading", { name: "One" }).tagName).toBe("H3");
    expect(screen.getByRole("heading", { name: "Two" }).tagName).toBe("H4");
    expect(screen.getByRole("heading", { name: "Three" }).tagName).toBe("H5");
  });

  it("links: in-app paths and http(s) only; anything else stays plain text", () => {
    render(<NoteMarkdown text={"See [the map](/map?repo=api), [docs](https://example.com/a) and [bad](javascript:alert(1)) or [data](data:text/html,x)."} />);
    expect(screen.getByRole("link", { name: "the map" })).toHaveAttribute("href", "/map?repo=api");
    const ext = screen.getByRole("link", { name: "docs" });
    expect(ext).toHaveAttribute("href", "https://example.com/a");
    expect(ext).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.queryByRole("link", { name: "data" })).toBeNull();
    expect(screen.getByText(/\[bad\]\(javascript:alert\(1\)\)/)).toBeInTheDocument();
  });

  it("never renders raw HTML", () => {
    const { container } = render(<NoteMarkdown text={'<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\n<a href="javascript:x">x</a>'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
  });
});
