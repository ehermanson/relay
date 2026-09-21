import { describe, expect, it } from "vitest";
import type { AgentInfo, ProviderRequest } from "@shared/types";
import type { ChatItem, MergedActivity } from "@/lib/chat-types";
import { mergeAgentInfo } from "@shared/agent-info";
import {
  buildAgentAnchorIndex,
  buildAgentTree,
  deriveAgentLastActivity,
  findRequestAgentId,
  formatAgentDuration,
  getAgentModelLabel,
  getAgentLastActivity,
  getAgentSubtitle,
  getAgentTitle,
  isMainStreamAgent,
} from "@/lib/agents";

const toolUse = (toolUseId: string, description = "Spawning agent"): MergedActivity =>
  ({
    type: "activity",
    activity: "tool_use",
    tool: "Agent",
    toolUseId,
    description,
  }) as MergedActivity;

describe("mergeAgentInfo", () => {
  it("returns a copy of the update on first sighting without injecting defaults", () => {
    const merged = mergeAgentInfo(undefined, { agentId: "a" });
    expect(merged).toEqual({ agentId: "a" });
    expect("status" in merged).toBe(false);
    expect("model" in merged).toBe(false);
  });

  it("keeps previous fields when the update omits them", () => {
    const prev: AgentInfo = { agentId: "a", name: "explorer", model: "m1", status: "running" };
    const merged = mergeAgentInfo(prev, { agentId: "a", status: "completed", result: "done" });
    expect(merged).toEqual({
      agentId: "a",
      name: "explorer",
      model: "m1",
      status: "completed",
      result: "done",
    });
  });

  it("treats explicit undefined as omitted", () => {
    const prev: AgentInfo = { agentId: "a", model: "m1" };
    expect(mergeAgentInfo(prev, { agentId: "a", model: undefined })).toEqual(prev);
  });

  it("merges usage field-wise (shared server/UI semantics)", () => {
    const prev: AgentInfo = { agentId: "a", usage: { totalTokens: 10, toolUses: 2 } };
    const merged = mergeAgentInfo(prev, { agentId: "a", usage: { durationMs: 500 } });
    expect(merged.usage).toEqual({ totalTokens: 10, toolUses: 2, durationMs: 500 });
  });
});

describe("getAgentModelLabel", () => {
  it("is null when the model is unknown, never a default", () => {
    expect(getAgentModelLabel({ agentId: "x" }, "claude")).toBeNull();
    expect(getAgentModelLabel({ agentId: "x" }, undefined)).toBeNull();
  });

  it("falls back to the raw id when no catalog label exists", () => {
    expect(getAgentModelLabel({ agentId: "x", model: "totally-new-model" }, "claude")).toBe(
      "totally-new-model",
    );
    expect(getAgentModelLabel({ agentId: "x", model: "m" }, undefined)).toBe("m");
  });
});

describe("formatAgentDuration", () => {
  it("formats seconds, minutes and hours; unknown stays unknown", () => {
    expect(formatAgentDuration(42_000)).toBe("42s");
    expect(formatAgentDuration(185_000)).toBe("3m 5s");
    expect(formatAgentDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatAgentDuration(undefined)).toBeUndefined();
    expect(formatAgentDuration(-1)).toBeUndefined();
    expect(formatAgentDuration(Number.NaN)).toBeUndefined();
  });
});

describe("agent titles", () => {
  it("prefers name, then description, then role, then a generic label", () => {
    expect(getAgentTitle({ agentId: "x", name: "n", description: "d", role: "r" })).toBe("n");
    expect(getAgentTitle({ agentId: "x", description: "d", role: "r" })).toBe("d");
    expect(getAgentTitle({ agentId: "x", role: "r" })).toBe("r");
    expect(getAgentTitle({ agentId: "x" })).toBe("Agent");
  });

  it("never repeats the title in the subtitle", () => {
    expect(getAgentSubtitle({ agentId: "x", name: "n", description: "d" })).toBe("d");
    expect(getAgentSubtitle({ agentId: "x", description: "d" })).toBeUndefined();
    expect(getAgentSubtitle({ agentId: "x", description: "d", role: "r" })).toBe("r");
  });
});

describe("buildAgentAnchorIndex", () => {
  const items: ChatItem[] = [
    { kind: "user", text: "go" },
    { kind: "activity-group", activities: [toolUse("tu-1"), toolUse("tu-2")] },
    { kind: "agent-card", agentId: "carded" },
  ];

  it("maps origin tool_use ids to agents present in the stream", () => {
    const agents: Record<string, AgentInfo> = {
      a: { agentId: "a", originToolUseId: "tu-1" },
      b: { agentId: "b", originToolUseId: "tu-missing" },
      c: { agentId: "c" },
    };
    const anchors = buildAgentAnchorIndex(items, agents);
    expect([...anchors.entries()]).toEqual([["tu-1", "a"]]);
  });

  it("excludes agents that already own an inserted card", () => {
    const agents: Record<string, AgentInfo> = {
      carded: { agentId: "carded", originToolUseId: "tu-2" },
    };
    expect(buildAgentAnchorIndex(items, agents).size).toBe(0);
  });

  it("returns one shared empty index when no agent has an origin", () => {
    const agents: Record<string, AgentInfo> = { a: { agentId: "a" }, b: { agentId: "b" } };
    const first = buildAgentAnchorIndex(items, agents);
    const second = buildAgentAnchorIndex([...items], { c: { agentId: "c" } });
    expect(first.size).toBe(0);
    expect(second).toBe(first);
    expect(buildAgentAnchorIndex(items, {})).toBe(first);
  });
});

