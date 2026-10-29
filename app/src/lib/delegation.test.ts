import { describe, expect, it } from "vitest";
import type { AgentInfo, InstanceInfo } from "@shared/types";
import { buildAgentTree, gateAgentsByCapability, isMainStreamAgent } from "@/lib/agents";
import { findDelegationRoot, isDelegatedChildInstance, relayTaskIdOf } from "@/lib/delegation";

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
