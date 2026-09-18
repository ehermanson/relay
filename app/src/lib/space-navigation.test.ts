// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@shared/types";
import type { InboxSpaceEntry } from "@/lib/inbox";
import {
  getInboxSpaceRoute,
  readLastSpaceChat,
  rememberSpaceChat,
  selectSpaceChat,
} from "./space-navigation";

const chat = (id: string, overrides: Partial<InstanceInfo> = {}): InstanceInfo => ({
  id,
  name: id,
  provider: "codex",
  status: "stopped",
  workingDirectory: "/project",
  createdAt: 1,
  lastActivityAt: 10,
  spaceId: "space",
  ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  });
});

describe("space chat navigation", () => {
  it("restores a valid remembered chat even when another has newer activity", () => {
    const chats = [chat("old"), chat("new", { lastActivityAt: 20 })];
    rememberSpaceChat("space", "old");
    expect(selectSpaceChat("space", chats, readLastSpaceChat("space"))).toBe("old");
    expect(readLastSpaceChat("other-space")).toBeNull();
  });

  it("falls back by message/tool recency without changing tab order", () => {
    const chats = [
      chat("first"),
      chat("message", { lastMessage: { text: "done", from: "assistant", timestamp: 50 } }),
      chat("tool", { lastActivityAt: 60 }),
    ];
    expect(selectSpaceChat("space", chats, "deleted")).toBe("tool");
    expect(chats.map((c) => c.id)).toEqual(["first", "message", "tool"]);
  });

  it("rejects remembered reviews and chats belonging to another space", () => {
    const chats = [
      chat("normal"),
      chat("review", {
        lastActivityAt: 100,
        review: { sourceInstanceId: "normal", sourceName: "normal", scope: "branch" },
      }),
      chat("foreign", { spaceId: "other", lastActivityAt: 200 }),
    ];
    expect(selectSpaceChat("space", chats, "review")).toBe("normal");
    expect(selectSpaceChat("space", chats, "foreign")).toBe("normal");
    expect(selectSpaceChat("empty", chats, "normal")).toBeUndefined();
  });

  it("explicit attention links override remembered selection; empty spaces open without a chat", () => {
    const entry = {
      projectId: "project",
      space: { id: "space" },
      instances: [chat("old"), chat("attention")],
    } as InboxSpaceEntry;
    rememberSpaceChat("space", "old");
    expect(getInboxSpaceRoute(entry).params).toEqual({
      projectId: "project",
      spaceId: "space",
      chatId: "old",
    });
    expect(getInboxSpaceRoute(entry, "attention").params).toEqual({
      projectId: "project",
      spaceId: "space",
      chatId: "attention",
    });
    expect(getInboxSpaceRoute({ ...entry, instances: [] }).params).toEqual({
      projectId: "project",
      spaceId: "space",
    });
  });

  it("works when browser storage is unavailable", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberSpaceChat("space", "chat")).not.toThrow();
    expect(readLastSpaceChat("space")).toBeNull();
    expect(selectSpaceChat("space", [chat("chat")], readLastSpaceChat("space"))).toBe("chat");
  });
});
