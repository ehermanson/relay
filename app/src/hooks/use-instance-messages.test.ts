import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  replayHistory,
  replayHistoryToItems,
  useInstanceMessages,
} from "@/hooks/use-instance-messages";
import { buildAgentAnchorIndex } from "@/lib/agents";
import type {
  ActivityMessage,
  HistoryEntry,
  InstanceStatusMessage,
  OutputMessage,
  QueuedRemovedMessage,
  UserMessage,
} from "@shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal InstanceInfo stub — only the fields the reducer inspects. */
function stubInstanceStatus(
  instanceId: string,
  overrides: Record<string, unknown> = {},
): InstanceStatusMessage {
  return {
    type: "instance_status",
    instanceId,
    instance: {
      id: instanceId,
      status: "idle",
      name: "test",
      workingDirectory: "/tmp",
      createdAt: 0,
      lastActivityAt: 0,
      ...overrides,
    } as InstanceStatusMessage["instance"],
  };
}

describe("useInstanceMessages sequence dedupe", () => {
  it("ignores duplicate sequenced user messages", () => {
    const { result } = renderHook(() => useInstanceMessages());

    act(() => {
      result.current.setInstanceId("instance-1");
    });

    const message: UserMessage = {
      type: "user",
      instanceId: "instance-1",
      text: "hello",
      eventSequence: 7,
    };

    act(() => {
      result.current.handleMessage("instance-1", message);
      result.current.handleMessage("instance-1", message);
    });

    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "hello" }),
    ]);
  });

  it("ignores duplicate sequenced thinking activities", () => {
    const { result } = renderHook(() => useInstanceMessages());

    act(() => {
      result.current.setInstanceId("instance-1");
    });

    const message: ActivityMessage = {
      type: "activity",
      instanceId: "instance-1",
      activity: "thinking",
      description: "Thinking...",
      detail: "considering options",
      eventSequence: 8,
    };

    act(() => {
      result.current.handleMessage("instance-1", message);
      result.current.handleMessage("instance-1", message);
    });

    expect(result.current.items).toEqual([{ kind: "thinking-block", text: "considering options" }]);
  });

  it("preserves whitespace-only output chunks between text chunks", () => {
    const { result } = renderHook(() => useInstanceMessages());

    act(() => {
      result.current.setInstanceId("instance-1");
    });

    // Simulate streaming chunks where newlines arrive as separate chunks
    const chunks = ["- item one", "\n\n", "4. next section"];

    for (const [i, text] of chunks.entries()) {
      act(() => {
        result.current.handleMessage("instance-1", {
          type: "output",
          instanceId: "instance-1",
          text,
          isWaiting: i === chunks.length - 1,
          eventSequence: 10 + i,
        } as OutputMessage);
      });
    }

    expect(result.current.items).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "- item one\n\n4. next section",
      }),
    ]);
  });

  it("ignores duplicate sequenced output chunks", () => {
    const { result } = renderHook(() => useInstanceMessages());

    act(() => {
      result.current.setInstanceId("instance-1");
    });

    const message: OutputMessage = {
      type: "output",
      instanceId: "instance-1",
      text: "world",
      isWaiting: false,
      eventSequence: 9,
    };

    act(() => {
      result.current.handleMessage("instance-1", message);
      result.current.handleMessage("instance-1", message);
    });

    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "assistant", text: "world" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Message queue behaviour
// ---------------------------------------------------------------------------

describe("useInstanceMessages message queue", () => {
  it("renders a queued user message with queued flag", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-1"));

    const msg: UserMessage = {
      type: "user",
      instanceId: "inst-1",
      text: "queued hello",
      queued: true,
    };

    act(() => result.current.handleMessage("inst-1", msg));

    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "queued hello", queued: true }),
    ]);
  });

  it("replaces queued placeholders when the coalesced real message arrives", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-1"));

    // Simulate two queued messages arriving during processing
    act(() => {
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "first queued",
        queued: true,
      } as UserMessage);
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "second queued",
        queued: true,
      } as UserMessage);
    });

    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[0]).toEqual(
      expect.objectContaining({ queued: true, text: "first queued" }),
    );

    // Queue drains — server sends one coalesced non-queued user message
    act(() => {
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "first queued\n\nsecond queued",
      } as UserMessage);
    });

    // Should have exactly one non-queued message, no duplicates
    const userItems = result.current.items.filter((i) => i.kind === "user");
    expect(userItems).toHaveLength(1);
    expect(userItems[0]).toEqual(
      expect.objectContaining({
        kind: "user",
        text: "first queued\n\nsecond queued",
        queued: undefined,
      }),
    );
  });

  it("removes only the matching queued placeholder on queued_removed", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-1"));

    act(() => {
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "first queued",
        queued: true,
        queuedId: "q1",
      } as UserMessage);
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "second queued",
        queued: true,
        queuedId: "q2",
      } as UserMessage);
    });

    expect(result.current.items).toHaveLength(2);

    act(() => {
      result.current.handleMessage("inst-1", {
        type: "queued_removed",
        instanceId: "inst-1",
        queuedId: "q1",
      } as QueuedRemovedMessage);
    });

    const userItems = result.current.items.filter((i) => i.kind === "user");
    expect(userItems).toHaveLength(1);
    expect(userItems[0]).toEqual(
      expect.objectContaining({ queued: true, queuedId: "q2", text: "second queued" }),
    );
  });

  it("carries queued metadata (id, source text, attachments) on queued items", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-1"));

    act(() => {
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "look at this\n[Image: source: /tmp/shot.png]",
        images: ["/tmp/shot.png"],
        queued: true,
        queuedId: "q1",
        queuedSourceText: "look at this",
      } as UserMessage);
    });

    expect(result.current.items[0]).toEqual(
      expect.objectContaining({
        kind: "user",
        queued: true,
        queuedId: "q1",
        queuedSourceText: "look at this",
        queuedImages: ["/tmp/shot.png"],
      }),
    );
  });

  it("mirrors queued metadata into rawHistory", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => {
      result.current.setInstanceId("inst-raw");
      // Full replay initializes the rawHistory buffer
      result.current.handleMessage("inst-raw", {
        type: "instance_history",
        instanceId: "inst-raw",
        history: [],
        replayMode: "full",
        latestSequence: 0,
        replayEpoch: 1,
      });
      result.current.handleMessage("inst-raw", {
        type: "user",
        instanceId: "inst-raw",
        text: "look at this\n[Image: source: /tmp/shot.png]",
        images: ["/tmp/shot.png"],
        queued: true,
        queuedId: "q1",
        queuedSourceText: "look at this",
      } as UserMessage);
    });

    const entry = result.current.rawHistory?.at(-1);
    expect(entry?.message).toEqual(
      expect.objectContaining({
        type: "user",
        queued: true,
        queuedId: "q1",
        queuedSourceText: "look at this",
        images: ["/tmp/shot.png"],
      }),
    );
  });

  it("restores queued metadata when rebuilding items from history entries", () => {
    const items = replayHistoryToItems([
      {
        timestamp: 1,
        message: {
          type: "user",
          instanceId: "inst-1",
          text: "queued text\n[Image: source: /tmp/shot.png]",
          images: ["/tmp/shot.png"],
          queued: true,
          queuedId: "q1",
          queuedSourceText: "queued text",
        } as UserMessage,
      },
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        kind: "user",
        queued: true,
        queuedId: "q1",
        queuedSourceText: "queued text",
        queuedImages: ["/tmp/shot.png"],
      }),
    ]);
  });

  it("clears queued placeholders when instance_status reports queue empty", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-1"));

    // Add a normal message then a queued one
    act(() => {
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "normal message",
      } as UserMessage);
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "queued message",
        queued: true,
      } as UserMessage);
    });

    expect(result.current.items).toHaveLength(2);

    // Server clears queue (e.g. user pressed stop) and broadcasts status
    act(() => {
      result.current.handleMessage(
        "inst-1",
        stubInstanceStatus("inst-1", { queuedMessageCount: undefined }),
      );
    });

    // Only the normal message should remain
    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "normal message" }),
    ]);
  });

  it("clear_queued is a no-op when nothing is queued", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-1"));

    act(() => {
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "normal",
      } as UserMessage);
    });

    const itemsBefore = result.current.items;

    // Status update with no queue — should not trigger a re-render
    act(() => {
      result.current.handleMessage(
        "inst-1",
        stubInstanceStatus("inst-1", { queuedMessageCount: undefined }),
      );
    });

    // Same reference — reducer returned previous state (no-op)
    expect(result.current.items).toBe(itemsBefore);
  });

  it("does not clear queued items when instance_status still has a queue count", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-1"));

    act(() => {
      result.current.handleMessage("inst-1", {
        type: "user",
        instanceId: "inst-1",
        text: "queued",
        queued: true,
      } as UserMessage);
    });

    // Status update that still reports a queue
    act(() => {
      result.current.handleMessage(
        "inst-1",
        stubInstanceStatus("inst-1", { queuedMessageCount: 1 }),
      );
    });

    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "queued", queued: true }),
    ]);
  });
});

