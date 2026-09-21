import { describe, expect, it } from "vitest";
import {
  buildInboxEntries,
  buildInboxProjectOptions,
  capInboxEntries,
  filterInboxEntries,
  isInboxEntryCurrent,
  partitionInboxEntries,
  resolveNewMenuShape,
  selectStaleInboxEntries,
  STALE_CHAT_DONE_DAYS,
  type InboxChatEntry,
  type InboxProjectOption,
  type InboxSourceGroup,
  type InboxSpaceEntry,
} from "./inbox";
import type { InstanceInfo, SpaceInfo } from "@shared/types";

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

function space(overrides: Partial<SpaceInfo> & { id: string }): SpaceInfo {
  return {
    name: overrides.id,
    projectDirectory: "/tmp/project",
    status: "active",
    isDefault: false,
    createdAt: 10,
    lastActivityAt: 10,
    ...overrides,
  } as SpaceInfo;
}

function group(overrides: Partial<InboxSourceGroup> = {}): InboxSourceGroup {
  return {
    dir: "/tmp/project",
    name: "project",
    projectId: "project",
    groupInstances: [],
    spaces: [],
    ...overrides,
  };
}

function chatEntries(entries: ReturnType<typeof buildInboxEntries>): InboxChatEntry[] {
  return entries.filter((entry): entry is InboxChatEntry => entry.kind === "chat");
}

function spaceEntries(entries: ReturnType<typeof buildInboxEntries>): InboxSpaceEntry[] {
  return entries.filter((entry): entry is InboxSpaceEntry => entry.kind === "space");
}

