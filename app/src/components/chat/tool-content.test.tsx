import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ToolContent } from "./tool-content";

vi.mock("@/components/chat/markdown-content", () => ({
  ImageThumbnail: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

describe("read tool previews", () => {
  it("renders the captured source with syntax highlighting and read bounds", () => {
    const html = renderToStaticMarkup(
      <ToolContent
        tool="Read"
        input={{ file_path: "/Plan.tsx", offset: 760, limit: 60 }}
        resultDetail="const answer = 42;"
      />,
    );
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("answer");
    expect(html).toContain("offset: 760, limit: 60");
  });
  for (const tool of ["Read", "ViewImage"]) {
    it(`keeps ${tool} thumbnails when the result contains text`, () => {
      const html = renderToStaticMarkup(
        <ToolContent tool={tool} input={{ file_path: "/photo.png" }} resultDetail="Image loaded" />,
      );
      expect(html).toContain("<img");
      expect(html).toContain("/api/file?path=%2Fphoto.png");
    });
  }
  it("shows read errors instead of a misleading image preview", () => {
    const html = renderToStaticMarkup(
      <ToolContent
        tool="Read"
        input={{ file_path: "/missing.png" }}
        resultDetail="File not found"
        resultStatus="error"
      />,
    );
    expect(html).toContain("File not found");
    expect(html).not.toContain("<img");
  });
});
