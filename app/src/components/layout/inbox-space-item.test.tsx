import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxSpaceItem } from "./inbox-space-item";
import type { InboxSpaceEntry } from "@/lib/inbox";
import type { InstanceInfo } from "@shared/types";

const navigate = vi.fn();
const actions = {
  pinSpace: vi.fn(),
  renameSpace: vi.fn(),
  completeSpace: vi.fn(),
  markSpaceMerged: vi.fn(),
  deleteSpace: vi.fn(),
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...props }: any) => (
    <a href={String(to)} data-params={JSON.stringify(params)} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));
vi.mock("@/context/sidebar-actions-context", () => ({ useSidebarActions: () => actions }));
vi.mock("@/components/ui/tooltip", () => ({ Tooltip: ({ children }: any) => children }));
vi.mock("@/components/ui/project-avatar", () => ({
  ProjectAvatar: ({ name }: { name?: string }) => <span>{name?.slice(0, 1)}</span>,
}));
vi.mock("@/components/ui/terminal-running-indicator", () => ({
  TerminalRunningIndicator: () => null,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: {
    Root: ({ children }: any) => <>{children}</>,
    Content: ({ children }: any) => <div>{children}</div>,
    Title: ({ children }: any) => <h2>{children}</h2>,
  },
}));
vi.mock("@/stores/unread-store", () => ({
  useUnreadStore: (selector: any) => selector({ lastReadAt: { unread: 1 } }),
  selectHasUnread: (state: any, id: string, lastActivityAt: number) =>
    state.lastReadAt[id] !== undefined && lastActivityAt > state.lastReadAt[id],
}));

afterEach(() => {
  cleanup();
  navigate.mockReset();
  Object.values(actions).forEach((action) => action.mockReset());
});

function chat(id: string, name: string, overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id,
    name,
    status: "idle",
    provider: "codex",
    workingDirectory: "/project",
    createdAt: 1,
    lastActivityAt: 2,
    spaceId: "space-1",
    ...overrides,
  };
}

function entry(overrides: Partial<InboxSpaceEntry> = {}): InboxSpaceEntry {
  return {
    kind: "space",
    id: "space:space-1",
    dir: "/project",
    projectName: "Relay",
    projectId: "relay",
    done: false,
    pinned: false,
    recencyAt: 2,
    space: {
      id: "space-1",
      projectDirectory: "/project",
      name: "Inbox navigation",
      gitBranch: "relay/inbox",
      worktreePath: "/worktree",
      isDefault: false,
      status: "active",
      createdAt: 1,
      lastActivityAt: 2,
      chatCount: 2,
    },
    instances: [chat("read", "Quiet chat"), chat("unread", "Unread chat", { lastActivityAt: 3 })],
    workingCount: 0,
    attentionInstances: [],
    ...overrides,
  };
}

describe("InboxSpaceItem", () => {
  it("opens its sole attention chat directly without changing unread siblings", () => {
    const urgent = chat("urgent", "Answer the question", {
      pendingPermission: { requestId: "request", kind: "user_input" },
    });
    const view = render(
      <InboxSpaceItem
        entry={entry({
          instances: [urgent, chat("unread", "Unread chat", { lastActivityAt: 3 })],
          attentionInstances: [urgent],
        })}
        isActive={false}
      />,
    );

    const attention = view.getByRole("link", { name: /open answer the question/i });
    expect(attention.getAttribute("data-params")).toContain('"chatId":"urgent"');
    expect(view.getByText("1 unread")).toBeTruthy();
  });

  it("offers each attention target through a keyboard-operable chooser", async () => {
    const first = chat("first", "Approve release", { pendingTool: "Bash" });
    const second = chat("second", "Reply to design", { pendingPlan: "# Plan" });
    const view = render(
      <InboxSpaceItem entry={entry({ attentionInstances: [first, second] })} isActive={false} />,
    );

    fireEvent.click(view.getByRole("button", { name: /choose one of 2 chats/i }));
    const choice = await view.findByRole("menuitem", { name: /approve release/i });
    expect(view.getByText("Plan needs approval")).toBeTruthy();
    fireEvent.keyDown(choice, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ chatId: "first" }) }),
    );
  });

  it("keeps compact space actions and attention navigation available", async () => {
    const urgent = chat("urgent", "Approve release", { pendingTool: "Bash" });
    const view = render(
      <InboxSpaceItem entry={entry({ attentionInstances: [urgent] })} isActive={false} compact />,
    );

    fireEvent.contextMenu(view.getByRole("link", { name: /open space inbox navigation/i }));
    fireEvent.click(await view.findByRole("menuitem", { name: "Pin" }));
    expect(actions.pinSpace).toHaveBeenCalledWith("space-1", true);
    expect(
      view.getByRole("link", { name: /open approve release/i }).getAttribute("data-params"),
    ).toContain('"chatId":"urgent"');
  });

  it("surfaces a failed chat without mislabeling it as an input request", () => {
    const failed = chat("failed", "Failed build", { status: "error" });
    const view = render(
      <InboxSpaceItem entry={entry({ attentionInstances: [failed] })} isActive={false} />,
    );
    expect(view.getByText("Needs attention")).toBeTruthy();
    expect(
      view.getByRole("link", { name: "Open Failed build: Chat error" }).getAttribute("data-params"),
    ).toContain('"chatId":"failed"');
  });

  it("does not surface obsolete attention on a closed space", () => {
    const urgent = chat("urgent", "Approve release", { pendingTool: "Bash" });
    const view = render(
      <InboxSpaceItem
        entry={entry({
          space: { ...entry().space, status: "completed" },
          done: true,
          attentionInstances: [urgent],
          workingCount: 1,
        })}
        isActive={false}
      />,
    );

    expect(view.queryByText(/need input/i)).toBeNull();
    expect(view.queryByLabelText(/open approve release/i)).toBeNull();
    expect(view.queryByText("1 working")).toBeNull();
  });
});
