import { createElement, StrictMode, useEffect, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getInstanceMessagesCacheStats, useInstanceMessages } from "./use-instance-messages";

function load(hook: ReturnType<typeof useInstanceMessages>, id: string, text = "history") {
  hook.handleMessage(id, {
    type: "instance_history",
    instanceId: id,
    history: [{ timestamp: 1, message: { type: "user", instanceId: id, text } }],
    replayMode: "full",
    latestSequence: 2,
    replayEpoch: 7,
  });
}
describe("Chat history retention", () => {
  it("balances active ownership across StrictMode mount replay and unmount", () => {
    const before = getInstanceMessagesCacheStats().activeChats;
    const { result, unmount } = renderHook(
      () => {
        const hook = useInstanceMessages();
        useEffect(() => {
          hook.setInstanceId("cache-strict");
          return () => hook.setInstanceId(null);
        }, [hook.setInstanceId]);
        return hook;
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, {}, children),
      },
    );
    expect(getInstanceMessagesCacheStats().activeChats).toBe(before + 1);
    act(() => load(result.current, "cache-strict"));
    unmount();
    expect(getInstanceMessagesCacheStats().activeChats).toBe(before);
  });
  it("uses the latest active cursor after a cached Chat resumes receiving output", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("cache-cursor"));
    act(() => load(result.current, "cache-cursor"));
    act(() => result.current.setInstanceId("other-cursor"));
    act(() => {
      result.current.setInstanceId("cache-cursor");
      // Cursor is needed by the subscription effect before the restore render.
      expect(result.current.getReplayCursor("cache-cursor")).toEqual({
        lastSeenSequence: 2,
        replayEpoch: 7,
      });
    });
    act(() =>
      result.current.handleMessage("cache-cursor", {
        type: "output",
        instanceId: "cache-cursor",
        text: "new response",
        isWaiting: true,
        eventSequence: 3,
      }),
    );
    expect(result.current.getReplayCursor("cache-cursor")).toEqual({
      lastSeenSequence: 3,
      replayEpoch: 7,
    });
    expect(result.current.rawHistory).toHaveLength(2);
  });
  it("drops oversized inactive history but keeps it complete while the Chat is open", () => {
    const { result } = renderHook(() => useInstanceMessages());
    const text = "x".repeat(9 * 1024 * 1024);
    act(() => result.current.setInstanceId("cache-oversized"));
    act(() => load(result.current, "cache-oversized", text));
    expect(result.current.rawHistory?.[0].message).toMatchObject({ text });
    act(() => result.current.setInstanceId("other-oversized"));
    expect(getInstanceMessagesCacheStats().estimatedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    act(() => result.current.setInstanceId("cache-oversized"));
    expect(result.current.hasLoadedHistory).toBe(false);
    expect(result.current.rawHistory).toBeNull();
    expect(result.current.getReplayCursor("cache-oversized")).toBeUndefined();
    act(() => load(result.current, "cache-oversized", "reloaded from canonical history"));
    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "reloaded from canonical history" }),
    ]);
  });
  it("releases incomplete raw buffers when navigating away in the replay commit", () => {
    const before = getInstanceMessagesCacheStats().rawHistoryBuffers;
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("cache-incomplete"));
    act(() => {
      load(result.current, "cache-incomplete");
      result.current.setInstanceId("other-incomplete");
    });
    expect(getInstanceMessagesCacheStats().rawHistoryBuffers).toBe(before);
  });
  it("protects another open view's raw history from oversized snapshot eviction", () => {
    const first = renderHook(() => useInstanceMessages());
    const second = renderHook(() => useInstanceMessages());
    act(() => first.result.current.setInstanceId("cache-shared"));
    act(() => load(first.result.current, "cache-shared", "x".repeat(9 * 1024 * 1024)));
    act(() => second.result.current.setInstanceId("cache-shared"));
    act(() => load(second.result.current, "cache-shared", "x".repeat(9 * 1024 * 1024)));
    act(() => first.result.current.setInstanceId(null));
    expect(second.result.current.rawHistory).toHaveLength(1);
    second.unmount();
    expect(getInstanceMessagesCacheStats().estimatedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
