import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@shared/types";
import { buildAsideDraftQuote, getAttachedAsides, parseBtw, resolveAsideSelection } from "./aside";
import { isAttachedChatInstance, isAttachedReviewInstance } from "./review-session";

function chat(overrides: Partial<InstanceInfo>): InstanceInfo {
  return {
    id: "chat",
    provider: "claude",
    name: "Chat",
    workingDirectory: "/repo",
    status: "idle",
    createdAt: 1,
    lastActivityAt: 1,
    ...overrides,
  };
}

const source = chat({ id: "source", sessionId: "s-1" });
const aside = (id: string, createdAt: number) =>
  chat({
    id,
    createdAt,
    aside: { sourceInstanceId: "source", sourceSessionId: "s-1", sourceName: "Chat", forkedAt: 1 },
  });

describe("getAttachedAsides", () => {
  it("lists only this chat's asides, newest first", () => {
    const other = chat({
      id: "other",
      aside: { sourceInstanceId: "elsewhere", sourceName: "X", forkedAt: 1 },
    });
    const list = getAttachedAsides(source, [aside("a", 1), other, aside("b", 2), source]);
    expect(list.map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("resolveAsideSelection", () => {
  const asides = [aside("b", 2), aside("a", 1)];
  it("defaults to the newest aside", () => {
    expect(resolveAsideSelection(asides, undefined)).toBe("b");
    expect(resolveAsideSelection([], undefined)).toBeNull();
  });
  it("keeps a just-created aside the list hasn't caught up with", () => {
    expect(resolveAsideSelection(asides, "c", "c")).toBe("c");
    expect(resolveAsideSelection(asides, "gone")).toBe("b");
  });
});

describe("attached chat classification", () => {
  it("treats asides as attached chats but never as reviews", () => {
    const a = aside("a", 1);
    expect(isAttachedChatInstance(a)).toBe(true);
    expect(isAttachedReviewInstance(a)).toBe(false);
    expect(isAttachedChatInstance(source)).toBe(false);
  });
});

describe("buildAsideDraftQuote", () => {
  it("blockquotes every line, keeping paragraph breaks", () => {
    expect(buildAsideDraftQuote("one\n\ntwo\n")).toBe("From an aside:\n> one\n>\n> two\n\n");
  });
});

describe("parseBtw", () => {
  it("extracts the question after /btw", () => {
    expect(parseBtw("/btw why is this slow?")).toBe("why is this slow?");
    expect(parseBtw("  /BTW multi\nline ")).toBe("multi\nline");
  });
  it("ignores everything else", () => {
    expect(parseBtw("/btw")).toBeNull();
    expect(parseBtw("/btw   ")).toBeNull();
    expect(parseBtw("btw why")).toBeNull();
    expect(parseBtw("/btwx why")).toBeNull();
  });
});
