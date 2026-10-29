import { describe, expect, it } from "vitest";
import { parseChatLinkHref, splitChatLinks } from "./chat-links";

describe("chat links", () => {
  it("parses only relay chat links", () => {
    expect(parseChatLinkHref("relay://chat/3f2a-9c")).toBe("3f2a-9c");
    expect(parseChatLinkHref("relay://chat/3f2a/")).toBe("3f2a");
    expect(parseChatLinkHref("relay://chat/")).toBeNull();
    expect(parseChatLinkHref("relay://chat/a/b")).toBeNull();
    expect(parseChatLinkHref("https://example.com/chat/a")).toBeNull();
  });

  it("splits bare links out of prose", () => {
    expect(splitChatLinks("See relay://chat/ab-12, then relay://chat/cd.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "chat", href: "relay://chat/ab-12" },
      { kind: "text", text: ", then " },
      { kind: "chat", href: "relay://chat/cd" },
      { kind: "text", text: "." },
    ]);
    expect(splitChatLinks("no links")).toEqual([{ kind: "text", text: "no links" }]);
  });
});
