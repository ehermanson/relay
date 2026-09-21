import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentLifecycle, HistoryEntry } from "@shared/types";

vi.mock("@/lib/api", () => ({ fetchAgentHistory: vi.fn() }));

import { fetchAgentHistory } from "@/lib/api";
import { useAgentHistory } from "@/hooks/use-agent-history";

const mockFetch = vi.mocked(fetchAgentHistory);

const AGENT = "agent-1";

/** Minimal attributed child transcript: a leading update + one output. */
function historyWithOutput(text: string): HistoryEntry[] {
  return [
    {
      timestamp: 1,
      message: { type: "agent_update", agent: { agentId: AGENT, relation: "child", name: "x" } },
    },
    {
      timestamp: 2,
      message: { type: "output", instanceId: "i", text, isWaiting: true, agentId: AGENT },
    },
  ];
}

const FINAL_HISTORY = historyWithOutput("done");

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

describe("useAgentHistory lifecycle", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("refetches when an agent completes, so a running-time 404 is not frozen", async () => {
    // While running, the child transcript isn't written yet → 404.
    mockFetch.mockResolvedValueOnce(null);
    const wrapper = makeWrapper();
    const { result, rerender } = renderHook(
      ({ status }: { status: AgentLifecycle }) =>
        useAgentHistory("inst-1", AGENT, { enabled: true, liveItems: [], status }),
      { initialProps: { status: "running" as AgentLifecycle }, wrapper },
    );

    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.items).toEqual([]);

    // Completion flips the terminal discriminator in the query key, forcing a
    // fresh fetch that now returns the finished transcript.
    mockFetch.mockResolvedValueOnce(FINAL_HISTORY);
    rerender({ status: "completed" });

    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.items[0]).toEqual(
      expect.objectContaining({ kind: "assistant", text: "done" }),
    );
    expect(result.current.unavailable).toBe(false);
  });

  it("prefers the fetched terminal transcript over partial replayed live items", async () => {
    // Replayed Claude `agent_progress` live items carry only a tool call — no
    // prose or result — so they must not hide the complete fetched transcript.
    mockFetch.mockResolvedValue(FINAL_HISTORY);
    const partialLive = [
      {
        kind: "activity-group" as const,
        activities: [{ type: "activity", activity: "tool_use" } as never],
      },
    ];
    const { result } = renderHook(
      () =>
        useAgentHistory("inst-1", AGENT, {
          enabled: true,
          liveItems: partialLive,
          status: "completed",
        }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() =>
      expect(result.current.items.some((i) => i.kind === "assistant")).toBe(true),
    );
    expect(result.current.items[0]).toEqual(
      expect.objectContaining({ kind: "assistant", text: "done" }),
    );
  });

  it("prefers the fetched transcript over partial live items while still running", async () => {
    // Reopening a running Claude agent replays tool-call-only `agent_progress`
    // items; the fetched child transcript (with prose) must still win.
    mockFetch.mockResolvedValue(FINAL_HISTORY);
    const partialLive = [
      {
        kind: "activity-group" as const,
        activities: [{ type: "activity", activity: "tool_use" } as never],
      },
    ];
    const { result } = renderHook(
      () =>
        useAgentHistory("inst-1", AGENT, {
          enabled: true,
          liveItems: partialLive,
          status: "running",
        }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() =>
      expect(result.current.items.some((i) => i.kind === "assistant")).toBe(true),
    );
    expect(result.current.items[0]).toEqual(
      expect.objectContaining({ kind: "assistant", text: "done" }),
    );
  });

  it.each(["running", "completed"] as const)(
    "keeps earlier fetched prose after joining mid-run (%s)",
    async (status) => {
      mockFetch.mockResolvedValue([
        ...historyWithOutput("Earlier investigation."),
        {
          timestamp: 3,
          message: {
            type: "output",
            instanceId: "i",
            agentId: AGENT,
            text: "Final report.",
            isWaiting: true,
          },
        },
      ]);
      const { result } = renderHook(
        () =>
          useAgentHistory("i", AGENT, {
            enabled: true,
            status,
            liveItems: [{ kind: "assistant", text: "Final report." }],
          }),
        { wrapper: makeWrapper() },
      );
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.items.filter((i) => i.kind === "assistant").map((i) => i.text)).toEqual(
        ["Earlier investigation.", "Final report."],
      );
    },
  );

  it("keeps live prose that extends the fetched transcript across different message boundaries", async () => {
    mockFetch.mockResolvedValue(historyWithOutput("Earlier investigation."));
    const liveItems = [{ kind: "assistant" as const, text: "Earlier investigation.Final report." }];
    const { result } = renderHook(
      () =>
        useAgentHistory("i", AGENT, {
          enabled: true,
          status: "running",
          liveItems,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toBe(liveItems);
  });

  it("keeps live text when the child transcript is unavailable", async () => {
    mockFetch.mockResolvedValue(null);
    const liveItems = [{ kind: "assistant" as const, text: "Still available live." }];
    const { result } = renderHook(
      () =>
        useAgentHistory("i", AGENT, {
          enabled: true,
          status: "completed",
          liveItems,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.items).toBe(liveItems);
  });

  it("refetches the final transcript when a completed agent is resumed and completes again", async () => {
    // completed → running → completed returns to the terminal key; the second
    // completion (new `revision`) must fetch fresh, not serve the first's
    // indefinitely-cached snapshot.
    mockFetch.mockResolvedValueOnce(historyWithOutput("first result"));
    const wrapper = makeWrapper();
    const { result, rerender } = renderHook(
      ({ status, revision }: { status: AgentLifecycle; revision: number }) =>
        useAgentHistory("inst-1", AGENT, { enabled: true, liveItems: [], status, revision }),
      { initialProps: { status: "completed" as AgentLifecycle, revision: 1 }, wrapper },
    );

    await waitFor(() =>
      expect(result.current.items.some((i) => i.kind === "assistant")).toBe(true),
    );
    expect(result.current.items[0]).toEqual(expect.objectContaining({ text: "first result" }));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Resume: back to running (live key), then a fresh completion with a new
    // revision.
    mockFetch.mockResolvedValueOnce(historyWithOutput("second result"));
    rerender({ status: "running", revision: 1 });
    mockFetch.mockResolvedValueOnce(historyWithOutput("second result"));
    rerender({ status: "completed", revision: 2 });

    await waitFor(() =>
      expect(
        result.current.items.some((i) => i.kind === "assistant" && i.text === "second result"),
      ).toBe(true),
    );
    expect(result.current.items[0]).toEqual(expect.objectContaining({ text: "second result" }));
  });
});
