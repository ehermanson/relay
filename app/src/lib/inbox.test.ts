import { describe, expect, it } from "vitest";
import {
  buildInboxEntries,
  buildInboxProjectOptions,
  capInboxEntries,
  filterInboxEntries,
  isInboxEntryCurrent,
  partitionInboxEntries,
  selectStaleInboxEntries,
  STALE_CHAT_DONE_DAYS,
  type InboxSourceGroup,
} from "./inbox";
import type { InstanceInfo } from "@shared/types";

function chat(overrides: Partial<InstanceInfo> & { id: string }): InstanceInfo {
  return {
    provider: "claude",
    name: overrides.id,
    workingDirectory: "/tmp/project",
    status: "stopped",
    createdAt: 0,
    lastActivityAt: 1000,
    ...overrides,
  } as InstanceInfo;
}

function group(overrides: Partial<InboxSourceGroup> = {}): InboxSourceGroup {
  return {
    dir: "/tmp/project",
    name: "project",
    projectId: "project",
    groupInstances: [],
    ...overrides,
  };
}

describe("buildInboxEntries", () => {
  it("lists every eligible chat as its own row, including former space chats", () => {
    const entries = buildInboxEntries([
      group({
        groupInstances: [
          chat({ id: "one", spaceId: "feature", lastActivityAt: 100 }),
          chat({ id: "two", spaceId: "feature", lastActivityAt: 300 }),
          chat({ id: "standalone", lastActivityAt: 200 }),
        ],
      }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["chat:two", "chat:standalone", "chat:one"]);
  });

  it("decides done from the chat alone", () => {
    const { active, done } = partitionInboxEntries(
      buildInboxEntries([
        group({
          groupInstances: [
            chat({ id: "marked", doneAt: 2000 }),
            chat({ id: "revived", doneAt: 500, lastActivityAt: 1000 }),
          ],
        }),
      ]),
    );
    expect(active.map((entry) => entry.id)).toEqual(["chat:revived"]);
    expect(done.map((entry) => entry.id)).toEqual(["chat:marked"]);
  });

  it("omits attached review chats", () => {
    const entries = buildInboxEntries([
      group({
        groupInstances: [
          chat({ id: "main" }),
          chat({
            id: "review",
            review: { sourceInstanceId: "main", sourceName: "main", scope: "branch" },
          }),
        ],
      }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["chat:main"]);
  });

  it("omits delegated child chats", () => {
    const delegation = { parentInstanceId: "parent", taskId: "t1" };
    const entries = buildInboxEntries([
      group({
        groupInstances: [chat({ id: "parent" }), chat({ id: "child", delegation })],
      }),
    ]);
    expect(entries.map((entry) => entry.instance.id)).toEqual(["parent"]);
  });

  it("sorts by pin then recency", () => {
    const entries = buildInboxEntries([
      group({
        groupInstances: [
          chat({ id: "recent", lastActivityAt: 900 }),
          chat({ id: "pinned", lastActivityAt: 100, pinned: true }),
          chat({ id: "older", lastActivityAt: 800 }),
        ],
      }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["chat:pinned", "chat:recent", "chat:older"]);
  });
});

describe("filter and partition", () => {
  const entries = buildInboxEntries([
    group({ dir: "/a", groupInstances: [chat({ id: "a1", lastActivityAt: 10 })] }),
    group({ dir: "/b", groupInstances: [chat({ id: "b1", lastActivityAt: 20 })] }),
  ]);

  it("filters destinations by project directory", () => {
    expect(filterInboxEntries(entries, null)).toHaveLength(2);
    expect(filterInboxEntries(entries, "/b").map((entry) => entry.id)).toEqual(["chat:b1"]);
  });

  it("orders Done by recency without pins", () => {
    const { done } = partitionInboxEntries(
      buildInboxEntries([
        group({
          groupInstances: [
            chat({ id: "old-pin", pinned: true, lastActivityAt: 100, doneAt: 900 }),
            chat({ id: "new", lastActivityAt: 800, doneAt: 900 }),
          ],
        }),
      ]),
    );
    expect(done.map((entry) => entry.id)).toEqual(["chat:new", "chat:old-pin"]);
  });
});

describe("current destination and caps", () => {
  const entries = buildInboxEntries([
    group({
      groupInstances: [
        chat({ id: "top", lastActivityAt: 300 }),
        chat({ id: "middle", lastActivityAt: 200 }),
        chat({ id: "tail", lastActivityAt: 100 }),
      ],
    }),
  ]);

  it("matches the current chat only", () => {
    expect(isInboxEntryCurrent(entries[1], "middle")).toBe(true);
    expect(isInboxEntryCurrent(entries[1], "top")).toBe(false);
    expect(isInboxEntryCurrent(entries[1])).toBe(false);
  });

  it("retains a current chat below the cap", () => {
    expect(capInboxEntries(entries, 1, "tail").map((entry) => entry.id)).toEqual([
      "chat:top",
      "chat:tail",
    ]);
  });

  it("can retain a current chat from an extra list", () => {
    const [doneChat] = buildInboxEntries([
      group({ groupInstances: [chat({ id: "done", doneAt: 5000 })] }),
    ]);
    expect(
      capInboxEntries(entries.slice(0, 1), 5, "done", [doneChat]).map((entry) => entry.id),
    ).toEqual(["chat:top", "chat:done"]);
  });
});

describe("selectStaleInboxEntries", () => {
  const NOW = 100 * 24 * 60 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const stale = NOW - (STALE_CHAT_DONE_DAYS + 1) * DAY;
  const fresh = NOW - (STALE_CHAT_DONE_DAYS - 1) * DAY;

  it("selects only stale idle chats", () => {
    const entries = buildInboxEntries([
      group({
        groupInstances: [
          chat({ id: "old", lastActivityAt: stale }),
          chat({ id: "recent", lastActivityAt: fresh }),
          chat({ id: "working", status: "processing", lastActivityAt: stale }),
          chat({ id: "unknown", lastActivityAt: undefined }),
        ],
      }),
    ]);

    expect(selectStaleInboxEntries(entries, NOW).map((entry) => entry.instance.id)).toEqual([
      "old",
    ]);
  });

  it("uses the latest message/activity signal and skips done chats", () => {
    const entries = buildInboxEntries([
      group({
        groupInstances: [
          chat({
            id: "messaged",
            lastActivityAt: stale,
            lastMessage: { text: "hi", from: "assistant", timestamp: fresh },
          }),
          chat({ id: "done", lastActivityAt: stale, doneAt: NOW }),
        ],
      }),
    ]);
    expect(selectStaleInboxEntries(entries, NOW)).toEqual([]);
  });
});

describe("buildInboxProjectOptions", () => {
  it("prefers the registered project id, falling back to an instance's", () => {
    const options = buildInboxProjectOptions([
      group({ dir: "/a", name: "alpha", project: { id: "uuid-a" } }),
      group({ dir: "/b", name: "beta", groupInstances: [chat({ id: "b1", projectId: "uuid-b" })] }),
      group({ dir: "/c", name: "gamma" }),
    ]);

    expect(options.map((o) => o.dbId)).toEqual(["uuid-a", "uuid-b", undefined]);
    expect(options.map((o) => o.name)).toEqual(["alpha", "beta", "gamma"]);
  });
});
