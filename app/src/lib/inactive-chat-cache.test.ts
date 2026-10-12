import { describe, expect, it, vi } from "vitest";
import { InactiveChatCache, estimateRetainedBytes } from "./inactive-chat-cache";

describe("inactive Chat cache", () => {
  it("evicts oldest snapshots by payload budget and treats revisits as recent", () => {
    const evict = vi.fn();
    const cache = new InactiveChatCache<string>(30, 100, evict);
    cache.set("a", "first", 40);
    cache.set("b", "second", 40);
    expect(cache.take("a")).toBe("first");
    cache.set("a", "first", 40);
    cache.set("c", "third", 40);
    expect(evict).toHaveBeenCalledWith("b");
    expect(cache.peek("a")).toBe("first");
    expect(cache.estimatedBytes).toBe(80);
  });
  it("does not retain a single oversized transcript or exceed the entry cap", () => {
    const evict = vi.fn();
    const cache = new InactiveChatCache<string>(2, 100, evict);
    cache.set("large", "oversized", 101);
    expect(cache.size).toBe(0);
    expect(evict).toHaveBeenCalledWith("large");
    for (const id of ["a", "b", "c"]) cache.set(id, id, 10);
    expect(cache.size).toBe(2);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.estimatedBytes).toBe(20);
  });
  it("stops before visiting the rest of an oversized graph", () => {
    const unread = vi.fn(() => "must not be visited");
    const payload = {
      text: "x".repeat(100),
      get tail() {
        return unread();
      },
    };
    expect(estimateRetainedBytes([payload], 100)).toBeGreaterThan(100);
    expect(unread).not.toHaveBeenCalled();
    expect(estimateRetainedBytes([payload])).toBeGreaterThan(232);
    expect(unread).toHaveBeenCalledOnce();
  });
  it("includes Map keys and Set values while preserving shared ownership", () => {
    const shared = { text: "a retained transcript" };
    const containers = new Map([["agent", new Set([shared])]]);
    expect(estimateRetainedBytes([containers])).toBe(
      32 + 10 + 32 + estimateRetainedBytes([shared]),
    );
    expect(estimateRetainedBytes([containers, shared])).toBe(estimateRetainedBytes([containers]));
  });
  it("counts shared objects once and tolerates cycles without serialization", () => {
    const shared: { text: string; self?: unknown } = { text: "history" };
    shared.self = shared;
    expect(estimateRetainedBytes([shared, shared])).toBe(estimateRetainedBytes([shared]));
    expect(estimateRetainedBytes([shared])).toBeGreaterThan(shared.text.length * 2);
  });
});