describe("buildInboxEntries", () => {
  it("groups every eligible chat in a named space into one destination", () => {
    const entries = buildInboxEntries([
      group({
        groupInstances: [
          chat({ id: "one", spaceId: "feature", lastActivityAt: 100 }),
          chat({ id: "two", spaceId: "feature", lastActivityAt: 300 }),
          chat({ id: "standalone", lastActivityAt: 200 }),
        ],
        spaces: [space({ id: "feature", name: "Feature" })],
      }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["space:feature", "chat:standalone"]);
    expect(spaceEntries(entries)[0].instances.map((instance) => instance.id)).toEqual([
      "one",
      "two",
    ]);
    expect(spaceEntries(entries)[0].recencyAt).toBe(300);
  });

  it("keeps default-space and unresolved-space chats as individual rows", () => {
    const entries = buildInboxEntries([
      group({
        groupInstances: [
          chat({ id: "main", spaceId: "default" }),
          chat({ id: "loading", spaceId: "not-loaded" }),
        ],
        spaces: [space({ id: "default", isDefault: true })],
      }),
    ]);

    expect(chatEntries(entries).map((entry) => entry.instance.id)).toEqual(["loading", "main"]);
    expect(chatEntries(entries).find((entry) => entry.instance.id === "main")?.space?.id).toBe(
      "default",
    );
  });

  it("includes empty and broken named spaces in Active", () => {
    const entries = buildInboxEntries([
      group({ spaces: [space({ id: "empty" }), space({ id: "broken", status: "broken" })] }),
    ]);
    const { active, done } = partitionInboxEntries(entries);

    expect(active.map((entry) => entry.id)).toEqual(["space:broken", "space:empty"]);
    expect(spaceEntries(active).every((entry) => entry.instances.length === 0)).toBe(true);
    expect(done).toEqual([]);
  });

  it("puts completed and archived spaces in Done exactly once", () => {
    const entries = buildInboxEntries([
      group({
        groupInstances: [chat({ id: "merged-chat", spaceId: "merged" })],
        spaces: [
          space({ id: "merged", status: "completed", lastActivityAt: 200 }),
          space({ id: "archived", status: "archived", lastActivityAt: 100 }),
        ],
      }),
    ]);
    const { active, done } = partitionInboxEntries(entries);

    expect(active).toEqual([]);
    expect(done.map((entry) => entry.id)).toEqual(["space:merged", "space:archived"]);
  });

  it("keeps an active space active when every child chat is done", () => {
    const [entry] = buildInboxEntries([
      group({
        groupInstances: [chat({ id: "done-child", spaceId: "work", doneAt: 2000 })],
        spaces: [space({ id: "work" })],
      }),
    ]);
    expect(entry.kind).toBe("space");
    expect(entry.done).toBe(false);
  });

  it("omits attached review chats from rows and space counts", () => {
    const [entry] = buildInboxEntries([
      group({
        groupInstances: [
          chat({ id: "main", spaceId: "work" }),
          chat({
            id: "review",
            spaceId: "work",
            review: { sourceInstanceId: "main", sourceName: "main", scope: "branch" },
          }),
        ],
        spaces: [space({ id: "work" })],
      }),
    ]);
    expect(entry.kind === "space" && entry.instances.map((instance) => instance.id)).toEqual([
      "main",
    ]);
  });

  it("sorts by independent destination pin then aggregate recency", () => {
    const pinnedSpace = Object.assign(space({ id: "pinned", lastActivityAt: 1 }), { pinned: true });
    const entries = buildInboxEntries([
      group({
        groupInstances: [
          chat({ id: "recent", lastActivityAt: 900 }),
          chat({ id: "space-chat", spaceId: "plain", lastActivityAt: 800, pinned: true }),
        ],
        spaces: [pinnedSpace, space({ id: "plain", lastActivityAt: 2 })],
      }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual([
      "space:pinned",
      "chat:recent",
      "space:plain",
    ]);
    expect(spaceEntries(entries).find((entry) => entry.space.id === "plain")?.pinned).toBe(false);
  });

  it("counts normalized attention ahead of working across providers", () => {
    const request = { requestId: "request", kind: "user_input", questions: [] } as NonNullable<
      InstanceInfo["pendingPermission"]
    >;
    const [entry] = buildInboxEntries([
      group({
        groupInstances: [
          chat({
            id: "claude-question",
            provider: "claude",
            spaceId: "work",
            status: "processing",
            pendingPermission: request,
          }),
          chat({
            id: "codex-approval",
            provider: "codex",
            spaceId: "work",
            status: "processing",
            pendingTool: "shell",
          }),
          chat({
            id: "plan",
            provider: "codex",
            spaceId: "work",
            status: "processing",
            pendingPlan: "plan",
          }),
          chat({ id: "failed", provider: "codex", spaceId: "work", status: "error" }),
          chat({ id: "working", provider: "claude", spaceId: "work", status: "processing" }),
          chat({
            id: "stopped-request",
            spaceId: "work",
            status: "stopped",
            pendingPermission: request,
          }),
        ],
        spaces: [space({ id: "work" })],
      }),
    ]);
    expect(entry.kind).toBe("space");
    if (entry.kind !== "space") throw new Error("expected space");
    expect(entry.attentionInstances.map((instance) => instance.id)).toEqual([
      "claude-question",
      "codex-approval",
      "plan",
      "failed",
    ]);
    expect(entry.workingCount).toBe(1);
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
        chat({ id: "member", spaceId: "work", lastActivityAt: 200 }),
        chat({ id: "tail", lastActivityAt: 100 }),
      ],
      spaces: [space({ id: "work" })],
    }),
  ]);

  it("keeps a space selected while switching among member chats", () => {
    const grouped = entries.find((entry) => entry.kind === "space")!;
    expect(isInboxEntryCurrent(grouped, "member")).toBe(true);
    expect(isInboxEntryCurrent(grouped, undefined, "work")).toBe(true);
  });

  it("retains a current space below the cap", () => {
    expect(capInboxEntries(entries, 1, "member").map((entry) => entry.id)).toEqual([
      "chat:top",
      "space:work",
    ]);
  });

  it("can retain a current closed or empty space from an extra list", () => {
    const [closed] = buildInboxEntries([
      group({ spaces: [space({ id: "closed", status: "archived" })] }),
    ]);
    expect(
      capInboxEntries(entries.slice(0, 1), 5, undefined, "closed", [closed]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["chat:top", "space:closed"]);
  });
});

describe("selectStaleInboxEntries", () => {
  const NOW = 100 * 24 * 60 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const stale = NOW - (STALE_CHAT_DONE_DAYS + 1) * DAY;
  const fresh = NOW - (STALE_CHAT_DONE_DAYS - 1) * DAY;

  it("selects only stale standalone chats", () => {
    const entries = buildInboxEntries([
      group({
        groupInstances: [
          chat({ id: "old", lastActivityAt: stale }),
          chat({ id: "recent", lastActivityAt: fresh }),
          chat({ id: "space-old", spaceId: "work", lastActivityAt: stale }),
          chat({ id: "unresolved-space-old", spaceId: "loading", lastActivityAt: stale }),
          chat({ id: "working", status: "processing", lastActivityAt: stale }),
          chat({ id: "unknown", lastActivityAt: undefined }),
        ],
        spaces: [space({ id: "work" })],
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

  it("marks only registered-project groups space-capable", () => {
    const options = buildInboxProjectOptions([
      group({ dir: "/a", project: { id: "uuid-a" } }),
      // A session-only group (an instance carries a route id, but no registered
      // project) still can't back a space.
      group({ dir: "/b", groupInstances: [chat({ id: "b1", projectId: "uuid-b" })] }),
    ]);

    expect(options.map((o) => o.spaceCapable)).toEqual([true, false]);
  });
});

describe("resolveNewMenuShape", () => {
  function option(overrides: Partial<InboxProjectOption> & { dir: string }): InboxProjectOption {
    return {
      name: overrides.dir,
      projectId: overrides.dir,
      spaceCapable: true,
      ...overrides,
    };
  }

  const alpha = option({ dir: "/a" });
  const beta = option({ dir: "/b" });
  const sessionOnly = option({ dir: "/s", spaceCapable: false });

  it("direct-creates a chat for a lone target when space is disabled", () => {
    expect(resolveNewMenuShape([alpha], "/a", false)).toEqual({ kind: "chat-direct", dir: "/a" });
  });

  it("offers a chat picker for multiple targets when space is disabled", () => {
    expect(resolveNewMenuShape([alpha, beta], null, false)).toEqual({
      kind: "chat-picker",
      chatProjects: [alpha, beta],
    });
  });

  it("combines chat and space for a lone space-capable target", () => {
    expect(resolveNewMenuShape([alpha], "/a", true)).toEqual({
      kind: "combined-direct",
      dir: "/a",
    });
  });

  it("falls back to chat-direct for a lone target that cannot back a space", () => {
    expect(resolveNewMenuShape([sessionOnly], "/s", true)).toEqual({
      kind: "chat-direct",
      dir: "/s",
    });
  });

  it("scopes the space picker to space-capable targets", () => {
    expect(resolveNewMenuShape([alpha, sessionOnly], null, true)).toEqual({
      kind: "combined-picker",
      chatProjects: [alpha, sessionOnly],
      spaceProjects: [alpha],
    });
  });

  it("falls back to a chat picker when no target can back a space", () => {
    expect(resolveNewMenuShape([sessionOnly], null, true)).toEqual({
      kind: "chat-picker",
      chatProjects: [sessionOnly],
    });
  });
});
