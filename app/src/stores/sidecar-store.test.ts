import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSidecarStore, useSidecarPanels } from "./sidecar-store";

function reset() {
  useSidecarStore.setState({
    chatTab: "tasks",
    chatOpen: true,
    sidebarWidth: null,
    mobileOpen: false,
  });
}

describe("useSidecarStore", () => {
  beforeEach(reset);

  describe("selectTab", () => {
    it("switches the active tab and opens the sidecar", () => {
      useSidecarStore.setState({ chatTab: "tasks", chatOpen: false });
      useSidecarStore.getState().selectTab("files");
      const s = useSidecarStore.getState();
      expect(s.chatTab).toBe("files");
      expect(s.chatOpen).toBe(true);
    });

    it("closes the sidecar when clicking the active tab while open", () => {
      useSidecarStore.setState({ chatTab: "tasks", chatOpen: true });
      useSidecarStore.getState().selectTab("tasks");
      const s = useSidecarStore.getState();
      expect(s.chatTab).toBe("tasks"); // preserved
      expect(s.chatOpen).toBe(false);
    });

    it("reopens to the same tab when clicked again after close", () => {
      const { selectTab } = useSidecarStore.getState();
      useSidecarStore.setState({ chatTab: "tasks", chatOpen: true });
      selectTab("tasks"); // close
      selectTab("tasks"); // reopen
      const s = useSidecarStore.getState();
      expect(s.chatTab).toBe("tasks");
      expect(s.chatOpen).toBe(true);
    });

    it("ignores a persisted space scope from older builds", () => {
      localStorage.setItem(
        "relay-sidecar-prefs",
        JSON.stringify({ chatTab: "files", chatOpen: false, spaceTab: "brief", spaceOpen: true }),
      );
      useSidecarStore.getState().selectTab("tasks");
      const stored = JSON.parse(localStorage.getItem("relay-sidecar-prefs") ?? "{}");
      expect(stored).not.toHaveProperty("spaceTab");
      expect(stored).not.toHaveProperty("spaceOpen");
    });
  });

  describe("closeSidecar", () => {
    it("closes the sidecar without changing the remembered tab", () => {
      useSidecarStore.setState({ chatTab: "files", chatOpen: true });
      useSidecarStore.getState().closeSidecar();
      const s = useSidecarStore.getState();
      expect(s.chatOpen).toBe(false);
      expect(s.chatTab).toBe("files");
    });
  });

  describe("setMobileOpen", () => {
    it("sets the global mobile overlay state", () => {
      useSidecarStore.getState().setMobileOpen(true);
      expect(useSidecarStore.getState().mobileOpen).toBe(true);
    });
  });

  describe("setSidebarWidth", () => {
    it("stores the shared sidebar width", () => {
      useSidecarStore.getState().setSidebarWidth(420);
      expect(useSidecarStore.getState().sidebarWidth).toBe(420);
    });
  });
});

describe("useSidecarPanels hook", () => {
  beforeEach(reset);

  it("returns sidecarContentCount based on content flags", () => {
    const { result } = renderHook(() =>
      useSidecarPanels({
        isMobile: false,
        hasTasksContent: true,
        hasFilesContent: true,
        hasPlanContent: false,
        hasStats: true,
      }),
    );
    expect(result.current.sidecarContentCount).toBe(3);
  });

  it("returns allContentPanels based on content flags", () => {
    const { result } = renderHook(() =>
      useSidecarPanels({
        isMobile: false,
        hasTasksContent: true,
        hasFilesContent: false,
        hasPlanContent: true,
        hasStats: false,
      }),
    );
    expect(result.current.allContentPanels.has("tasks")).toBe(true);
    expect(result.current.allContentPanels.has("plan")).toBe(true);
    expect(result.current.allContentPanels.has("files")).toBe(false);
    expect(result.current.allContentPanels.has("context")).toBe(false);
  });

  it("uses the active tab as the effective tab when it has content", () => {
    act(() => useSidecarStore.setState({ chatTab: "tasks", chatOpen: true }));

    const { result } = renderHook(() =>
      useSidecarPanels({
        isMobile: false,
        hasTasksContent: true,
        hasFilesContent: true,
        hasPlanContent: false,
        hasStats: false,
      }),
    );

    expect(result.current.effectiveTab).toBe("tasks");
    expect(result.current.showDesktopSidecar).toBe(true);
  });

  it("falls back to the first content-bearing tab when active has no content", () => {
    act(() => useSidecarStore.setState({ chatTab: "tasks", chatOpen: true }));

    const { result } = renderHook(() =>
      useSidecarPanels({
        isMobile: false,
        hasTasksContent: false,
        hasFilesContent: true,
        hasPlanContent: false,
        hasStats: false,
      }),
    );

    expect(result.current.activeTab).toBe("tasks"); // user intent preserved
    expect(result.current.effectiveTab).toBe("files");
    expect(result.current.showDesktopSidecar).toBe(true);
  });

  it("hides desktop sidecar when nothing has content", () => {
    act(() => useSidecarStore.setState({ chatTab: "tasks", chatOpen: true }));

    const { result } = renderHook(() =>
      useSidecarPanels({
        isMobile: false,
        hasTasksContent: false,
        hasFilesContent: false,
        hasPlanContent: false,
        hasStats: false,
      }),
    );

    expect(result.current.effectiveTab).toBeNull();
    expect(result.current.showDesktopSidecar).toBe(false);
  });

  it("hides desktop sidecar when explicitly closed", () => {
    act(() => useSidecarStore.setState({ chatTab: "tasks", chatOpen: false }));

    const { result } = renderHook(() =>
      useSidecarPanels({
        isMobile: false,
        hasTasksContent: true,
        hasFilesContent: false,
        hasPlanContent: false,
        hasStats: false,
      }),
    );

    expect(result.current.isOpen).toBe(false);
    expect(result.current.showDesktopSidecar).toBe(false);
  });

  it("hides desktop sidecar on mobile", () => {
    act(() => useSidecarStore.setState({ chatTab: "tasks", chatOpen: true }));

    const { result } = renderHook(() =>
      useSidecarPanels({
        isMobile: true,
        hasTasksContent: true,
        hasFilesContent: false,
        hasPlanContent: false,
        hasStats: false,
      }),
    );

    expect(result.current.showDesktopSidecar).toBe(false);
  });

  it("selectTab toggles open/closed when re-clicking the active tab", () => {
    act(() => useSidecarStore.setState({ chatTab: "tasks", chatOpen: true }));

    const { result } = renderHook(() =>
      useSidecarPanels({
        isMobile: false,
        hasTasksContent: true,
        hasFilesContent: false,
        hasPlanContent: false,
        hasStats: false,
      }),
    );

    expect(result.current.showDesktopSidecar).toBe(true);

    act(() => result.current.selectTab("tasks"));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.showDesktopSidecar).toBe(false);
  });
});
