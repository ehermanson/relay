/**
 * Delegated-agent state made available to the tool stream so `ActivityGroup`
 * can render an `AgentCard` in place of the delegation `tool_use` it anchors
 * to, without threading five props through `ToolContainer`.
 *
 * Provided by `MessageList` (and by `AgentDetail` for nested transcripts, with
 * the anchor index recomputed against the child's own items).
 */

import { createContext, useContext, type ReactNode } from "react";
import type { AgentInfo, ProviderKind } from "@shared/types";
import type { ChatItem } from "@/lib/chat-types";

export interface AgentCardsContextValue {
  agents: Record<string, AgentInfo>;
  agentItems: Record<string, ChatItem[]>;
  /** `toolUseId → agentId` for agents anchored to a visible delegation tool_use in this stream. */
  anchoredAgents: ReadonlyMap<string, string>;
  instanceId?: string;
  provider?: ProviderKind;
  /** Relay agent key that owns the chat's pending permission request, if any. */
  pendingAgentId?: string;
}

const AgentCardsContext = createContext<AgentCardsContextValue | null>(null);

export function AgentCardsProvider({
  value,
  children,
}: {
  value: AgentCardsContextValue;
  children: ReactNode;
}) {
  return <AgentCardsContext.Provider value={value}>{children}</AgentCardsContext.Provider>;
}

/** Null outside a provider (e.g. surfaces that never show agent cards). */
export function useAgentCards(): AgentCardsContextValue | null {
  return useContext(AgentCardsContext);
}
