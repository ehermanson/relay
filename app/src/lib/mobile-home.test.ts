import { describe, expect, it } from "vitest";
import { buildMobileHome, homeActivity } from "./mobile-home";
import type { InstanceInfo } from "@shared/types";
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
const group = (name: string, chats: InstanceInfo[]): InboxSourceGroup => ({
  name,
  dir: `/${name}`,
  projectId: name,
  groupInstances: chats,
});

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
  it("omits done chats and reviews", () => {
    const model = buildMobileHome([
      group("project", [
        chat("one", 50),
        chat("done", 100, { doneAt: 100 }),
        chat("review", 500, {
          parentSessionId: "one",
          name: 'Review the recent changes from "one"',
        }),
      ]),
    ]);
    expect(model.recent.map((e) => e.id)).toEqual(["chat:one"]);
    expect(model.projects[0].recencyAt).toBe(100);
  });
  it("leads with everything waiting on the user, uncapped, then caps the rest by recency", () => {
    const model = buildMobileHome([
      group("project", [
        chat("plan", 1, { status: "processing", pendingPlan: "Review this plan" }),
        chat("error", 2, { status: "error" }),
        chat("r1", 10),
        chat("r2", 20),
        chat("r3", 30),
        chat("r4", 40),
        chat("r5", 50),
        chat("tool", 60, { status: "processing", pendingTool: "Bash" }),
      ]),
    ]);
    expect(model.needsInput.map((e) => e.id)).toEqual(["chat:tool", "chat:error", "chat:plan"]);
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
});
