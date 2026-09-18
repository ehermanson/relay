import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "@shared/types";
import { agentHistoryToItems } from "@/hooks/use-agent-history";

const CHILD = "019a-codex-child-thread";
const GRANDCHILD = "019a-codex-grandchild-thread";

/**
 * Codex-shaped child history, as `readCodexAgentHistory` returns it: a leading
 * `agent_update` for the child itself, the assignment as an agent-authored
 * user message, and every output/activity entry attributed to the child.
 */
const CODEX_CHILD_HISTORY: HistoryEntry[] = [
  {
    timestamp: 1,
    message: {
      type: "agent_update",
      agent: {
        agentId: CHILD,
        providerAgentId: CHILD,
        relation: "child",
        name: "jev_research",
        role: "default",
        assignment: "Investigate the discovery gap.",
      },
    },
  },
  {
    timestamp: 2,
    message: {
      type: "user",
      instanceId: "i",
      text: "Investigate the discovery gap.",
      author: { kind: "agent", name: "/root" },
      agentId: CHILD,
    },
  },
  {
    timestamp: 3,
    message: {
      type: "activity",
      instanceId: "i",
      activity: "tool_use",
      tool: "Bash",
      toolUseId: "call-1",
      description: "rg discovery",
      input: { command: "rg discovery" },
      agentId: CHILD,
    },
  },
  {
    timestamp: 4,
    message: {
      type: "activity",
      instanceId: "i",
      activity: "tool_result",
      toolUseId: "call-1",
      description: "Tool completed",
      detail: "3 matches",
      agentId: CHILD,
    },
  },
  {
    timestamp: 5,
    message: {
      type: "activity",
      instanceId: "i",
      activity: "tool_use",
      tool: "spawn_agent",
      toolUseId: "call-spawn",
      description: "Spawning agent",
      agentId: CHILD,
    },
  },
  {
    timestamp: 6,
    message: {
      type: "agent_update",
      agent: {
        agentId: GRANDCHILD,
        providerAgentId: GRANDCHILD,
        parentAgentId: CHILD,
        originToolUseId: "call-spawn",
        relation: "child",
        name: "helper",
      },
    },
  },
  {
    timestamp: 7,
    message: {
      type: "output",
      instanceId: "i",
      text: "Found the gap.",
      isWaiting: true,
      agentId: CHILD,
    },
  },
];

describe("agentHistoryToItems", () => {
  it("returns the attributed transcript, never the placeholder cards", () => {
    const { items } = agentHistoryToItems(CODEX_CHILD_HISTORY, CHILD);
    expect(items.map((i) => i.kind)).toEqual(["user", "activity-group", "assistant"]);
    expect(items.some((i) => i.kind === "agent-card")).toBe(false);
    const group = items[1];
    expect(group.kind === "activity-group" && group.activities[0].mergedResultDetail).toBe(
      "3 matches",
    );
    expect(group.kind === "activity-group" && group.activities[1].toolUseId).toBe("call-spawn");
  });

  it("folds nested agent_updates so grandchildren can render in the detail view", () => {
    const { agents } = agentHistoryToItems(CODEX_CHILD_HISTORY, CHILD);
    expect(Object.keys(agents).sort()).toEqual([CHILD, GRANDCHILD].sort());
    expect(agents[GRANDCHILD]).toEqual(
      expect.objectContaining({ parentAgentId: CHILD, originToolUseId: "call-spawn" }),
    );
  });

  it("falls back to the bare main stream only when nothing is attributed", () => {
    const bare: HistoryEntry[] = [
      { timestamp: 1, message: { type: "user", instanceId: "i", text: "assignment" } },
      { timestamp: 2, message: { type: "output", instanceId: "i", text: "done", isWaiting: true } },
    ];
    const { items, agents } = agentHistoryToItems(bare, "agent-x");
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(agents).toEqual({});
  });

  it("uses a transcript attributed under a different key rather than the placeholders", () => {
    const history: HistoryEntry[] = [
      { timestamp: 1, message: { type: "agent_update", agent: { agentId: "relay-key" } } },
      {
        timestamp: 2,
        message: {
          type: "output",
          instanceId: "i",
          text: "hi",
          isWaiting: true,
          agentId: "native-id",
        },
      },
    ];
    const { items } = agentHistoryToItems(history, "relay-key");
    expect(items).toEqual([expect.objectContaining({ kind: "assistant", text: "hi" })]);
  });

  it("does not substitute a grandchild stream for an empty child transcript", () => {
    const history: HistoryEntry[] = [
      {
        timestamp: 1,
        message: { type: "agent_update", agent: { agentId: GRANDCHILD, parentAgentId: CHILD } },
      },
      {
        timestamp: 2,
        message: {
          type: "output",
          instanceId: "i",
          agentId: GRANDCHILD,
          text: "Grandchild work",
          isWaiting: true,
        },
      },
    ];
    expect(agentHistoryToItems(history, CHILD).items).toEqual([]);
  });

  it("returns nothing for an empty history", () => {
    expect(agentHistoryToItems([], "x")).toEqual({ items: [], agents: {} });
  });
});
