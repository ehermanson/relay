import { describe, expect, it } from "vitest";
import {
  getContextWindowUsage,
  getDisplaySessionStats,
  getDisplayTokenBreakdown,
  isChatDone,
  toggleAnswerSelection,
} from "./utils";

describe("toggleAnswerSelection", () => {
  it("replaces the prior choice for single-select questions", () => {
    expect(toggleAnswerSelection(["A"], "B", false)).toEqual(["B"]);
    expect(toggleAnswerSelection(undefined, "A", undefined)).toEqual(["A"]);
  });

  it("keeps the choice when a single-select option is re-clicked (radio behavior)", () => {
    expect(toggleAnswerSelection(["A"], "A", false)).toEqual(["A"]);
  });

  it("adds an option to the set for multi-select questions", () => {
    expect(toggleAnswerSelection(["A"], "B", true)).toEqual(["A", "B"]);
    expect(toggleAnswerSelection(undefined, "A", true)).toEqual(["A"]);
  });

  it("removes an already-selected option for multi-select questions", () => {
    expect(toggleAnswerSelection(["A", "B"], "A", true)).toEqual(["B"]);
    expect(toggleAnswerSelection(["A"], "A", true)).toEqual([]);
  });
});

describe("isChatDone", () => {
  it("is false for a chat that was never marked done", () => {
    expect(isChatDone({ lastActivityAt: 1000 })).toBe(false);
  });

  it("is true while the chat has no activity past the marker", () => {
    expect(isChatDone({ doneAt: 2000, lastActivityAt: 1000 })).toBe(true);
    expect(isChatDone({ doneAt: 2000, lastActivityAt: 2000 })).toBe(true);
  });

  it("revives the chat once activity lands after the marker", () => {
    expect(isChatDone({ doneAt: 2000, lastActivityAt: 2001 })).toBe(false);
  });

  it("uses the last message timestamp when it is newer than lastActivityAt", () => {
    expect(
      isChatDone({
        doneAt: 2000,
        lastActivityAt: 1000,
        lastMessage: { text: "hi", from: "assistant", timestamp: 3000 },
      }),
    ).toBe(false);
  });

  it("revives on lastActivityAt even when the last message is stale", () => {
    // Tool-only activity bumps lastActivityAt without producing a message —
    // recency is the max of both signals, not a fallback chain.
    expect(
      isChatDone({
        doneAt: 2000,
        lastActivityAt: 3000,
        lastMessage: { text: "hi", from: "assistant", timestamp: 1000 },
      }),
    ).toBe(false);
  });

  it("keeps chats in closed spaces done regardless of activity", () => {
    expect(isChatDone({ lastActivityAt: 9999 }, "completed")).toBe(true);
    expect(isChatDone({ lastActivityAt: 9999 }, "archived")).toBe(true);
    expect(isChatDone({ lastActivityAt: 9999 }, "active")).toBe(false);
  });
});

describe("token display normalization", () => {
  it("keeps Claude input tokens unchanged", () => {
    expect(
      getDisplaySessionStats("claude", {
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 50,
        cacheReadTokens: 300,
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 50,
      cacheReadTokens: 300,
      totalTokens: 1550,
    });
  });

  it("subtracts Codex cache reads from displayed input totals", () => {
    expect(
      getDisplaySessionStats("codex", {
        inputTokens: 2300000,
        outputTokens: 16700,
        cacheCreationTokens: 142800,
        cacheReadTokens: 2200000,
      }),
    ).toEqual({
      inputTokens: 100000,
      outputTokens: 16700,
      cacheCreationTokens: 142800,
      cacheReadTokens: 2200000,
      totalTokens: 2459500,
    });
  });

  it("normalizes model usage totals for Codex", () => {
    expect(
      getDisplayTokenBreakdown({
        providerName: "codex",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 200,
      }),
    ).toEqual({
      inputTokens: 800,
      outputTokens: 500,
      cacheTokens: 200,
      totalTokens: 1500,
    });
  });

  it("clamps context usage to the reported window", () => {
    expect(
      getContextWindowUsage({
        contextTokens: 1200000,
        contextWindow: 1000000,
      }),
    ).toEqual({
      contextTokens: 1000000,
      contextWindow: 1000000,
      usagePct: 100,
    });
  });
});
