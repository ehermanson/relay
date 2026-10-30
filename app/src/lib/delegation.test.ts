import { describe, expect, it } from "vitest";
import type { AgentInfo, InstanceInfo } from "@shared/types";
import { buildAgentTree, gateAgentsByCapability, isMainStreamAgent } from "@/lib/agents";
import {
  buildDelegationFamily,
  findDelegationRoot,
  isDelegatedChildInstance,
  isFinishedDelegationTab,
  relayTaskIdOf,
  splitDelegationTabs,
} from "@/lib/delegation";

function chat(overrides: Partial<InstanceInfo> & { id: string }): InstanceInfo {
  return {
    provider: "claude",
    name: overrides.id,
    workingDirectory: "/repo",
    status: "idle",
    createdAt: 1,
    lastActivityAt: 1,
    ...overrides,
  };
}

const child = (id: string, parent: string) =>
  chat({ id, delegation: { parentInstanceId: parent, taskId: `t-${id}` } });

describe("delegation helpers", () => {
  it("identifies delegated children and their task ids", () => {
    expect(isDelegatedChildInstance(child("c", "p"))).toBe(true);
    expect(isDelegatedChildInstance(chat({ id: "p" }))).toBe(false);
    expect(relayTaskIdOf({ agentId: "relay-task:abc", origin: "relay" })).toBe("abc");
    expect(relayTaskIdOf({ agentId: "relay-task:abc" })).toBeUndefined();
    expect(relayTaskIdOf({ agentId: "tu-1", origin: "relay" })).toBeUndefined();
  });

  it("walks to the nearest non-delegated ancestor, cycle-safe", () => {
    const root = chat({ id: "root" });
    const mid = child("mid", "root");
    const leaf = child("leaf", "mid");
    const byId = new Map([root, mid, leaf].map((i) => [i.id, i]));
    expect(findDelegationRoot(leaf, byId).id).toBe("root");
    const a = child("a", "b");
    const b = child("b", "a");
    const cyclic = new Map([a, b].map((i) => [i.id, i]));
    expect(["a", "b"]).toContain(findDelegationRoot(a, cyclic).id);
    expect(findDelegationRoot(child("orphan", "gone"), byId).id).toBe("orphan");
  });
});

describe("buildDelegationFamily", () => {
  const at = (instance: InstanceInfo, createdAt: number) => ({ ...instance, createdAt });
  const root = chat({ id: "root" });
  const late = at(child("late", "root"), 30);
  const early = at(child("early", "root"), 10);
  const grand = at(child("grand", "early"), 20);
  const other = chat({ id: "other" });
  const all = [late, other, grand, root, early];
  const shape = (id: string) =>
    buildDelegationFamily(all, id).map((tab) => `${tab.instance.id}:${tab.depth}`);

  it("returns the root then descendants depth-first, siblings by creation time", () => {
    expect(shape("root")).toEqual(["root:0", "early:1", "grand:2", "late:1"]);
  });

  it("is the same family from any member", () => {
    expect(shape("grand")).toEqual(shape("root"));
    expect(shape("late")).toEqual(shape("root"));
  });

  it("is empty for a chat with no parent and no children", () => {
    expect(buildDelegationFamily(all, "other")).toEqual([]);
    expect(buildDelegationFamily(all, "missing")).toEqual([]);
    expect(buildDelegationFamily([child("orphan", "gone")], "orphan")).toEqual([]);
  });

  it("breaks ties by id and survives cycles", () => {
    const a = at(child("a", "p"), 5);
    const b = at(child("b", "p"), 5);
    const p = chat({ id: "p" });
    expect(buildDelegationFamily([b, p, a], "p").map((tab) => tab.instance.id)).toEqual([
      "p",
      "a",
      "b",
    ]);
    const x = child("x", "y");
    const y = child("y", "x");
    expect(buildDelegationFamily([x, y], "x")).toHaveLength(2);
  });
});