describe("isMainStreamAgent", () => {
  const nestedItems: Record<string, ChatItem[]> = {
    parent: [{ kind: "activity-group", activities: [toolUse("tu-child")] }],
  };

  it("keeps agents with no parent and no nested origin in the main stream", () => {
    expect(isMainStreamAgent({ agentId: "a" }, nestedItems)).toBe(true);
    expect(isMainStreamAgent({ agentId: "a", originToolUseId: "tu-main" }, nestedItems)).toBe(true);
  });

  it("excludes provider-declared children and agents whose origin lives in another transcript", () => {
    expect(isMainStreamAgent({ agentId: "a", parentAgentId: "parent" }, nestedItems)).toBe(false);
    expect(isMainStreamAgent({ agentId: "a", originToolUseId: "tu-child" }, nestedItems)).toBe(
      false,
    );
  });
});

describe("deriveAgentLastActivity", () => {
  it("returns the most recent attributed tool_use label", () => {
    const items: ChatItem[] = [
      {
        kind: "activity-group",
        activities: [
          { ...toolUse("t1", "Read a.ts"), tool: "Read" },
          { ...toolUse("t2", "Edit b.ts"), tool: "Edit", inputDescription: "Edit b.ts" },
        ],
      },
      { kind: "assistant", text: "done" },
    ];
    expect(deriveAgentLastActivity(items)).toBe("Edit b.ts");
    expect(deriveAgentLastActivity([])).toBeUndefined();
    expect(deriveAgentLastActivity(undefined)).toBeUndefined();
  });
});

describe("agent activity previews", () => {
  it("replaces legacy message receipts with actual work and falls back to assignment", () => {
    const items: ChatItem[] = [
      { kind: "activity-group", activities: [toolUse("t", "Read floor.ts")] },
    ];
    for (const lastActivity of ["Message exchanged", "Received a message"]) {
      const agent: AgentInfo = {
        agentId: "a",
        name: "floor",
        lastActivity,
        assignment: "Fix floor geometry",
      };
      expect(getAgentLastActivity(agent, items)).toBe("Read floor.ts");
      expect(getAgentLastActivity(agent, undefined)).toBeUndefined();
      expect(getAgentSubtitle(agent)).toBe("Fix floor geometry");
    }
    expect(getAgentLastActivity({ agentId: "a", lastActivity: "Running tests" }, items)).toBe(
      "Running tests",
    );
  });
});

describe("findRequestAgentId", () => {
  const agents: Record<string, AgentInfo> = {
    relay1: { agentId: "relay1", providerAgentId: "native-1" },
  };
  it("prefers the Relay key when present", () => {
    const req = { requestId: "r", kind: "approval", relayAgentId: "relay1" } as ProviderRequest;
    expect(findRequestAgentId(req, agents)).toBe("relay1");
  });
  it("falls back to the provider-native id", () => {
    const req = { requestId: "r", kind: "approval", agentId: "native-1" } as ProviderRequest;
    expect(findRequestAgentId(req, agents)).toBe("relay1");
  });
  it("returns undefined for unknown or absent requests", () => {
    expect(findRequestAgentId(null, agents)).toBeUndefined();
    const req = { requestId: "r", kind: "approval", agentId: "nope" } as ProviderRequest;
    expect(findRequestAgentId(req, agents)).toBeUndefined();
  });
});

describe("buildAgentTree", () => {
  it("nests children under provider-declared parents only", () => {
    const agents: Record<string, AgentInfo> = {
      root: { agentId: "root" },
      child: { agentId: "child", parentAgentId: "root" },
      orphan: { agentId: "orphan", parentAgentId: "unknown-parent" },
    };
    expect(buildAgentTree(agents).map((n) => [n.agent.agentId, n.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["orphan", 0],
    ]);
  });

  it("emits every agent exactly once even with parent cycles", () => {
    const agents: Record<string, AgentInfo> = {
      root: { agentId: "root" },
      a: { agentId: "a", parentAgentId: "b" },
      b: { agentId: "b", parentAgentId: "a" },
      c: { agentId: "c", parentAgentId: "a" },
      self: { agentId: "self", parentAgentId: "self" },
    };
    const tree = buildAgentTree(agents);
    expect(tree.map((n) => n.agent.agentId).sort()).toEqual(["a", "b", "c", "root", "self"]);
    expect(tree).toHaveLength(Object.keys(agents).length);
    // The cycle is entered at its first member (insertion order) as a root;
    // the rest of the cycle hangs below it.
    expect(tree.map((n) => [n.agent.agentId, n.depth])).toEqual([
      ["root", 0],
      ["a", 0],
      ["b", 1],
      ["c", 1],
      ["self", 0],
    ]);
  });
});