describe("useInstanceMessages passive history hydration", () => {
  it("hydrates from a REST snapshot before websocket replay arrives", () => {
    const { result } = renderHook(() => useInstanceMessages());
    const history: HistoryEntry[] = [
      {
        timestamp: 1,
        message: {
          type: "user",
          instanceId: "inst-1",
          text: "hello",
        },
      },
      {
        timestamp: 2,
        message: {
          type: "output",
          instanceId: "inst-1",
          text: "world",
          isWaiting: true,
        },
      },
    ];

    act(() => {
      result.current.setInstanceId("inst-1");
      result.current.hydrateFromHistorySnapshot("inst-1", history);
    });

    expect(result.current.hasLoadedHistory).toBe(true);
    expect(result.current.hasSyncedHistory).toBe(true);
    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "hello" }),
      expect.objectContaining({ kind: "assistant", text: "world" }),
    ]);
  });

  it("does not overwrite websocket-loaded state with a later REST snapshot", () => {
    const { result } = renderHook(() => useInstanceMessages());

    act(() => {
      result.current.setInstanceId("inst-1");
      result.current.handleMessage("inst-1", {
        type: "instance_history",
        instanceId: "inst-1",
        history: [
          {
            timestamp: 1,
            message: {
              type: "user",
              instanceId: "inst-1",
              text: "from websocket",
            },
          },
        ],
        replayMode: "full",
        latestSequence: 3,
        replayEpoch: 10,
      });
      result.current.hydrateFromHistorySnapshot("inst-1", [
        {
          timestamp: 1,
          message: {
            type: "user",
            instanceId: "inst-1",
            text: "from rest",
          },
        },
      ]);
    });

    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "from websocket" }),
    ]);
  });

  it("applies events missed while disconnected from a reconnect delta replay", () => {
    const { result } = renderHook(() => useInstanceMessages());

    act(() => {
      result.current.setInstanceId("inst-resume");
      result.current.handleMessage("inst-resume", {
        type: "instance_history",
        instanceId: "inst-resume",
        history: [
          {
            timestamp: 1,
            message: { type: "user", instanceId: "inst-resume", text: "before sleep" },
          },
        ],
        replayMode: "full",
        latestSequence: 2,
        replayEpoch: 7,
      });
    });

    // Reconnect with cursor 2: the server acks with the delta header carrying
    // the latest sequence, then streams the missed events.
    act(() => {
      result.current.handleMessage("inst-resume", {
        type: "instance_history",
        instanceId: "inst-resume",
        history: [],
        replayMode: "delta",
        latestSequence: 3,
        replayEpoch: 7,
      });
      result.current.handleMessage("inst-resume", {
        type: "output",
        instanceId: "inst-resume",
        text: "written while away",
        isWaiting: true,
        eventSequence: 3,
      } as OutputMessage);
    });

    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "before sleep" }),
      expect.objectContaining({ kind: "assistant", text: "written while away" }),
    ]);
    expect(result.current.rawHistory).toHaveLength(2);
  });

  it("ignores delta replay acks until a full history baseline exists", () => {
    const { result } = renderHook(() => useInstanceMessages());

    act(() => {
      result.current.setInstanceId("inst-delta");
      result.current.handleMessage("inst-delta", {
        type: "instance_history",
        instanceId: "inst-delta",
        history: [],
        replayMode: "delta",
        latestSequence: 4,
        replayEpoch: 99,
      });
    });

    expect(result.current.hasLoadedHistory).toBe(false);
    expect(result.current.hasSyncedHistory).toBe(false);
    expect(result.current.items).toEqual([]);

    act(() => {
      result.current.hydrateFromHistorySnapshot("inst-delta", [
        {
          timestamp: 1,
          message: {
            type: "user",
            instanceId: "inst-delta",
            text: "from rest fallback",
          },
        },
      ]);
    });

    expect(result.current.hasLoadedHistory).toBe(true);
    expect(result.current.hasSyncedHistory).toBe(true);
    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "from rest fallback" }),
    ]);
  });

  it("allows REST fallback to refresh a stale cached chat after switching back", () => {
    const { result } = renderHook(() => useInstanceMessages());

    act(() => {
      result.current.setInstanceId("inst-stale");
      result.current.handleMessage("inst-stale", {
        type: "instance_history",
        instanceId: "inst-stale",
        history: [
          {
            timestamp: 1,
            message: {
              type: "user",
              instanceId: "inst-stale",
              text: "stale snapshot",
            },
          },
        ],
        replayMode: "full",
        latestSequence: 3,
        replayEpoch: 10,
      });
    });

    act(() => {
      result.current.setInstanceId("inst-other");
    });

    act(() => {
      result.current.setInstanceId("inst-stale");
    });

    expect(result.current.hasLoadedHistory).toBe(true);
    expect(result.current.hasSyncedHistory).toBe(false);
    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "stale snapshot" }),
    ]);

    act(() => {
      result.current.hydrateFromHistorySnapshot("inst-stale", [
        {
          timestamp: 1,
          message: {
            type: "user",
            instanceId: "inst-stale",
            text: "fresh snapshot",
          },
        },
      ]);
    });

    expect(result.current.hasSyncedHistory).toBe(true);
    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "user", text: "fresh snapshot" }),
    ]);
  });

  it("does not leak another chat's replay cursor during an instance switch", () => {
    const { result } = renderHook(() => useInstanceMessages());

    act(() => {
      result.current.setInstanceId("inst-a");
      result.current.handleMessage("inst-a", {
        type: "instance_history",
        instanceId: "inst-a",
        history: [
          {
            timestamp: 1,
            message: {
              type: "user",
              instanceId: "inst-a",
              text: "chat a",
            },
          },
        ],
        replayMode: "full",
        latestSequence: 7,
        replayEpoch: 123,
      });
    });

    act(() => {
      result.current.setInstanceId("inst-b");
    });

    expect(result.current.getReplayCursor("inst-b")).toBeUndefined();
  });
});

