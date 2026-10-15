import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepare, clearCache } = vi.hoisted(() => ({
  prepare: vi.fn((text: string) => ({ text })),
  clearCache: vi.fn(),
}));
vi.mock("@chenglou/pretext", () => ({
  prepare,
  clearCache,
  layout: () => ({ height: 22.75, lineCount: 1 }),
}));

describe("text layout retention", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  it("keeps ordinary layout hits warm and evicts old prepared text and library metrics", async () => {
    const { estimateUserHeight, getTextLayoutCacheStats } = await import("./pretext");
    estimateUserHeight("prompt-0", 600);
    estimateUserHeight("prompt-0", 600);
    expect(prepare).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 1024; i++) estimateUserHeight(`prompt-${i}`, 600);
    expect(getTextLayoutCacheStats().preparedEntries).toBe(1024);
    expect(clearCache).toHaveBeenCalledTimes(1);
    const calls = prepare.mock.calls.length;
    estimateUserHeight("prompt-1024", 600);
    expect(prepare.mock.calls.length).toBe(calls);
    estimateUserHeight("prompt-0", 600);
    expect(prepare.mock.calls.length).toBe(calls + 1);
  });
  it("bounds payload bytes and leaves oversized prompts readable without retaining them", async () => {
    const { estimateUserHeight, getTextLayoutCacheStats } = await import("./pretext");
    for (let i = 0; i < 40; i++) estimateUserHeight(`${i} ${"x".repeat(50000)}`, 600);
    expect(getTextLayoutCacheStats().estimatedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(getTextLayoutCacheStats().preparedEntries).toBeLessThan(40);
    const before = getTextLayoutCacheStats();
    const oversized = "y".repeat(2 * 1024 * 1024);
    expect(estimateUserHeight(oversized, 600)).toBeGreaterThan(0);
    expect(getTextLayoutCacheStats()).toEqual(before);
    expect(clearCache).toHaveBeenCalled();
    const calls = prepare.mock.calls.length;
    estimateUserHeight(oversized, 600);
    expect(prepare.mock.calls.length).toBe(calls + 1);
  });
});
