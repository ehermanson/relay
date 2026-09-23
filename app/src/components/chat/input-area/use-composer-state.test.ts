import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useComposerState } from "./use-composer-state";
import { createRef } from "react";
import type { ComposerEditorHandle } from "../composer-editor";

function makeRef() {
  return createRef<ComposerEditorHandle>();
}

describe("useComposerState – draft persistence", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, String(value));
        },
        removeItem: (key: string) => {
          values.delete(key);
        },
        clear: () => values.clear(),
        get length() {
          return values.size;
        },
      },
    });
    sessionStorage.clear();
  });

  it("persists draft to window.localStorage on updateDraft", () => {
    const ref = makeRef();
    const { result } = renderHook(() => useComposerState("instance-1", ref));

    act(() => result.current.updateDraft("hello world"));

    expect(result.current.draftText).toBe("hello world");
    expect(window.localStorage.getItem("relay:draft:instance-1")).toBe("hello world");
  });

  it("restores draft from window.localStorage on mount", () => {
    window.localStorage.setItem("relay:draft:instance-1", "saved draft");

    const ref = makeRef();
    const { result } = renderHook(() => useComposerState("instance-1", ref));

    expect(result.current.draftText).toBe("saved draft");
    expect(result.current.pendingSelectionOffset).toBe("saved draft".length);
  });

  it("restores draft when draftKey changes (simulating route change back)", () => {
    window.localStorage.setItem("relay:draft:instance-1", "draft for chat 1");
    window.localStorage.setItem("relay:draft:instance-2", "draft for chat 2");

    const ref = makeRef();
    let draftKey = "instance-1";
    const { result, rerender } = renderHook(() => useComposerState(draftKey, ref));

    expect(result.current.draftText).toBe("draft for chat 1");

    // Simulate navigating to a different chat
    draftKey = "instance-2";
    rerender();

    expect(result.current.draftText).toBe("draft for chat 2");

    // Navigate back — draft should still be there
    draftKey = "instance-1";
    rerender();

    expect(result.current.draftText).toBe("draft for chat 1");
  });

  it("clears draft from window.localStorage on resetAfterSend", () => {
    const ref = makeRef();
    const { result } = renderHook(() => useComposerState("instance-1", ref));

    act(() => result.current.updateDraft("about to send"));
    expect(window.localStorage.getItem("relay:draft:instance-1")).toBe("about to send");

    act(() => result.current.resetAfterSend());

    expect(result.current.draftText).toBe("");
    expect(window.localStorage.getItem("relay:draft:instance-1")).toBeNull();
  });

  it("does not persist when draftKey is undefined", () => {
    const ref = makeRef();
    const { result } = renderHook(() => useComposerState(undefined, ref));

    act(() => result.current.updateDraft("orphan text"));

    expect(result.current.draftText).toBe("orphan text");
    // Nothing should be written to window.localStorage
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps separate drafts per instance", () => {
    const ref = makeRef();
    const { result: r1 } = renderHook(() => useComposerState("instance-a", ref));
    const { result: r2 } = renderHook(() => useComposerState("instance-b", ref));

    act(() => r1.current.updateDraft("draft A"));
    act(() => r2.current.updateDraft("draft B"));

    expect(window.localStorage.getItem("relay:draft:instance-a")).toBe("draft A");
    expect(window.localStorage.getItem("relay:draft:instance-b")).toBe("draft B");
  });

  it("removes window.localStorage entry when draft is cleared to empty string", () => {
    const ref = makeRef();
    const { result } = renderHook(() => useComposerState("instance-1", ref));

    act(() => result.current.updateDraft("some text"));
    expect(window.localStorage.getItem("relay:draft:instance-1")).toBe("some text");

    act(() => result.current.updateDraft(""));
    expect(window.localStorage.getItem("relay:draft:instance-1")).toBeNull();
  });

  it("loads a seeded legacy session draft and removes it after send", () => {
    sessionStorage.setItem("relay:draft:instance-1", "seeded prompt");
    const ref = makeRef();
    const { result } = renderHook(() => useComposerState("instance-1", ref));
    expect(result.current.draftText).toBe("seeded prompt");
    act(() => result.current.resetAfterSend());
    expect(sessionStorage.getItem("relay:draft:instance-1")).toBeNull();
  });

  it("does not resurrect a seeded session draft after the user clears it", () => {
    sessionStorage.setItem("relay:draft:instance-1", "seeded prompt");
    const ref = makeRef();
    const { result, unmount } = renderHook(() => useComposerState("instance-1", ref));
    act(() => result.current.updateDraft(""));
    expect(sessionStorage.getItem("relay:draft:instance-1")).toBeNull();
    unmount();
    const remount = renderHook(() => useComposerState("instance-1", ref));
    expect(remount.result.current.draftText).toBe("");
  });
});
