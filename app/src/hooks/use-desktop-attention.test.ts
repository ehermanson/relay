import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@shared/types";
import { useDesktopAttention } from "./use-desktop-attention";

let instances: InstanceInfo[] = [];
let connectionId = 1;
let notifications = true;
const notify = vi.fn(async () => {});
const setActivity = vi.fn(async () => {});
const setBadge = vi.fn(async () => {});
vi.mock("@/context/websocket-context", () => ({
  useWSState: () => ({ instances, connectionId, isConnected: true, isSyncing: false }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { notifications } }),
}));
vi.mock("@/lib/desktop", () => ({ getDesktop: () => ({ notify, setBadge, setActivity }) }));
function chat(status: InstanceInfo["status"], pendingTool?: string): InstanceInfo {
  return {
    id: "chat",
    name: "Fix issue",
    projectSlug: "my project",
    provider: "codex",
    workingDirectory: "/tmp/project",
    createdAt: 0,
    lastActivityAt: 0,
    status,
    pendingTool,
  };
}
beforeEach(() => {
  instances = [];
  connectionId = 1;
  notifications = true;
  notify.mockClear();
  setBadge.mockClear();
  setActivity.mockClear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
});
describe("desktop attention", () => {
  it("does not notify historical state, then notifies a background completion once", () => {
    instances = [chat("processing")];
    const { rerender } = renderHook(() => useDesktopAttention());
    expect(notify).not.toHaveBeenCalled();
    instances = [chat("idle")];
    rerender();
    expect(notify).toHaveBeenCalledWith({
      title: "Fix issue",
      body: "Chat finished responding",
      path: "/projects/my%20project/chats/chat",
    });
    instances = [chat("idle")];
    rerender();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(setBadge).toHaveBeenCalledTimes(1);
    expect(setActivity).toHaveBeenCalledTimes(2);
    expect(setActivity).toHaveBeenLastCalledWith({ running: 0, needsInput: 0, failed: 0 });
  });
  it("badges pending input and notifies only its first transition", () => {
    instances = [chat("processing")];
    const { rerender } = renderHook(() => useDesktopAttention());
    instances = [chat("processing", "Approval")];
    rerender();
    expect(setBadge).toHaveBeenLastCalledWith(1);
    expect(setActivity).toHaveBeenLastCalledWith({ running: 0, needsInput: 1, failed: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    instances = [chat("processing", "Approval")];
    rerender();
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("suppresses reconnect and opted-out notifications", () => {
    instances = [chat("processing")];
    const { rerender } = renderHook(() => useDesktopAttention());
    connectionId++;
    instances = [chat("idle")];
    rerender();
    expect(notify).not.toHaveBeenCalled();
    instances = [chat("processing")];
    rerender();
    notifications = false;
    instances = [chat("idle")];
    rerender();
    expect(notify).not.toHaveBeenCalled();
  });
  it("suppresses notification when the desktop window has focus", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    instances = [chat("processing")];
    const { rerender } = renderHook(() => useDesktopAttention());
    instances = [chat("idle")];
    rerender();
    expect(notify).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
