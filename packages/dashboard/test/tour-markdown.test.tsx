import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/screens/tour/markdown";

describe("tour Markdown", () => {
  it("renders paragraphs, inline code, bold, italics and lists", () => {
    const { container } = render(<Markdown text={"First `create()` is **bold** and *soft*.\n\n- one\n- two\n\n1. a\n2. b"} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("code")).toHaveTextContent("create()");
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("soft");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("renders fenced code as a mono block and never renders HTML", () => {
    const { container } = render(<Markdown text={"Look:\n\n```ts\nconst a = 1\n```\n\n<img src=x onerror=alert(1)>"} />);
    expect(container.querySelector("pre")).toHaveTextContent("const a = 1");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});
