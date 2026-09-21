import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentInfo, AgentLifecycle, HistoryEntry } from "@shared/types";
import type { ChatItem } from "@/lib/chat-types";
import { fetchAgentHistory } from "@/lib/api";
import { isAgentTerminal } from "@/lib/agents";
import { replayHistory } from "@/hooks/use-instance-messages";
import { agentModelQueryKey } from "@/hooks/use-agent-model";

export interface AgentHistoryResult {
  /** The agent's own conversation, with the same accumulation rules as the live stream. */
  items: ChatItem[];
  /** Agents declared inside the fetched transcript (grandchildren), keyed by Relay agent key. */
  agents: Record<string, AgentInfo>;
}

/**
 * Turn a fetched child transcript into `ChatItem[]` with the same accumulation
 * rules as the live stream. The server attributes the child's own entries
 * to that agent while preserving nested attribution, and usually leads with
 * the child's own `agent_update`, so `replayHistory` files the real transcript
 * under `agentItems[agentId]` and leaves only placeholder cards in `items`.
 * Prefer the attributed stream; fall back to the unattributed main stream only
 * when nothing was attributed (older servers deliver the transcript bare).
 *
 * `agent_update`s found inside the transcript (the child's own and any
 * grandchildren it spawned) are folded into `agents` so nested delegation can
 * render inside the detail view.
 */
export function agentHistoryToItems(history: HistoryEntry[], agentId: string): AgentHistoryResult {
  const result = replayHistory(history);
  const attributed = result.agentItems[agentId];
  if (attributed && attributed.length > 0) return { items: attributed, agents: result.agents };
  // Allow a legacy provider-native key, but never substitute a known grandchild.
  const other = Object.entries(result.agentItems).find(
    ([id, items]) => !result.agents[id]?.parentAgentId && items.length > 0,
  )?.[1];
  if (other) return { items: other, agents: result.agents };
  // Nothing attributed: the whole transcript is the child's, but placeholder
  // cards for the child itself would be self-referential — drop those.
  const items = result.items.filter(
    (item) => item.kind !== "agent-card" || item.agentId !== agentId,
  );
  return { items, agents: result.agents };
}

interface UseAgentHistoryOptions {
  /** Only fetch while the card/sidecar detail is expanded — never on mount. */
  enabled: boolean;
  /** Live nested transcript from the reducer (may start partway through a run). */
  liveItems?: ChatItem[];
  /** Agent lifecycle — a terminal agent's transcript is final, so it is cached indefinitely. */
  status?: AgentLifecycle;
  /**
   * Completion revision — changes each time the agent finishes (its `endedAt`).
   * A resumed agent (completed → running → completed) returns to the terminal
   * query key; without a revision its first completion's `Infinity`-cached
   * snapshot would be served for the second, so the revision keys each
   * completion's transcript separately.
   */
  revision?: string | number;
}

const EMPTY_AGENTS: Record<string, AgentInfo> = {};

/**
 * On-demand detailed history for one delegated agent. Fetches only when
 * `enabled`; prefers fetched prose unless live prose contains and extends it.
 * The two streams are never concatenated, so nothing is duplicated. A 404 (`null` data)
 * means the provider has no detailed transcript for this agent.
 */
export function useAgentHistory(
  instanceId: string | undefined,
  agentId: string,
  { enabled, liveItems, status, revision }: UseAgentHistoryOptions,
) {
  const shouldFetch = enabled && !!instanceId;
  const queryClient = useQueryClient();
  const terminal = isAgentTerminal(status);
  const query = useQuery({
    // The terminal discriminator forces a fresh fetch when an agent finishes:
    // the snapshot taken while it was running (often partial, sometimes a 404
    // because the child transcript hadn't been written yet) must not be frozen
    // by the `Infinity` staleTime below. The completion `revision` distinguishes
    // successive completions of a resumed agent, so the second completion isn't
    // served the first's indefinitely-cached transcript.
    queryKey: ["agentHistory", instanceId, agentId, terminal ? `final:${revision ?? ""}` : "live"],
    queryFn: () => fetchAgentHistory(instanceId!, agentId),
    enabled: shouldFetch,
    // Active agents keep a short window so re-expanding picks up new turns; a
    // finished agent's transcript can't change, so never refetch it.
    staleTime: terminal ? Infinity : 15_000,
    refetchOnWindowFocus: !terminal,
    retry: false,
  });

  const fetched = useMemo<AgentHistoryResult | null>(() => {
    if (!query.data) return null;
    return agentHistoryToItems(query.data, agentId);
  }, [query.data, agentId]);

  // Share model metadata discovered by expansion with every collapsed surface.
  const fetchedModel = fetched?.agents[agentId]?.model;
  useEffect(() => {
    if (!fetchedModel) return;
    queryClient.setQueryData(
      agentModelQueryKey(instanceId, { agentId, status, endedAt: revision }),
      fetchedModel,
    );
  }, [queryClient, instanceId, agentId, status, revision, fetchedModel]);

  const items = useMemo<ChatItem[]>(() => {
    const fetchedItems = fetched?.items ?? [];
    const live = liveItems ?? [];
    // Live prose can be only the tail received after joining a running chat.
    // Prefer the canonical transcript unless live prose contains its entire
    // prefix and extends it (the file can lag the stream). Compare text across
    // message boundaries because live and replay group assistant text differently.
    const prose = (items: ChatItem[]) =>
      items
        .flatMap((item) => (item.kind === "assistant" ? [item.text] : []))
        .join("")
        .replace(/\s+/g, "");
    const liveProse = prose(live);
    const fetchedProse = prose(fetchedItems);
    if (fetchedProse) {
      if (
        liveProse.startsWith(fetchedProse) &&
        (liveProse.length > fetchedProse.length || (!terminal && live.length > fetchedItems.length))
      ) {
        return live;
      }
      return fetchedItems;
    }
    if (liveProse) return live;
    if (fetchedItems.length > live.length) return fetchedItems;
    return live.length > 0 ? live : fetchedItems;
  }, [liveItems, fetched, terminal]);

  return {
    items,
    /** Agents declared inside the fetched transcript (grandchildren), empty until fetched. */
    fetchedAgents: fetched?.agents ?? EMPTY_AGENTS,
    isLoading: shouldFetch && query.isPending,
    /** True when the server answered 404 — nothing to show beyond live state. */
    unavailable: shouldFetch && query.data === null,
    error: query.error,
  };
}