describe("tool result pairing", () => {
  const read = (id: string): ActivityMessage => ({
    type: "activity",
    activity: "tool_use",
    tool: "Read",
    toolUseId: id,
    description: "Reading file",
    input: { file_path: `/${id}.ts` },
  });
  const result = (id: string): ActivityMessage => ({
    type: "activity",
    activity: "tool_result",
    toolUseId: id,
    description: "Tool completed",
    detail: `contents of ${id}`,
  });
  const messages = [read("a"), read("b"), result("b"), result("a")];
  function assertPairs(items: ReturnType<typeof replayHistoryToItems>) {
    const activities = items.flatMap((item) =>
      item.kind === "activity-group" ? item.activities : [],
    );
    expect(
      activities
        .filter((a) => a.activity === "tool_use")
        .map((a) => [a.toolUseId, a.mergedResultDetail]),
    ).toEqual([
      ["a", "contents of a"],
      ["b", "contents of b"],
    ]);
  }
  it("pairs out-of-order parallel reads during replay", () => {
    assertPairs(replayHistoryToItems(messages.map((message) => ({ timestamp: 1, message }))));
  });
  it("pairs out-of-order parallel reads in live updates", () => {
    const hook = renderHook(() => useInstanceMessages());
    act(() => hook.result.current.setInstanceId("test"));
    act(() =>
      messages.forEach((message) =>
        hook.result.current.handleMessage("test", { ...message, instanceId: "test" }),
      ),
    );
    assertPairs(hook.result.current.items);
  });
  it("finds the call across intervening activity groups", () => {
    const history: HistoryEntry[] = [
      { timestamp: 1, message: read("a") },
      {
        timestamp: 2,
        message: { type: "activity", activity: "thinking", description: "Thinking", detail: "hmm" },
      },
      { timestamp: 3, message: read("b") },
      { timestamp: 4, message: result("a") },
      { timestamp: 5, message: result("b") },
    ];
    assertPairs(replayHistoryToItems(history));
  });
  it("does not attach an unknown result to the latest read", () => {
    const items = replayHistoryToItems(
      [read("a"), result("unknown")].map((message) => ({ timestamp: 1, message })),
    );
    const group = items.find((item) => item.kind === "activity-group");
    expect(
      group?.kind === "activity-group" && group.activities[0].mergedResultDetail,
    ).toBeUndefined();
  });
  it("never overwrites already paired legacy results", () => {
    const legacy = [read("a"), read("b"), result("a"), result("b")].map(
      ({ toolUseId: _id, ...message }) => ({ timestamp: 1, message }),
    );
    const items = replayHistoryToItems(legacy);
    const activities = items.flatMap((item) =>
      item.kind === "activity-group" ? item.activities : [],
    );
    expect(activities.map((a) => a.mergedResultDetail)).toEqual(["contents of a", "contents of b"]);
  });
});