describe("splitDelegationTabs", () => {
  const withTask = (
    id: string,
    parent: string,
    taskStatus: NonNullable<InstanceInfo["delegation"]>["taskStatus"],
    createdAt: number,
  ) =>
    chat({
      id,
      createdAt,
      delegation: { parentInstanceId: parent, taskId: `t-${id}`, taskStatus },
    });
  // root → run (running) → grand (failed); done1, done2 (completed); gone (cancelled);
  // doneParent (completed) → doneKid (completed)
  const family = buildDelegationFamily(
    [
      chat({ id: "root" }),
      withTask("run", "root", "running", 1),
      withTask("grand", "run", "failed", 2),
      withTask("done1", "root", "completed", 3),
      withTask("gone", "root", "cancelled", 4),
      withTask("done2", "root", "completed", 5),
      withTask("doneParent", "root", "completed", 6),
      withTask("doneKid", "doneParent", "completed", 7),
      withTask("legacy", "root", undefined, 8),
    ],
    "root",
  );
  const ids = (tabs: { instance: InstanceInfo }[]) => tabs.map((tab) => tab.instance.id);

  it("folds completed and cancelled children, keeping the root, running, failed and unknown", () => {
    const split = splitDelegationTabs(family, "root", false);
    expect(ids(split.visible)).toEqual(["root", "run", "grand", "legacy"]);
    expect(ids(split.folded)).toEqual(["done1", "gone", "done2", "doneParent", "doneKid"]);
    expect(isFinishedDelegationTab(family[0])).toBe(false);
  });

  it("shows everything in family order when expanded, with the same fold", () => {
    const split = splitDelegationTabs(family, "root", true);
    expect(ids(split.visible)).toEqual(ids(family));
    expect(ids(split.folded)).toEqual(ids(splitDelegationTabs(family, "root", false).folded));
  });

  it("never hides the chat on screen, nor the parent of a visible tab", () => {
    const split = splitDelegationTabs(family, "doneKid", false);
    expect(ids(split.visible)).toEqual(["root", "run", "grand", "doneParent", "doneKid", "legacy"]);
    expect(ids(split.folded)).toEqual(["done1", "gone", "done2"]);
  });

  it("unfolds a reopened child and drops the chip when nothing is finished", () => {
    const reopened = family.map((tab) =>
      tab.instance.id === "done1"
        ? {
            ...tab,
            instance: {
              ...tab.instance,
              delegation: { ...tab.instance.delegation!, taskStatus: "running" as const },
            },
          }
        : tab,
    );
    expect(ids(splitDelegationTabs(reopened, "root", false).visible)).toContain("done1");
    const live = family.filter((tab) => !isFinishedDelegationTab(tab));
    expect(splitDelegationTabs(live, "root", false).folded).toEqual([]);
  });
});

describe("relay agents", () => {
  const relay: AgentInfo = {
    agentId: "relay-task:t1",
    origin: "relay",
    childInstanceId: "c1",
    parentAgentId: "native-1",
    originToolUseId: "tu-inside-native",
  };
  const native: AgentInfo = { agentId: "native-1" };

  it("are always main-stream and top-level in the tree", () => {
    const agentItems = {
      "native-1": [
        {
          kind: "activity-group" as const,
          activities: [
            { type: "activity", activity: "tool_use", toolUseId: "tu-inside-native" },
          ] as never,
        },
      ],
    };
    expect(isMainStreamAgent(relay, agentItems)).toBe(true);
    const tree = buildAgentTree({ [native.agentId]: native, [relay.agentId]: relay });
    expect(tree.find((node) => node.agent.agentId === relay.agentId)?.depth).toBe(0);
  });

  it("survive the capability gate when provider agents don't", () => {
    const empty = { agents: {}, agentItems: {} };
    const agents = { [native.agentId]: native, [relay.agentId]: relay };
    const agentItems = { "native-1": [], "relay-task:t1": [] };
    const supported = gateAgentsByCapability(agents, agentItems, true, empty);
    expect(supported.agents).toBe(agents);
    const gated = gateAgentsByCapability(agents, agentItems, false, empty);
    expect(Object.keys(gated.agents)).toEqual(["relay-task:t1"]);
    expect(Object.keys(gated.agentItems)).toEqual(["relay-task:t1"]);
    expect(gateAgentsByCapability({ [native.agentId]: native }, {}, false, empty)).toBe(empty);
  });
});
