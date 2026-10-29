import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./markdown-content";

describe("chat link chips in markdown", () => {
  it("chips bare and labelled chat links, but not ones in code", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        text={"See relay://chat/abc-1 and [the review](relay://chat/def). `relay://chat/xyz`"}
      />,
    );
    // Outside the app's providers no chat resolves, so chips render inert.
    expect(html).toContain("Unknown chat");
    expect(html).toContain("the review");
    expect(html).toContain("<code>relay://chat/xyz</code>");
    expect(html).not.toContain('href="relay://');
  });
});
