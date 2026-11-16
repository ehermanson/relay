import { describe, expect, it } from "vitest";
import type { InboxEntry } from "./inbox";
import {
  buildWorkstreamFolders,
  capWorkstreamEntries,
  excludeFolderedEntries,
  getWorkstreamAccent,
  WORKSTREAM_FOLDER_LIMIT,
} from "./workstreams";
import type { InstanceInfo, Workstream } from "@shared/types";

function entry(
  id: string,
  overrides: Partial<InboxEntry> = {},
  instance: Partial<InstanceInfo> = {},
) {
  return {
    id: `chat:${id}`,
    instance: {
      id,
      provider: "claude",
      name: id,
      workingDirectory: "/tmp/project",
      status: "stopped",
      createdAt: 0,
      lastActivityAt: 1000,
      ...instance,
    } as InstanceInfo,
    dir: "/tmp/project",
    projectName: "project",
    projectId: "project",
    done: false,
    pinned: false,
    recencyAt: 1000,
    ...overrides,
  } satisfies InboxEntry;
}

function workstream(id: string, name: string, status: Workstream["status"] = "active"): Workstream {
  return { id, accountId: "default", name, status, createdAt: 0, updatedAt: 0 };
}

describe("buildWorkstreamFolders", () => {
  it("groups member chats and splits active from done", () => {
    const folders = buildWorkstreamFolders(
      [workstream("w1", "GraphQL")],
      { a: "w1", b: "w1", c: "other" },
      [entry("a"), entry("b", { done: true, recencyAt: 5 }), entry("c"), entry("d")],
    );
    expect(folders).toHaveLength(1);
    expect(folders[0].active.map((e) => e.instance.id)).toEqual(["a"]);
    expect(folders[0].done.map((e) => e.instance.id)).toEqual(["b"]);
  });

  it("orders folders by name and hides done workstreams", () => {
    const folders = buildWorkstreamFolders(
      [workstream("w1", "zeta"), workstream("w2", "Alpha"), workstream("w3", "gone", "done")],
      {},
      [],
    );
    expect(folders.map((f) => f.workstream.name)).toEqual(["Alpha", "zeta"]);
  });

  it("keeps the given order for active chats and sorts done by recency", () => {
    const folders = buildWorkstreamFolders(
      [workstream("w1", "GraphQL")],
      { a: "w1", b: "w1", c: "w1", d: "w1" },
      [
        entry("a"),
        entry("b"),
        entry("c", { done: true, recencyAt: 1 }),
        entry("d", { done: true, recencyAt: 9 }),
      ],
    );
    expect(folders[0].active.map((e) => e.instance.id)).toEqual(["a", "b"]);
    expect(folders[0].done.map((e) => e.instance.id)).toEqual(["d", "c"]);
  });

  it("counts chats waiting on the user separately from working ones", () => {
    const folders = buildWorkstreamFolders(
      [workstream("w1", "GraphQL")],
      { a: "w1", b: "w1", c: "w1" },
      [entry("a", {}, { status: "processing" }), entry("b", {}, { status: "error" }), entry("c")],
    );
    expect(folders[0].attention).toBe(1);
    expect(folders[0].running).toBe(1);
  });
});

describe("capWorkstreamEntries", () => {
  const active = Array.from({ length: WORKSTREAM_FOLDER_LIMIT + 3 }, (_, i) => entry(`c${i}`));

  it("caps the list and shows everything once expanded", () => {
    expect(capWorkstreamEntries({ active }, false)).toHaveLength(WORKSTREAM_FOLDER_LIMIT);
    expect(capWorkstreamEntries({ active }, true)).toHaveLength(active.length);
  });

  it("never hides the open chat behind the cap", () => {
    const last = active[active.length - 1].instance.id;
    const visible = capWorkstreamEntries({ active }, false, last);
    expect(visible).toHaveLength(WORKSTREAM_FOLDER_LIMIT + 1);
    expect(visible[visible.length - 1].instance.id).toBe(last);
  });
});

describe("excludeFolderedEntries", () => {
  it("drops chats that live in a folder", () => {
    const entries = [entry("a"), entry("b")];
    const kept = excludeFolderedEntries(entries, { a: "w1" }, [workstream("w1", "GraphQL")]);
    expect(kept.map((e) => e.instance.id)).toEqual(["b"]);
  });

  it("keeps chats whose workstream is done or unknown, since no folder shows them", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const kept = excludeFolderedEntries(entries, { a: "w1", b: "missing" }, [
      workstream("w1", "GraphQL", "done"),
    ]);
    expect(kept.map((e) => e.instance.id)).toEqual(["a", "b", "c"]);
  });
});

describe("getWorkstreamAccent", () => {
  it("is stable for an id", () => {
    expect(getWorkstreamAccent({ id: "w1" })).toBe(getWorkstreamAccent({ id: "w1" }));
  });
});
