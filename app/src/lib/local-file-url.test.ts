import { describe, expect, it } from "vitest";
import { localImageSrc } from "./local-file-url";

describe("localImageSrc", () => {
  it("routes absolute filesystem paths through /api/file", () => {
    expect(localImageSrc("/tmp/relay-shots/full light.png")).toBe(
      "/api/file?path=%2Ftmp%2Frelay-shots%2Ffull%20light.png",
    );
  });

  it("routes file:// URLs through /api/file", () => {
    expect(localImageSrc("file:///Users/me/a%20b.png")).toBe(
      "/api/file?path=%2FUsers%2Fme%2Fa%20b.png",
    );
  });

  it("leaves Relay routes, remote URLs and relative paths alone", () => {
    expect(localImageSrc("/api/file?path=%2Ftmp%2Fx.png")).toBeNull();
    expect(localImageSrc("https://example.com/x.png")).toBeNull();
    expect(localImageSrc("//cdn.example.com/x.png")).toBeNull();
    expect(localImageSrc("shots/x.png")).toBeNull();
  });
});
