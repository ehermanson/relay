import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopCommands } from "./desktop-commands";
import type { DesktopCommand } from "@/lib/desktop";
let callback: ((command: DesktopCommand) => void) | undefined;
const unsubscribe = vi.fn();
const navigate = vi.fn();
const createNewChat = vi.fn();
vi.mock("@/lib/desktop", () => ({
  getDesktop: () => ({
    onCommand: (handler: typeof callback) => {
      callback = handler;
      return unsubscribe;
    },
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/hooks/use-sidebar-navigation-controller", () => ({
  useSidebarNavigationController: () => ({
    registeredDirs: new Set(),
    currentProjectId: "project",
    projectEntries: [{ projectId: "project", dir: "/project", name: "Project" }],
    createNewChat,
  }),
}));
vi.mock("@/components/layout/sidebar-chrome", () => ({ AddProjectDialog: () => null }));
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  callback = undefined;
});
describe("desktop commands", () => {
  it("reuses search, sidebar, settings and current Project chat actions", () => {
    const onSearch = vi.fn();
    const onToggleSidebar = vi.fn();
    render(<DesktopCommands onSearch={onSearch} onToggleSidebar={onToggleSidebar} />);
    act(() => {
      callback?.("search");
      callback?.("toggle-sidebar");
      callback?.("settings");
      callback?.("new-chat");
    });
    expect(onSearch).toHaveBeenCalledOnce();
    expect(onToggleSidebar).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ to: "/settings/general" });
    expect(createNewChat).toHaveBeenCalledWith("/project");
  });
  it("cleans up the native event listener when the window layout unmounts", () => {
    const { unmount } = render(<DesktopCommands onSearch={() => {}} onToggleSidebar={() => {}} />);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