// ---------------------------------------------------------------------------
// Delegated agents: attribution routing, agent_update, agent notes
// ---------------------------------------------------------------------------

describe("delegated agent routing", () => {
  const output = (text: string, agentId?: string, seq?: number): OutputMessage => ({
    type: "output",
    instanceId: "inst-a",
    text,
    isWaiting: false,
    agentId,
    eventSequence: seq,
  });
  const agentTool = (toolUseId: string, agentId: string): ActivityMessage => ({
    type: "activity",
    instanceId: "inst-a",
    activity: "tool_use",
    tool: "Read",
    toolUseId,
    description: "Reading file",
    input: { file_path: `/${toolUseId}.ts` },
    agentId,
  });
  const agentResult = (toolUseId: string, agentId: string): ActivityMessage => ({
    type: "activity",
    instanceId: "inst-a",
    activity: "tool_result",
    toolUseId,
    description: "Tool completed",
    detail: `contents of ${toolUseId}`,
    agentId,
  });

  it("never lets attributed messages enter items (live)", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-agents-1"));
    act(() => {
      result.current.handleMessage("inst-agents-1", {
        ...output("orchestrator says", undefined, 1),
        instanceId: "inst-agents-1",
      });
      result.current.handleMessage("inst-agents-1", {
        ...output("child says", "agent-1", 2),
        instanceId: "inst-agents-1",
      });
      result.current.handleMessage("inst-agents-1", {
        ...agentTool("t1", "agent-1"),
        instanceId: "inst-agents-1",
      });
      result.current.handleMessage("inst-agents-1", {
        ...agentResult("t1", "agent-1"),
        instanceId: "inst-agents-1",
      });
      result.current.handleMessage("inst-agents-1", {
        type: "user",
        instanceId: "inst-agents-1",
        text: "child assignment",
        agentId: "agent-1",
      } as UserMessage);
    });
    expect(result.current.items).toEqual([
      expect.objectContaining({ kind: "assistant", text: "orchestrator says" }),
    ]);
    const nested = result.current.agentItems["agent-1"];
    expect(nested.map((i) => i.kind)).toEqual(["assistant", "activity-group", "user"]);
    const group = nested[1];
    expect(group.kind === "activity-group" && group.activities[0].mergedResultDetail).toBe(
      "contents of t1",
    );
  });

  it("never lets attributed messages enter items (replay) and keeps agents separate", () => {
    const history: HistoryEntry[] = [
      { timestamp: 1, message: { type: "user", instanceId: "i", text: "go" } },
      { timestamp: 2, message: output("A1 ", "agent-a") },
      { timestamp: 3, message: output("B1 ", "agent-b") },
      { timestamp: 4, message: output("main ") },
      { timestamp: 5, message: output("A2", "agent-a") },
      { timestamp: 6, message: output("B2", "agent-b") },
      { timestamp: 7, message: { ...output("main2"), isWaiting: true } },
    ];
    const { items, agentItems } = replayHistory(history);
    expect(items).toEqual([
      expect.objectContaining({ kind: "user", text: "go" }),
      expect.objectContaining({ kind: "assistant", text: "main main2" }),
    ]);
    expect(agentItems["agent-a"]).toEqual([
      expect.objectContaining({ kind: "assistant", text: "A1 A2" }),
    ]);
    expect(agentItems["agent-b"]).toEqual([
      expect.objectContaining({ kind: "assistant", text: "B1 B2" }),
    ]);
  });

  it("keeps interleaved live output for two agents in separate nested streams", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-agents-3"));
    act(() => {
      result.current.handleMessage("inst-agents-3", {
        ...output("A1 ", "agent-a", 1),
        instanceId: "inst-agents-3",
      });
      result.current.handleMessage("inst-agents-3", {
        ...output("B1 ", "agent-b", 2),
        instanceId: "inst-agents-3",
      });
      result.current.handleMessage("inst-agents-3", {
        ...output("A2", "agent-a", 3),
        instanceId: "inst-agents-3",
      });
      result.current.handleMessage("inst-agents-3", {
        ...output("B2", "agent-b", 4),
        instanceId: "inst-agents-3",
      });
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.agentItems["agent-a"]).toEqual([
      expect.objectContaining({ kind: "assistant", text: "A1 A2" }),
    ]);
    expect(result.current.agentItems["agent-b"]).toEqual([
      expect.objectContaining({ kind: "assistant", text: "B1 B2" }),
    ]);
    expect(result.current.isProcessing).toBe(false);
  });

  it("sparse-merges agent_update and leaves unknown fields unknown", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-agents-4"));
    act(() => {
      result.current.handleMessage("inst-agents-4", {
        type: "agent_update",
        instanceId: "inst-agents-4",
        agent: { agentId: "agent-1", name: "explorer", status: "running" },
      });
      result.current.handleMessage("inst-agents-4", {
        type: "agent_update",
        instanceId: "inst-agents-4",
        agent: { agentId: "agent-1", status: "completed", result: "ok" },
      });
    });
    const agent = result.current.agents["agent-1"];
    expect(agent).toEqual({
      agentId: "agent-1",
      name: "explorer",
      status: "completed",
      result: "ok",
    });
    expect("model" in agent).toBe(false);
    expect(agent.model).toBeUndefined();
  });

  it("inserts exactly one agent-card for an unanchored agent, never for an anchored one", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-agents-5"));
    act(() => {
      // Anchored: the delegation tool_use precedes the update.
      result.current.handleMessage("inst-agents-5", {
        type: "activity",
        instanceId: "inst-agents-5",
        activity: "tool_use",
        tool: "Agent",
        toolUseId: "tu-1",
        description: "Spawning agent",
      });
      result.current.handleMessage("inst-agents-5", {
        type: "agent_update",
        instanceId: "inst-agents-5",
        agent: { agentId: "tu-1", originToolUseId: "tu-1", status: "running" },
      });
      // Unanchored: no origin known.
      result.current.handleMessage("inst-agents-5", {
        type: "agent_update",
        instanceId: "inst-agents-5",
        agent: { agentId: "thr-2", status: "running" },
      });
      result.current.handleMessage("inst-agents-5", {
        type: "agent_update",
        instanceId: "inst-agents-5",
        agent: { agentId: "thr-2", status: "completed" },
      });
    });
    const cards = result.current.items.filter((i) => i.kind === "agent-card");
    expect(cards).toEqual([expect.objectContaining({ kind: "agent-card", agentId: "thr-2" })]);
    const anchors = buildAgentAnchorIndex(result.current.items, result.current.agents);
    expect([...anchors.entries()]).toEqual([["tu-1", "tu-1"]]);
  });

  it("renders author.kind === 'agent' as an agent-note, never a user bubble", () => {
    const history: HistoryEntry[] = [
      {
        timestamp: 1,
        message: {
          type: "user",
          instanceId: "i",
          text: "Freeze starts Friday",
          author: { kind: "agent", name: "release-manager", agentId: "peer-1" },
        },
      },
    ];
    expect(replayHistoryToItems(history)).toEqual([
      {
        kind: "agent-note",
        text: "Freeze starts Friday",
        name: "release-manager",
        agentId: "peer-1",
        timestamp: 1,
      },
    ]);

    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-agents-6"));
    act(() => {
      result.current.handleMessage("inst-agents-6", {
        type: "user",
        instanceId: "inst-agents-6",
        text: "live note",
        author: { kind: "agent", name: "peer" },
      } as UserMessage);
    });
    expect(result.current.items.map((i) => i.kind)).toEqual(["agent-note"]);
    expect(result.current.items.some((i) => i.kind === "user")).toBe(false);
  });

  it("never gives a nested agent a main-stream card (replay)", () => {
    const history: HistoryEntry[] = [
      { timestamp: 1, message: { type: "user", instanceId: "i", text: "go" } },
      {
        timestamp: 2,
        message: {
          type: "activity",
          instanceId: "i",
          activity: "tool_use",
          tool: "Agent",
          toolUseId: "tu-lead",
          description: "Spawning agent",
        },
      },
      {
        timestamp: 3,
        message: {
          type: "agent_update",
          agent: { agentId: "tu-lead", originToolUseId: "tu-lead", status: "running" },
        },
      },
      // The lead delegates again: its tool_use is attributed to the lead's
      // transcript, and the grandchild's update names the lead as parent.
      {
        timestamp: 4,
        message: {
          type: "activity",
          instanceId: "i",
          activity: "tool_use",
          tool: "Agent",
          toolUseId: "tu-grandchild",
          description: "Spawning agent",
          agentId: "tu-lead",
        },
      },
      {
        timestamp: 5,
        message: {
          type: "agent_update",
          agent: {
            agentId: "tu-grandchild",
            originToolUseId: "tu-grandchild",
            parentAgentId: "tu-lead",
            status: "running",
          },
        },
      },
      // A second grandchild with no declared parent, but whose origin lives
      // inside the lead's transcript — still nested.
      {
        timestamp: 6,
        message: {
          type: "activity",
          instanceId: "i",
          activity: "tool_use",
          tool: "Agent",
          toolUseId: "tu-grandchild-2",
          description: "Spawning agent",
          agentId: "tu-lead",
        },
      },
      {
        timestamp: 7,
        message: {
          type: "agent_update",
          agent: { agentId: "tu-grandchild-2", originToolUseId: "tu-grandchild-2" },
        },
      },
    ];
    const { items, agents, agentItems } = replayHistory(history);
    expect(items.filter((i) => i.kind === "agent-card")).toEqual([]);
    expect(Object.keys(agents).sort()).toEqual(["tu-grandchild", "tu-grandchild-2", "tu-lead"]);
    // Both grandchild origins are anchorable inside the lead's transcript.
    const nested = buildAgentAnchorIndex(agentItems["tu-lead"], agents);
    expect([...nested.entries()].sort()).toEqual([
      ["tu-grandchild", "tu-grandchild"],
      ["tu-grandchild-2", "tu-grandchild-2"],
    ]);
  });

  it("never gives a nested agent a main-stream card (live)", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => result.current.setInstanceId("inst-agents-nested"));
    act(() => {
      result.current.handleMessage("inst-agents-nested", {
        ...agentTool("tu-grandchild", "tu-lead"),
        tool: "Agent",
        instanceId: "inst-agents-nested",
      });
      result.current.handleMessage("inst-agents-nested", {
        type: "agent_update",
        instanceId: "inst-agents-nested",
        agent: { agentId: "tu-grandchild", originToolUseId: "tu-grandchild" },
      });
      result.current.handleMessage("inst-agents-nested", {
        type: "agent_update",
        instanceId: "inst-agents-nested",
        agent: { agentId: "thr-child", parentAgentId: "thr-parent", status: "running" },
      });
      // Control: a top-level agent with an unknown origin still gets its card.
      result.current.handleMessage("inst-agents-nested", {
        type: "agent_update",
        instanceId: "inst-agents-nested",
        agent: { agentId: "thr-top", status: "running" },
      });
    });
    expect(result.current.items.filter((i) => i.kind === "agent-card")).toEqual([
      expect.objectContaining({ kind: "agent-card", agentId: "thr-top" }),
    ]);
    expect(Object.keys(result.current.agents).sort()).toEqual([
      "thr-child",
      "thr-top",
      "tu-grandchild",
    ]);
  });

  it("flushes the in-flight response on a clean exit during replay", () => {
    const history: HistoryEntry[] = [
      { timestamp: 1, message: { type: "user", instanceId: "i", text: "first" } },
      { timestamp: 2, message: output("interrupted answer") },
      { timestamp: 3, message: { type: "exit", instanceId: "i", code: 0 } },
      { timestamp: 4, message: { type: "user", instanceId: "i", text: "second" } },
      { timestamp: 5, message: { ...output("fresh answer"), isWaiting: true } },
    ];
    expect(replayHistoryToItems(history)).toEqual([
      expect.objectContaining({ kind: "user", text: "first" }),
      expect.objectContaining({ kind: "assistant", text: "interrupted answer" }),
      expect.objectContaining({ kind: "user", text: "second" }),
      expect.objectContaining({ kind: "assistant", text: "fresh answer" }),
    ]);

    // Without an intervening user turn the two responses must still be
    // distinct items, not one glued message.
    const glued: HistoryEntry[] = [
      { timestamp: 1, message: output("before ") },
      { timestamp: 2, message: { type: "exit", instanceId: "i", code: 0 } },
      { timestamp: 3, message: { ...output("after"), isWaiting: true } },
    ];
    expect(replayHistoryToItems(glued).map((i) => i.kind === "assistant" && i.text)).toEqual([
      "before ",
      "after",
    ]);
  });

  it("mirrors agent attribution into rawHistory", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => {
      result.current.setInstanceId("inst-raw2");
      result.current.handleMessage("inst-raw2", {
        type: "instance_history",
        instanceId: "inst-raw2",
        history: [],
        replayMode: "full",
        latestSequence: 0,
        replayEpoch: 1,
      });
      result.current.handleMessage("inst-raw2", {
        type: "output",
        instanceId: "inst-raw2",
        text: "child",
        isWaiting: false,
        agentId: "agent-1",
      });
      result.current.handleMessage("inst-raw2", {
        type: "agent_update",
        instanceId: "inst-raw2",
        agent: { agentId: "agent-1", status: "running" },
      });
    });
    const messages = result.current.rawHistory?.map((e) => e.message) ?? [];
    expect(messages[0]).toEqual(expect.objectContaining({ type: "output", agentId: "agent-1" }));
    expect(messages[1]).toEqual(
      expect.objectContaining({
        type: "agent_update",
        agent: { agentId: "agent-1", status: "running" },
      }),
    );
  });
});

describe("useInstanceMessages file_stats", () => {
  it("merges debounced diff stats without marking the chat processing", () => {
    const { result } = renderHook(() => useInstanceMessages());
    act(() => {
      result.current.setInstanceId("instance-1");
      result.current.handleMessage("instance-1", {
        type: "instance_history",
        instanceId: "instance-1",
        history: [],
        replayMode: "full",
        latestSequence: 0,
      });
    });
    act(() => {
      result.current.handleMessage("instance-1", {
        type: "file_stats",
        instanceId: "instance-1",
        eventSequence: 3,
        files: [{ path: "/repo/a.ts", editCount: 2, type: "edited", additions: 4, deletions: 1 }],
      });
    });
    expect(result.current.isProcessing).toBe(false);
    expect(result.current.currentFiles).toEqual([
      { path: "/repo/a.ts", editCount: 2, type: "edited", additions: 4, deletions: 1 },
    ]);
  });
});
