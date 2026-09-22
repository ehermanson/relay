import { describe, expect, it } from "vitest";
import { buildMobileHome, homeActivity, homeEntryChat } from "./mobile-home";
import type { InstanceInfo, SpaceInfo } from "@shared/types";
import type { InboxSourceGroup } from "./inbox";

const chat = (id: string, lastActivityAt: number, extra: Partial<InstanceInfo> = {}) =>
  ({
    id,
    name: id,
    provider: "claude",
    workingDirectory: "/project",
    status: "stopped",
    createdAt: 0,
    lastActivityAt,
    ...extra,
  }) as InstanceInfo;
const group = (
  name: string,
  chats: InstanceInfo[],
  spaces: SpaceInfo[] = [],
): InboxSourceGroup => ({
  name,
  dir: `/${name}`,
  projectId: name,
  groupInstances: chats,
  spaces,
});
const space = (id: string, status: SpaceInfo["status"] = "active") =>
  ({
    id,
    name: id,
    status,
    isDefault: false,
    createdAt: 0,
    lastActivityAt: 0,
  }) as SpaceInfo;

describe("mobile Home", () => {
  it("ranks projects by chat activity independently of project order and chat pins", () => {
    const model = buildMobileHome([
      group("older", [chat("pinned", 10, { pinned: true })]),
      group("empty", []),
      group("recent", [chat("new", 100)]),
    ]);
    expect(model.projects.map((p) => p.name)).toEqual(["recent", "older", "empty"]);
    expect(model.recent.map((e) => e.id)).toEqual(["chat:new", "chat:pinned"]);
  });
  it("groups space members once and omits done chats, closed spaces, empty spaces and reviews", () => {
    const model = buildMobileHome([
      group(
        "project",
        [
          chat("one", 50, { spaceId: "active" }),
          chat("two", 60, { spaceId: "active" }),
          chat("done", 100, { doneAt: 100 }),
          chat("closed", 200, { spaceId: "closed" }),
          chat("review", 500, {
            parentSessionId: "one",
            name: 'Review the recent changes from "one"',
          }),
        ],
        [space("active"), space("closed", "archived"), space("empty")],
      ),
    ]);
    expect(model.recent.map((e) => e.id)).toEqual(["space:active"]);
    expect(model.projects[0].recencyAt).toBe(200);
  });
  it("keeps unloaded space chats accessible until metadata resolves", () => {
    expect(
      buildMobileHome([group("project", [chat("one", 10, { spaceId: "unknown" })])]).recent[0].id,
    ).toBe("chat:one");
  });
  it("leads with everything waiting on the user, uncapped, then caps the rest by recency", () => {
    const model = buildMobileHome([
      group(
        "project",
        [
          chat("plan", 1, { status: "processing", pendingPlan: "Review this plan" }),
          chat("error", 2, { status: "error" }),
          chat("r1", 10),
          chat("r2", 20),
          chat("r3", 30),
          chat("r4", 40),
          chat("r5", 50),
          chat("spaced", 60, { spaceId: "s", status: "processing", pendingTool: "Bash" }),
        ],
        [space("s")],
      ),
    ]);
    expect(model.needsInput.map((e) => e.id)).toEqual(["space:s", "chat:error", "chat:plan"]);
    expect(model.recent.map((e) => e.id)).toEqual(["chat:r5", "chat:r4", "chat:r3", "chat:r2"]);
  });
  it("counts waiting work separately from running and ignores stopped requests", () => {
    expect(
      homeActivity([
        chat("working", 1, { status: "processing" }),
        chat("waiting", 2, { status: "processing", pendingPlan: "Review this plan" }),
        chat("error", 3, { status: "error" }),
        chat("stopped", 4, { pendingPlan: "Review this plan" }),
      ]),
    ).toEqual({ recencyAt: 4, attention: 2, running: 1 });
  });
  it("previews a space's destination chat, falling back to its most recent member", () => {
    const [entry] = buildMobileHome([
      group(
        "project",
        [chat("a", 10, { spaceId: "s" }), chat("b", 20, { spaceId: "s" })],
        [space("s")],
      ),
    ]).recent;
    expect(homeEntryChat(entry, "a")?.id).toBe("a");
    expect(homeEntryChat(entry, "missing")?.id).toBe("b");
  });
});
